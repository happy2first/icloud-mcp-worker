// Derived from Xzese recurring-lifecycle.ts; MIT, Copyright (c) 2026
// icloud-reminders-mcp-server contributors. See LICENSE.
import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { b64, utf8 } from "../crypto/bytes.ts";
import {
  normalizeReminder,
  normalizeList,
  referenceField,
  type CloudKitRecord,
} from "../icloud/cloudkit.ts";
import {
  createResolutionTokenMap,
  updateResolutionTokenMap,
  type ReminderTargetInputData,
} from "./writes.ts";
import {
  dateComponents,
  decodeDateComponents,
  dueDateNonce,
} from "./date-components.ts";
export type OccurrenceOperation = {
  operationType: "create" | "update" | "delete";
  record: {
    recordName: string;
    recordType: string;
    recordChangeTag?: string;
    fields: Record<string, { type: string; value: unknown }>;
    parent?: { recordName: string };
  };
};
const value = (r: CloudKitRecord, k: string): any =>
  (r.fields[k] as any)?.value;
const fail = (message: string): never => {
  throw new AppError("UNSUPPORTED_FEATURE", message);
};
export function nextOccurrence(due: string, zone: string, days: number) {
  const before = dateComponents(due, zone),
    local = Date.UTC(
      before.year,
      before.month - 1,
      before.day + days,
      before.hour,
      before.minute,
      before.second,
    );
  const wall = (ms: number) => {
    const d = dateComponents(new Date(ms).toISOString(), zone);
    return Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second);
  };
  const offsets = new Set<number>();
  for (let h = -48; h <= 48; h += 6) {
    const s = local + h * 3600000;
    offsets.add(wall(s) - s);
  }
  const candidates = [...offsets]
    .map((o) => local - o)
    .filter((t) => wall(t) === local);
  if (candidates.length !== 1)
    fail(
      "The next recurring occurrence is ambiguous at a time-zone transition.",
    );
  return new Date(candidates[0]).toISOString();
}
export function planRecurringCompletion(
  input: ReminderTargetInputData,
  root: CloudKitRecord,
  list: CloudKitRecord,
  rule: CloudKitRecord,
  alarm: CloudKitRecord,
  trigger: CloudKitRecord,
  owner: string,
  now = Date.now(),
) {
  const r = normalizeReminder(root, owner);
  if (
    r.id !== input.reminderId ||
    r.listId !== input.listId ||
    r.recordChangeTag !== input.recordChangeTag ||
    r.completed !== false ||
    r.deleted !== false
  )
    throw new AppError(
      "CONFLICT",
      "The recurring reminder changed; no completion was dispatched.",
      409,
    );
  if (
    r.parentReminderId ||
    r.startDate ||
    r.allDay !== false ||
    !r.dueDate ||
    !r.timeZone ||
    r.recurrenceRuleIds?.length !== 1 ||
    r.alarmIds?.length !== 1 ||
    r.attachmentIds?.length ||
    r.hashtagIds?.length ||
    value(root, "DueDateDeltaAlertsData") != null ||
    (value(root, "AssignmentIDs") != null &&
      (!Array.isArray(value(root, "AssignmentIDs")) ||
        value(root, "AssignmentIDs").length !== 0)) ||
    Object.keys(root.fields).some((k) => /child|subtask/i.test(k))
  )
    fail(
      "Recurring completion currently requires one timed root with one absolute alarm and no subtasks, attachments, tags, assignments or early reminders.",
    );
  const allowedRule = [
    "Reminder",
    "Frequency",
    "Interval",
    "OccurrenceCount",
    "FirstDayOfTheWeek",
    "Imported",
    "Deleted",
    "EndDate",
    "DaysOfTheWeek",
    "DaysOfTheMonth",
    "MonthsOfTheYear",
  ];
  if (
    rule.recordType !== "RecurrenceRule" ||
    r.recurrenceRuleIds![0] !== rule.recordName ||
    referenceField(rule, "Reminder", "Reminder", owner) !== root.recordName ||
    Object.keys(rule.fields).some((k) => !allowedRule.includes(k)) ||
    ![0, 1].includes(value(rule, "Frequency")) ||
    value(rule, "Interval") !== 1 ||
    ["OccurrenceCount", "FirstDayOfTheWeek", "Imported", "Deleted"].some(
      (k) => value(rule, k) !== 0,
    ) ||
    ["EndDate", "DaysOfTheWeek", "DaysOfTheMonth", "MonthsOfTheYear"].some(
      (k) => value(rule, k) != null,
    )
  )
    fail(
      `Recurring completion pattern is not yet supported: frequency=${[0, 1, 2, 3, 4].includes(value(rule, "Frequency")) ? value(rule, "Frequency") : "unknown"}, interval=${Number.isSafeInteger(value(rule, "Interval")) ? value(rule, "Interval") : "unknown"}; ended/patterned rules require another native recipe.`,
    );
  if (
    alarm.recordType !== "Alarm" ||
    trigger.recordType !== "AlarmTrigger" ||
    r.alarmIds![0] !== alarm.recordName ||
    referenceField(alarm, "Reminder", "Reminder", owner) !== root.recordName ||
    referenceField(trigger, "Alarm", "Alarm", owner) !== alarm.recordName ||
    ![trigger.recordName, trigger.recordName.slice(13)].includes(
      value(alarm, "TriggerID"),
    ) ||
    value(alarm, "AlarmUID") !== alarm.recordName.slice(6) ||
    value(trigger, "Type") !== "Date" ||
    [alarm, trigger].some(
      (dep) => value(dep, "Imported") !== 0 || value(dep, "Deleted") !== 0,
    ) ||
    Object.keys(alarm.fields).some(
      (k) =>
        ![
          "AlarmUID",
          "DueDateResolutionTokenAsNonce",
          "Reminder",
          "TriggerID",
          "Imported",
          "Deleted",
        ].includes(k),
    ) ||
    Object.keys(trigger.fields).some(
      (k) =>
        ![
          "DateComponentsData",
          "Type",
          "Alarm",
          "Imported",
          "Deleted",
        ].includes(k),
    )
  )
    fail(
      "The recurrence alarm is not the supported bidirectional absolute-date pair.",
    );
  for (const dep of [root, list, rule, alarm, trigger])
    if (
      !dep.recordChangeTag ||
      dep.deleted ||
      dep.raw.share != null ||
      (dep.zoneID?.ownerRecordName &&
        ![owner, "__defaultOwner__"].includes(dep.zoneID.ownerRecordName))
    )
      throw new AppError(
        "CONFLICT",
        "A recurring participant is changed, shared or outside the authenticated owner.",
        409,
      );
  const components = decodeDateComponents(value(trigger, "DateComponentsData")),
    nano = Object.hasOwn(components, "nanosecond");
  if (
    JSON.stringify(components) !==
      JSON.stringify(dateComponents(r.dueDate!, r.timeZone!, nano)) ||
    value(alarm, "DueDateResolutionTokenAsNonce") !==
      dueDateNonce(value(root, "ResolutionTokenMap"))
  )
    throw new AppError(
      "CONFLICT",
      "The recurrence due date and alarm are not synchronized.",
      409,
    );
  if (components.year < 100)
    fail("Recurring completion requires Gregorian years 100 or later.");
  const next = nextOccurrence(
    r.dueDate!,
    r.timeZone!,
    value(rule, "Frequency") === 1 ? 7 : 1,
  );
  if (Date.parse(next) <= now)
    fail(
      "Multiple overdue occurrences cannot be skipped automatically; this completion advances exactly one occurrence.",
    );
  const historyId = `Reminder/${crypto.randomUUID().toUpperCase()}`;
  const activeFields: OccurrenceOperation["record"]["fields"] = {
    Completed: { type: "INT64", value: 0 },
    CompletionDate: { type: "TIMESTAMP", value: null },
    DueDate: { type: "TIMESTAMP", value: Date.parse(next) },
    LastModifiedDate: { type: "TIMESTAMP", value: now },
    ResolutionTokenMap: {
      type: "STRING",
      value: updateResolutionTokenMap(
        root,
        ["completed", "completionDate", "dueDate", "lastModifiedDate"],
        now,
      ),
    },
  };
  const copied: typeof activeFields = {};
  for (const key of [
    "AllDay",
    "CreationDate",
    "Flagged",
    "Priority",
    "DueDate",
    "TimeZone",
    "TitleDocument",
    "NotesDocument",
  ]) {
    const f = root.fields[key] as { type: string; value: unknown } | undefined;
    if (f)
      copied[key] = {
        type: key.endsWith("Document") ? "STRING" : f.type,
        value: f.value,
      };
  }
  if (!copied.TitleDocument || copied.CreationDate?.type !== "TIMESTAMP")
    fail("The recurring history lacks original title or creation metadata.");
  const historyFields: typeof activeFields = {
    ...copied,
    Completed: { type: "INT64", value: 1 },
    CompletionDate: { type: "TIMESTAMP", value: now },
    Deleted: { type: "INT64", value: 0 },
    Imported: { type: "INT64", value: 0 },
    LastModifiedDate: { type: "TIMESTAMP", value: now },
    ResolutionTokenMap: {
      type: "STRING",
      value: createResolutionTokenMap(
        [
          "allDay",
          "completed",
          "completionDate",
          "creationDate",
          "flagged",
          "lastModifiedDate",
          "list",
          "minimumSupportedVersion",
          "priority",
          "titleDocument",
          "dueDate",
          ...(copied.NotesDocument ? ["notesDocument"] : []),
          ...(copied.TimeZone ? ["timeZone"] : []),
        ],
        now,
      ),
    },
    List: {
      type: "REFERENCE",
      value: { recordName: list.recordName, action: "VALIDATE" },
    },
    ...Object.fromEntries(
      [
        "AlarmIDs",
        "HashtagIDs",
        "AttachmentIDs",
        "AssignmentIDs",
        "RecurrenceRuleIDs",
      ].map((k) => [k, { type: "UNKNOWN_LIST", value: [] }]),
    ),
  };
  const members = normalizeList(list).reminderIds;
  if (
    list.recordType !== "List" ||
    list.recordName !== r.listId ||
    (members !== null && new Set(members).size !== members.length) ||
    normalizeList(list, false).isGroup !== false ||
    normalizeList(list, false).deleted !== false
  )
    throw new AppError(
      "CONFLICT",
      `Recurring completion requires exact owned list membership: available=${members !== null}; count=${members?.length ?? "missing"}; unique=${members ? new Set(members).size : "missing"}; group=${normalizeList(list, false).isGroup}; deleted=${normalizeList(list, false).deleted}. No completion was dispatched.`,
      409,
    );
  // Apple also returns lists without explicit ReminderIDs ordering. Their
  // membership is the exact Reminder.List reference / intrinsic List parent.
  // Guard the observed list version without inventing an ordering array.
  let membershipFields: typeof activeFields = {
    Deleted: { type: "INT64", value: 0 },
  };
  if (members !== null) {
    const order = JSON.parse(value(list, "ReminderIDs")) as string[];
    const index = members.indexOf(root.recordName);
    if (index < 0)
      throw new AppError(
        "CONFLICT",
        "The recurring root is absent from explicit list membership.",
        409,
      );
    order.splice(
      index,
      0,
      order[index].includes("/") ? historyId : historyId.slice(9),
    );
    membershipFields = {
      ReminderIDs: { type: "STRING", value: JSON.stringify(order) },
      ResolutionTokenMap: {
        type: "STRING",
        value: updateResolutionTokenMap(
          list,
          ["reminderIDsMergeableOrdering"],
          now,
        ),
      },
    };
  }
  const ops: OccurrenceOperation[] = [
    {
      operationType: "update",
      record: {
        recordName: root.recordName,
        recordType: "Reminder",
        recordChangeTag: root.recordChangeTag,
        fields: activeFields,
      },
    },
    {
      operationType: "create",
      record: {
        recordName: historyId,
        recordType: "Reminder",
        parent: { recordName: list.recordName },
        fields: historyFields,
      },
    },
    {
      operationType: "update",
      record: {
        recordName: list.recordName,
        recordType: "List",
        recordChangeTag: list.recordChangeTag,
        fields: membershipFields,
      },
    },
    {
      operationType: "update",
      record: {
        recordName: rule.recordName,
        recordType: "RecurrenceRule",
        recordChangeTag: rule.recordChangeTag,
        fields: { Deleted: { type: "INT64", value: 0 } },
      },
    },
    ...[trigger, alarm].map((dep) => ({
      operationType: "delete" as const,
      record: {
        recordName: dep.recordName,
        recordType: dep.recordType,
        recordChangeTag: dep.recordChangeTag,
        fields: {},
      },
    })),
  ];
  const pair = (name: string, due: string, fields: typeof activeFields) => {
    const a = crypto.randomUUID().toUpperCase(),
      t = crypto.randomUUID().toUpperCase();
    fields.AlarmIDs = { type: "STRING_LIST", value: [a] };
    ops.push(
      {
        operationType: "create",
        record: {
          recordName: `Alarm/${a}`,
          recordType: "Alarm",
          fields: {
            AlarmUID: { type: "STRING", value: a },
            TriggerID: { type: "STRING", value: t },
            DueDateResolutionTokenAsNonce: {
              type: "DOUBLE",
              value: dueDateNonce(fields.ResolutionTokenMap.value),
            },
            Reminder: {
              type: "REFERENCE",
              value: { recordName: name, action: "VALIDATE" },
            },
            Imported: { type: "INT64", value: 0 },
            Deleted: { type: "INT64", value: 0 },
          },
        },
      },
      {
        operationType: "create",
        record: {
          recordName: `AlarmTrigger/${t}`,
          recordType: "AlarmTrigger",
          fields: {
            DateComponentsData: {
              type: "BYTES",
              value: b64(
                utf8(JSON.stringify(dateComponents(due, r.timeZone!, nano))),
              ),
            },
            Type: { type: "STRING", value: "Date" },
            Alarm: {
              type: "REFERENCE",
              value: { recordName: `Alarm/${a}`, action: "VALIDATE" },
            },
            Imported: { type: "INT64", value: 0 },
            Deleted: { type: "INT64", value: 0 },
          },
        },
      },
    );
  };
  pair(root.recordName, next, activeFields);
  pair(historyId, r.dueDate!, historyFields);
  return {
    operations: ops,
    historyId,
    nextDueDate: next,
    originalDueDate: r.dueDate,
    dispatchedAt: now,
    rootId: root.recordName,
    preservedRootFields: Object.fromEntries(
      Object.entries(root.fields).filter(
        ([key]) => !Object.hasOwn(activeFields, key),
      ),
    ),
    preservedRuleFields: rule.fields,
  };
}
export function verifyOccurrence(
  plan: ReturnType<typeof planRecurringCompletion>,
  records: CloudKitRecord[],
  owner: string,
) {
  const active = records.find((r) => r.recordName === plan.rootId),
    history = records.find((r) => r.recordName === plan.historyId);
  if (
    !active ||
    !history ||
    normalizeReminder(active, owner).completed !== false ||
    normalizeReminder(active, owner).dueDate !== plan.nextDueDate ||
    normalizeReminder(history, owner).completed !== true ||
    normalizeReminder(history, owner).dueDate !== plan.originalDueDate
  )
    throw new WriteOutcomeUnknownError(plan.rootId);
  for (const op of plan.operations.filter(
    (o) => o.operationType !== "delete",
  )) {
    const got = records.find((r) => r.recordName === op.record.recordName);
    if (
      !got ||
      got.deleted ||
      !got.recordChangeTag ||
      (op.operationType === "update" &&
        got.recordChangeTag === op.record.recordChangeTag &&
        !(
          Object.keys(op.record.fields).length === 1 &&
          op.record.fields.Deleted?.value === 0
        ))
    )
      throw new WriteOutcomeUnknownError(plan.rootId);
    for (const [key, f] of Object.entries(op.record.fields)) {
      const actual = value(got, key);
      // CloudKit regenerates creation / modification metadata after linking
      // the new alarm pairs. They are not proof of another user mutation.
      if (
        key === "CreationDate" &&
        op.operationType === "create" &&
        actual === f.value
      )
        continue;
      if (
        key === "LastModifiedDate" ||
        (key === "CreationDate" && op.operationType === "create")
      ) {
        if (
          typeof actual !== "number" ||
          !Number.isSafeInteger(actual) ||
          actual < plan.dispatchedAt ||
          actual > Date.now() + 300_000
        )
          throw new WriteOutcomeUnknownError(
            plan.rootId,
            undefined,
            `Invalid Apple-managed ${got.recordType}.${key}.`,
          );
        continue;
      }
      if (
        f.type === "REFERENCE"
          ? actual?.recordName !== (f.value as any)?.recordName
          : JSON.stringify(actual) !== JSON.stringify(f.value)
      )
        throw new WriteOutcomeUnknownError(
          plan.rootId,
          undefined,
          `Occurrence confirmation differed at ${got.recordType}.${key}; no replay.`,
        );
    }
  }
  for (const [record, fields] of [
    [active, plan.preservedRootFields],
    [
      records.find(
        (r) => r.recordName === plan.operations[3].record.recordName,
      ),
      plan.preservedRuleFields,
    ],
  ] as const) {
    if (!record) throw new WriteOutcomeUnknownError(plan.rootId);
    for (const [key, field] of Object.entries(fields)) {
      if (
        JSON.stringify((record.fields[key] as any)?.value) !==
        JSON.stringify((field as any)?.value)
      )
        throw new WriteOutcomeUnknownError(plan.rootId);
    }
  }
  return active;
}
