import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../src/errors.ts";
import type { CloudKitRecord } from "../src/icloud/cloudkit.ts";
import { decodeDocument } from "../src/reminders/crdt.ts";
import {
  buildCreateReminder,
  buildUpdateReminder,
  buildLifecycleReminder,
  CreateReminderInput,
  matchesCreatedReminder,
} from "../src/reminders/writes.ts";

const owner = "owner-test";
const baseInput = {
  listId: "List/LIST-A",
  idempotencyKey: "11111111-2222-4333-8444-555555555555",
  title: "Café 🧭",
  notes: "Remember the 🫖\n",
  priority: 5 as const,
  flagged: true,
  dueDate: "2026-06-01T09:30:00+01:00",
  timeZone: "Europe/London",
  allDay: true,
};

function currentRecord(): CloudKitRecord {
  const create = buildCreateReminder(baseInput, 1_800_000_000_000);
  const fields = {
    ...create.fields,
    ResolutionTokenMap: create.fields.ResolutionTokenMap,
    AlarmIDs: { type: "STRING_LIST", value: [] },
    RecurrenceRuleIDs: { type: "STRING_LIST", value: [] },
    CustomFutureField: { type: "STRING", value: "keep this" },
  };
  return {
    recordName: create.recordName,
    recordType: "Reminder",
    fields,
    recordChangeTag: "tag-current",
    zoneID: {
      zoneName: "Reminders",
      zoneType: "REGULAR_CUSTOM_ZONE",
      ownerRecordName: owner,
    },
    raw: {},
  };
}

function parsedMap(record: CloudKitRecord) {
  const wrapper = record.fields.ResolutionTokenMap as { value: string };
  return JSON.parse(wrapper.value) as { map: Record<string, unknown> };
}

test("latest native token update preserves replica lineage, increments counters and rejects overflow", () => {
  const current = currentRecord();
  const before = parsedMap(current).map as Record<string, any>;
  before.titleDocument.counter = 7;
  before.titleDocument.modificationTime = 2_000_000_000;
  current.fields.ResolutionTokenMap = {
    type: "STRING",
    value: JSON.stringify({ map: before }),
  };
  const input = {
    listId: baseInput.listId,
    reminderId: current.recordName,
    recordChangeTag: current.recordChangeTag!,
    changes: { title: "Updated" },
  };
  const write = buildUpdateReminder(input, current, owner, 1_800_000_100_000);
  const after = JSON.parse(write.fields.ResolutionTokenMap.value as string).map;
  assert.equal(after.titleDocument.counter, 8);
  assert.equal(after.titleDocument.replicaID, before.titleDocument.replicaID);
  assert.equal(
    after.titleDocument.modificationTime,
    before.titleDocument.modificationTime,
  );
  assert.deepEqual(after.notesDocument, before.notesDocument);
  before.titleDocument.counter = Number.MAX_SAFE_INTEGER;
  current.fields.ResolutionTokenMap = {
    type: "STRING",
    value: JSON.stringify({ map: before }),
  };
  assert.throws(
    () => buildUpdateReminder(input, current, owner, 1_800_000_100_000),
    (e: any) => e.code === "PROTOCOL_CHANGED",
  );
});
test("native all-day date without TimeZone uses a midnight UTC calendar date; early-alert changes stay guarded", () => {
  const current = currentRecord();
  current.fields.TimeZone = { type: "STRING", value: null };
  current.fields.DueDate = {
    type: "TIMESTAMP",
    value: Date.parse("2026-06-01T00:00:00Z"),
  };
  const target = {
    listId: baseInput.listId,
    reminderId: current.recordName,
    recordChangeTag: current.recordChangeTag!,
  };
  const write = buildUpdateReminder(
    { ...target, changes: { dueDate: "2026-06-02T00:00:00Z" } },
    current,
    owner,
    1_800_000_100_000,
  );
  assert.equal(write.fields.DueDate.value, Date.parse("2026-06-02T00:00:00Z"));
  assert.equal(write.fields.TimeZone, undefined);
  assert.throws(() =>
    buildUpdateReminder(
      { ...target, changes: { dueDate: "2026-06-02T12:00:00Z" } },
      current,
      owner,
    ),
  );
  current.fields.DueDateDeltaAlertsData = {
    type: "STRING",
    value: "synthetic-metadata",
  };
  assert.throws(
    () =>
      buildUpdateReminder(
        { ...target, changes: { dueDate: "2026-06-02T00:00:00Z" } },
        current,
        owner,
      ),
    (e: any) => e.code === "UNSUPPORTED_FEATURE",
  );
});

test("create builder writes pinned fields, Unicode CRDT documents, parent, and resolution tokens", () => {
  const write = buildCreateReminder(baseInput, 1_800_000_000_000);
  assert.equal(
    write.recordName,
    `Reminder/${baseInput.idempotencyKey.toUpperCase()}`,
  );
  assert.equal(write.recordType, "Reminder");
  assert.deepEqual(write.parent, { recordName: baseInput.listId });
  assert.equal(write.fields.List.type, "REFERENCE");
  assert.deepEqual(write.fields.List.value, {
    recordName: baseInput.listId,
    action: "VALIDATE",
  });
  assert.equal(write.fields.Completed.value, 0);
  assert.deepEqual(write.fields.CompletionDate, {
    type: "TIMESTAMP",
    value: null,
  });
  assert.equal(write.fields.Deleted.value, 0);
  assert.equal(write.fields.Imported.value, 0);
  assert.equal(write.fields.AllDay.value, 1);
  assert.equal(write.fields.Priority.value, 5);
  assert.equal(write.fields.DueDate.value, Date.parse(baseInput.dueDate));
  assert.equal(
    decodeDocument(write.fields.TitleDocument.value as string).text,
    baseInput.title,
  );
  assert.equal(
    decodeDocument(write.fields.NotesDocument.value as string).text,
    baseInput.notes,
  );
  const tokens = parsedMap({ ...currentRecord(), fields: write.fields }).map;
  assert.deepEqual(
    Object.keys(tokens).sort(),
    [
      "allDay",
      "titleDocument",
      "notesDocument",
      "parentReminder",
      "priority",
      "icsDisplayOrder",
      "creationDate",
      "list",
      "flagged",
      "completed",
      "completionDate",
      "lastModifiedDate",
      "recurrenceRuleIDs",
      "dueDate",
      "timeZone",
    ].sort(),
  );
  for (const token of Object.values(tokens)) {
    assert.deepEqual(Object.keys(token as object).sort(), [
      "counter",
      "modificationTime",
      "replicaID",
    ]);
    assert.equal((token as { counter: number }).counter, 1);
    assert.match(
      (token as { replicaID: string }).replicaID,
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
    );
  }
  assert.equal(matchesCreatedReminder(baseInput, currentRecord(), owner), true);
});

test("partial update emits only changed fields and keeps omitted resolution tokens and source content", () => {
  const current = currentRecord();
  const originalTokens = parsedMap(current).map;
  const write = buildUpdateReminder(
    {
      listId: baseInput.listId,
      reminderId: current.recordName,
      recordChangeTag: "tag-current",
      changes: { title: "New title 🪁" },
    },
    current,
    owner,
    1_800_000_100_000,
  );

  assert.deepEqual(
    Object.keys(write.fields).sort(),
    ["LastModifiedDate", "ResolutionTokenMap", "TitleDocument"].sort(),
  );
  assert.equal(
    decodeDocument(write.fields.TitleDocument.value as string).text,
    "New title 🪁",
  );
  assert.equal(write.fields.LastModifiedDate.value, 1_800_000_100_000);
  const newTokens = JSON.parse(
    write.fields.ResolutionTokenMap.value as string,
  ) as { map: Record<string, unknown> };
  assert.deepEqual(newTokens.map.notesDocument, originalTokens.notesDocument);
  assert.deepEqual(newTokens.map.priority, originalTokens.priority);
  assert.notDeepEqual(
    newTokens.map.titleDocument,
    originalTokens.titleDocument,
  );
  assert.equal(
    current.fields.CustomFutureField &&
      (current.fields.CustomFutureField as { value: string }).value,
    "keep this",
  );
  assert.equal(
    current.fields.NotesDocument &&
      (current.fields.NotesDocument as { value: string }).value,
    buildCreateReminder(baseInput, 1_800_000_000_000).fields.NotesDocument
      .value,
  );

  const clearDueDate = buildUpdateReminder(
    {
      listId: baseInput.listId,
      reminderId: current.recordName,
      recordChangeTag: "tag-current",
      changes: { dueDate: null },
    },
    current,
    owner,
    1_800_000_100_000,
  );
  assert.deepEqual(clearDueDate.fields.DueDate, {
    type: "TIMESTAMP",
    value: null,
  });
  assert.deepEqual(clearDueDate.fields.AllDay, { type: "INT64", value: 0 });
  assert.deepEqual(clearDueDate.fields.TimeZone, {
    type: "STRING",
    value: null,
  });

  // Apple's undated records may retain AllDay=1. A title-only edit must leave
  // that date state intact rather than refuse an otherwise safe patch.
  const undated = {
    ...current,
    fields: {
      ...current.fields,
      DueDate: { type: "TIMESTAMP", value: null },
      TimeZone: { type: "STRING", value: null },
    },
  };
  const titleOnly = buildUpdateReminder(
    {
      listId: baseInput.listId,
      reminderId: current.recordName,
      recordChangeTag: "tag-current",
      changes: { title: "Undated item renamed" },
    },
    undated,
    owner,
  );
  assert.equal(
    decodeDocument(titleOnly.fields.TitleDocument.value as string).text,
    "Undated item renamed",
  );
  assert.equal(Object.hasOwn(titleOnly.fields, "AllDay"), false);
  assert.equal(Object.hasOwn(titleOnly.fields, "DueDate"), false);
  assert.equal(Object.hasOwn(titleOnly.fields, "TimeZone"), false);
});

test("schemas and update builder reject invalid input, conflicts, malformed tokens, and unsupported linked changes", () => {
  assert.equal(
    CreateReminderInput.safeParse({
      ...baseInput,
      dueDate: "2026-02-30T10:00:00Z",
    }).success,
    false,
  );
  assert.equal(
    CreateReminderInput.safeParse({ ...baseInput, title: "bad\u0000title" })
      .success,
    false,
  );
  assert.equal(
    CreateReminderInput.safeParse({ ...baseInput, title: "\ud800" }).success,
    false,
  );
  assert.equal(
    CreateReminderInput.safeParse({ ...baseInput, extra: true }).success,
    false,
  );
  assert.equal(
    CreateReminderInput.safeParse({ ...baseInput, listId: "List/LIST/A" })
      .success,
    false,
  );

  const current = currentRecord();
  const update = {
    listId: baseInput.listId,
    reminderId: current.recordName,
    recordChangeTag: "tag-current",
    changes: { flagged: false },
  };
  const rejectsWithCode = (fn: () => unknown, code: string) =>
    assert.throws(
      fn,
      (error) => error instanceof AppError && error.code === code,
    );
  rejectsWithCode(
    () => buildUpdateReminder({ ...update, changes: {} }, current, owner),
    "VALIDATION_ERROR",
  );
  rejectsWithCode(
    () =>
      buildUpdateReminder(
        { ...update, recordChangeTag: "stale" },
        current,
        owner,
      ),
    "CONFLICT",
  );
  rejectsWithCode(
    () =>
      buildUpdateReminder({ ...update, listId: "List/OTHER" }, current, owner),
    "CONFLICT",
  );
  rejectsWithCode(
    () =>
      buildUpdateReminder(
        update,
        {
          ...current,
          zoneID: { zoneName: "Reminders", ownerRecordName: "foreign" },
        },
        owner,
      ),
    "FORBIDDEN",
  );
  const unknownCompletion = {
    ...current,
    fields: { ...current.fields, Completed: { type: "INT64", value: null } },
  };
  rejectsWithCode(
    () => buildUpdateReminder(update, unknownCompletion, owner),
    "CONFLICT",
  );
  assert.equal(
    matchesCreatedReminder(baseInput, unknownCompletion, owner),
    false,
  );

  const recurring = {
    ...current,
    fields: {
      ...current.fields,
      RecurrenceRuleIDs: {
        type: "STRING_LIST",
        value: ["RecurrenceRule/RULE-A"],
      },
    },
  };
  rejectsWithCode(
    () =>
      buildUpdateReminder(
        { ...update, changes: { dueDate: "2026-07-01T09:30:00+01:00" } },
        recurring,
        owner,
      ),
    "UNSUPPORTED_FEATURE",
  );

  const malformedTokens = {
    ...current,
    fields: {
      ...current.fields,
      ResolutionTokenMap: { type: "STRING", value: "{bad json" },
    },
  };
  rejectsWithCode(
    () => buildUpdateReminder(update, malformedTokens, owner),
    "PROTOCOL_CHANGED",
  );
  const tokenMap = parsedMap(current);
  const unknownTokenMapProperty = {
    ...current,
    fields: {
      ...current.fields,
      ResolutionTokenMap: {
        type: "STRING",
        value: JSON.stringify({ ...tokenMap, future: true }),
      },
    },
  };
  rejectsWithCode(
    () => buildUpdateReminder(update, unknownTokenMapProperty, owner),
    "PROTOCOL_CHANGED",
  );
});

test("completion, reopening and soft deletion preserve content/tokens and enforce exact state and version", () => {
  const current = currentRecord();
  const target = {
    listId: baseInput.listId,
    reminderId: current.recordName,
    recordChangeTag: "tag-current",
  };
  const now = 1_800_000_100_000;
  const completed = buildLifecycleReminder(
    "complete",
    target,
    current,
    owner,
    now,
  );
  assert.deepEqual(completed.fields.Completed, { type: "INT64", value: 1 });
  assert.deepEqual(completed.fields.CompletionDate, {
    type: "TIMESTAMP",
    value: now,
  });
  assert.deepEqual(Object.keys(completed.fields).sort(), [
    "Completed",
    "CompletionDate",
    "LastModifiedDate",
    "ResolutionTokenMap",
  ]);
  const before = parsedMap(current).map;
  const tokens = JSON.parse(
    completed.fields.ResolutionTokenMap.value as string,
  ).map;
  assert.deepEqual(tokens.titleDocument, before.titleDocument);
  assert.deepEqual(tokens.notesDocument, before.notesDocument);
  assert.notDeepEqual(tokens.completed, before.completed);
  const completedRecord = {
    ...current,
    fields: { ...current.fields, ...completed.fields },
  };
  const reopened = buildLifecycleReminder(
    "reopen",
    target,
    completedRecord,
    owner,
    now + 1000,
  );
  assert.deepEqual(reopened.fields.Completed, { type: "INT64", value: 0 });
  assert.deepEqual(reopened.fields.CompletionDate, {
    type: "TIMESTAMP",
    value: null,
  });
  const deleted = buildLifecycleReminder(
    "delete",
    target,
    completedRecord,
    owner,
    now + 2000,
  );
  assert.deepEqual(deleted.fields.Deleted, { type: "INT64", value: 1 });
  assert.deepEqual(Object.keys(deleted.fields).sort(), [
    "Deleted",
    "LastModifiedDate",
    "ResolutionTokenMap",
  ]);
  assert.deepEqual(
    JSON.parse(deleted.fields.ResolutionTokenMap.value as string).map.completed,
    tokens.completed,
  );
  const rejects = (
    action: "complete" | "reopen" | "delete",
    record: CloudKitRecord,
    code: string,
    tag = "tag-current",
  ) =>
    assert.throws(
      () =>
        buildLifecycleReminder(
          action,
          { ...target, recordChangeTag: tag },
          record,
          owner,
        ),
      (error) => error instanceof AppError && error.code === code,
    );
  rejects("complete", completedRecord, "CONFLICT");
  rejects("reopen", current, "CONFLICT");
  rejects("delete", current, "CONFLICT", "stale");
  rejects(
    "delete",
    {
      ...current,
      fields: { ...current.fields, Deleted: { type: "INT64", value: 1 } },
    },
    "CONFLICT",
  );
  rejects(
    "complete",
    {
      ...current,
      fields: {
        ...current.fields,
        RecurrenceRuleIDs: {
          type: "STRING_LIST",
          value: ["RecurrenceRule/RULE-A"],
        },
      },
    },
    "UNSUPPORTED_FEATURE",
  );
  rejects(
    "delete",
    {
      ...current,
      fields: {
        ...current.fields,
        ParentReminder: {
          type: "REFERENCE",
          value: { recordName: "Reminder/PARENT-A" },
        },
      },
    },
    "UNSUPPORTED_FEATURE",
  );
});
