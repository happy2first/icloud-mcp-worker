import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCreateReminder,
  createResolutionTokenMap,
} from "../src/reminders/writes.ts";
import {
  planRecurringCompletion,
  verifyOccurrence,
} from "../src/reminders/recurring-completion.ts";
import {
  dateComponents,
  dueDateNonce,
} from "../src/reminders/date-components.ts";
import { b64, utf8 } from "../src/crypto/bytes.ts";
import type { CloudKitRecord } from "../src/icloud/cloudkit.ts";
import { CloudKitRemindersClient } from "../src/icloud/cloudkit.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
const owner = "test-owner",
  now = Date.parse("2026-10-14T05:00:00Z");
const f = (value: unknown, type = "INT64") => ({ type, value });
function fixture() {
  const create = buildCreateReminder(
    {
      listId: "List/LIST",
      idempotencyKey: "11111111-2222-4333-8444-555555555555",
      title: "Recurring test",
      notes: "",
      priority: 0,
      flagged: false,
      allDay: false,
      dueDate: "2026-10-14T01:00:00Z",
      timeZone: "Asia/Shanghai",
    },
    now - 86400000,
  );
  const record = (
    name: string,
    type: string,
    fields: Record<string, unknown>,
  ): CloudKitRecord => ({
    recordName: name,
    recordType: type,
    fields,
    recordChangeTag: "old",
    zoneID: { zoneName: "Reminders", ownerRecordName: owner },
    raw: {},
  });
  const root = record(create.recordName, "Reminder", {
    ...create.fields,
    AlarmIDs: f(["A"], "STRING_LIST"),
    RecurrenceRuleIDs: f(["R"], "STRING_LIST"),
    AttachmentIDs: f([], "UNKNOWN_LIST"),
    HashtagIDs: f([], "UNKNOWN_LIST"),
  });
  const list = record("List/LIST", "List", {
    Name: f("Test", "STRING"),
    Deleted: f(0),
    IsGroup: f(0),
    ReminderIDs: f(JSON.stringify([root.recordName.slice(9)]), "STRING"),
    ResolutionTokenMap: f(
      createResolutionTokenMap(["reminderIDsMergeableOrdering"], now),
      "STRING",
    ),
  });
  const rule = record("RecurrenceRule/R", "RecurrenceRule", {
    Reminder: f({ recordName: root.recordName }, "REFERENCE"),
    Frequency: f(1),
    Interval: f(1),
    OccurrenceCount: f(0),
    FirstDayOfTheWeek: f(0),
    Imported: f(0),
    Deleted: f(0),
  });
  const alarm = record("Alarm/A", "Alarm", {
    AlarmUID: f("A", "STRING"),
    TriggerID: f("T", "STRING"),
    Reminder: f({ recordName: root.recordName }, "REFERENCE"),
    DueDateResolutionTokenAsNonce: f(
      dueDateNonce(create.fields.ResolutionTokenMap.value),
      "DOUBLE",
    ),
    Imported: f(0),
    Deleted: f(0),
  });
  const trigger = record("AlarmTrigger/T", "AlarmTrigger", {
    Type: f("Date", "STRING"),
    Alarm: f({ recordName: alarm.recordName }, "REFERENCE"),
    DateComponentsData: f(
      b64(
        utf8(
          JSON.stringify(
            dateComponents("2026-10-14T01:00:00Z", "Asia/Shanghai"),
          ),
        ),
      ),
      "BYTES",
    ),
    Imported: f(0),
    Deleted: f(0),
  });
  const input = {
    listId: list.recordName,
    reminderId: root.recordName,
    recordChangeTag: "old",
  };
  return { input, root, list, rule, alarm, trigger };
}
const plan = (x: ReturnType<typeof fixture>) =>
  planRecurringCompletion(
    x.input,
    x.root,
    x.list,
    x.rule,
    x.alarm,
    x.trigger,
    owner,
    now,
  );
test("CloudKit sends one atomic occurrence batch and reads it back without replay", async () => {
  const x = fixture(),
    p = plan(x),
    paths: string[] = [];
  const before = [x.root, x.list, x.rule, x.alarm, x.trigger];
  const records = p.operations
    .filter((o) => o.operationType !== "delete")
    .map((o) => ({
      ...o.record,
      fields: {
        ...before.find((r) => r.recordName === o.record.recordName)?.fields,
        ...o.record.fields,
      },
      recordChangeTag: "new",
      zoneID: x.root.zoneID,
    }));
  const http = new AppleHTTP(new CookieJar(), async (url, init) => {
    paths.push(new URL(String(url)).pathname);
    const body = JSON.parse(String(init?.body));
    if (paths.length === 1) {
      assert.equal(body.atomic, true);
      assert.equal(body.operations.length, 10);
      assert.deepEqual(body.operations, p.operations);
      return Response.json({ records });
    }
    assert.equal(paths.length, 2);
    return Response.json({ records });
  });
  const api = new CloudKitRemindersClient(http, {
    dsid: "123",
    clientId: "test",
    clientBuildNumber: "test",
    clientMasteringNumber: "test",
    cloudKitURL:
      "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
    remindersZoneOwner: owner,
  });
  const result = await api.modifyOccurrence(p.operations);
  verifyOccurrence(p, result, owner);
  assert.ok(paths[0].endsWith("/records/modify"));
  assert.ok(paths[1].endsWith("/records/lookup"));
});
test("completion keeps the recurring root open, creates exactly one past occurrence, and advances one week", () => {
  const x = fixture(),
    p = plan(x);
  assert.equal(p.operations.length, 10);
  const active = p.operations[0].record,
    history = p.operations[1].record;
  assert.equal(active.fields.Completed.value, 0);
  assert.equal(active.fields.CompletionDate.value, null);
  assert.equal(active.fields.DueDate.value, Date.parse("2026-10-21T01:00:00Z"));
  assert.equal(active.fields.RecurrenceRuleIDs, undefined);
  assert.equal(history.fields.Completed.value, 1);
  assert.equal(
    history.fields.DueDate.value,
    Date.parse("2026-10-14T01:00:00Z"),
  );
  assert.deepEqual(history.fields.RecurrenceRuleIDs.value, []);
  assert.equal(
    p.operations.filter(
      (o) => o.operationType === "create" && o.record.recordType === "Reminder",
    ).length,
    1,
  );
  assert.deepEqual(
    JSON.parse(p.operations[2].record.fields.ReminderIDs.value as string),
    [p.historyId.slice(9), x.root.recordName.slice(9)],
  );
  const before = [x.root, x.list, x.rule, x.alarm, x.trigger];
  const after = p.operations
    .filter((o) => o.operationType !== "delete")
    .map(
      (o) =>
        ({
          ...before.find((r) => r.recordName === o.record.recordName),
          ...o.record,
          fields: {
            ...before.find((r) => r.recordName === o.record.recordName)?.fields,
            ...o.record.fields,
          },
          recordChangeTag: "new",
          raw: {},
          zoneID: x.root.zoneID,
        }) as CloudKitRecord,
    );
  assert.equal(verifyOccurrence(p, after, owner).recordName, x.root.recordName);
  after.find((r) => r.recordName === x.root.recordName)!.fields.Completed =
    f(1);
  assert.throws(
    () => verifyOccurrence(p, after, owner),
    /uncertain|unknown|confirm/i,
  );
});
test("stale versions and unsynchronized alarms never produce a write plan", () => {
  const x = fixture();
  x.input.recordChangeTag = "stale";
  assert.throws(() => plan(x), /changed/);
  x.input.recordChangeTag = "old";
  x.alarm.fields.DueDateResolutionTokenAsNonce = f(0, "DOUBLE");
  assert.throws(() => plan(x), /synchronized/);
});
test("lists with no explicit ordering keep all existing ordering metadata untouched", () => {
  const x = fixture();
  delete x.list.fields.ReminderIDs;
  delete x.list.fields.ResolutionTokenMap;
  x.list.fields.NativeOrdering = f("preserve", "STRING");
  const p = plan(x);
  assert.deepEqual(p.operations[2].record.fields, { Deleted: f(0) });
  assert.equal(p.operations[0].record.fields.Completed.value, 0);
  assert.equal(p.operations[1].record.fields.Completed.value, 1);
  assert.equal(p.nextDueDate, "2026-10-21T01:00:00.000Z");
});
test("unsupported recurring shapes remain refused instead of completing the series", () => {
  for (const change of [
    (x: ReturnType<typeof fixture>) =>
      (x.rule.fields.EndDate = f(now, "TIMESTAMP")),
    (x: ReturnType<typeof fixture>) => (x.rule.fields.Interval = f(2)),
    (x: ReturnType<typeof fixture>) => (x.root.fields.AllDay = f(1)),
    (x: ReturnType<typeof fixture>) =>
      (x.trigger.fields.Type = f("Location", "STRING")),
  ]) {
    const x = fixture();
    change(x);
    assert.throws(() => plan(x));
  }
});
