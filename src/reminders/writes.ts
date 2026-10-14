import { z } from "zod";
import { AppError, requireValue } from "../errors.ts";
import { normalizeReminder, type CloudKitRecord } from "../icloud/cloudkit.ts";
import { encodeDocument } from "./crdt.ts";

// Write fields and resolution-token shapes follow pyicloud's MIT-licensed Reminders _writes.py and _protocol.py pinned references.
const UNSAFE_TEXT_CONTROLS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_OWNER = "__defaultOwner__";
const APPLE_EPOCH_SECONDS = 978_307_200;
const MAX_RESOLUTION_MAP_BYTES = 65_536;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function safeText(value: string): boolean {
  return !hasUnpairedSurrogate(value) && !UNSAFE_TEXT_CONTROLS.test(value);
}

function validIsoDateTime(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  if (match[8] !== "Z") {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  const millis = Date.parse(value);
  return (
    Number.isSafeInteger(millis) && Number.isFinite(new Date(millis).getTime())
  );
}

function validTimeZone(value: string): boolean {
  if (value.length > 128 || !safeText(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

const listId = z
  .string()
  .min(6)
  .max(255)
  .regex(
    /^List\/[\x21-\x2e\x30-\x7e]+$/,
    "Expected a canonical List/<ASCII suffix> ID.",
  )
  .describe(
    "Exact list ID from get_reminder_lists; do not use a list title or invent an ID.",
  );
const reminderId = z
  .string()
  .min(10)
  .max(255)
  .regex(
    /^Reminder\/[\x21-\x2e\x30-\x7e]+$/,
    "Expected a canonical Reminder/<ASCII suffix> ID.",
  )
  .describe(
    "Exact reminder ID from a previous read or mutation result, in the selected list.",
  );
const idempotencyKey = z
  .string()
  .uuid()
  .describe(
    "Generate one UUID for each distinct new reminder. Retain this key and identical creation inputs to reconcile an uncertain creation; never generate a replacement key for that attempt.",
  );
const title = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => value.trim().length > 0 && safeText(value),
    "Title must be nonblank text without unsafe controls or unpaired surrogates.",
  )
  .describe(
    "Nonblank plain-text title, up to 2,048 UTF-16 code units. Editing it replaces that field's formatting.",
  );
const notes = z
  .string()
  .max(16_000)
  .refine(
    safeText,
    "Notes cannot contain unsafe controls or unpaired surrogates.",
  )
  .describe(
    "Plain-text notes, up to 16,000 UTF-16 code units. An empty string clears notes; editing replaces their formatting.",
  );
const dueDate = z
  .string()
  .max(64)
  .refine(
    validIsoDateTime,
    "Due date must be a valid ISO 8601 date-time with an explicit offset.",
  );
const timeZone = z
  .string()
  .min(1)
  .max(128)
  .refine(
    validTimeZone,
    "Time zone must be a valid IANA time-zone identifier.",
  );
const priority = z
  .union([z.literal(0), z.literal(1), z.literal(5), z.literal(9)])
  .describe("0: none; 1: high; 5: medium; 9: low.");
const nullableDueDate = dueDate
  .nullable()
  .describe(
    "Valid ISO 8601 date-time with an explicit offset. Null clears the due date and, unless overridden, its time zone and all-day marker.",
  );
const nullableTimeZone = timeZone
  .nullable()
  .describe(
    "IANA time-zone identifier, such as Europe/London; null clears it. Required with a due date for all-day reminders.",
  );
const flagged = z.boolean().describe("Whether the reminder is flagged.");
const allDay = z
  .boolean()
  .describe(
    "Whether the due date is all-day. True requires a due date and time zone. Omitted update fields stay unchanged.",
  );

export const ReminderChanges = z
  .object({
    title,
    notes,
    priority,
    flagged,
    dueDate: nullableDueDate,
    timeZone: nullableTimeZone,
    allDay,
  })
  .partial()
  .strict();

export const CreateReminderInput = z
  .object({
    listId,
    idempotencyKey,
    title,
    notes: notes.default(""),
    priority: priority.default(0),
    flagged: flagged.default(false),
    dueDate: nullableDueDate.optional(),
    timeZone: nullableTimeZone.optional(),
    allDay: allDay.default(false),
  })
  .strict();

export const ReminderTargetInput = z
  .object({
    listId,
    reminderId,
    recordChangeTag: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
      .describe(
        "Current Apple version tag from get_reminder or get_reminders. Retain it for the exact request. A stale tag returns CONFLICT; never refresh it automatically to replay a write.",
      ),
  })
  .strict();

export const UpdateReminderInput = ReminderTargetInput.extend({
  changes: ReminderChanges.describe(
    "Nonempty object containing only fields to change. Omitted fields and their formatting remain untouched; completion, reopening and deletion use separate tools.",
  ),
}).strict();

export type CreateReminderInputData = z.infer<typeof CreateReminderInput>;
export type UpdateReminderInputData = z.infer<typeof UpdateReminderInput>;
export type ReminderChangesData = z.infer<typeof ReminderChanges>;
export type ReminderTargetInputData = z.infer<typeof ReminderTargetInput>;
export type ReminderLifecycleAction = "complete" | "reopen" | "delete";

export interface CloudKitWriteRecord {
  recordName: string;
  recordType: "Reminder";
  fields: Record<string, { type: string; value: unknown }>;
  recordChangeTag?: string;
  parent?: { recordName: string };
}

function validateNow(nowMs: number): number {
  requireValue(
    Number.isSafeInteger(nowMs),
    "The reminder write timestamp is invalid.",
  );
  return nowMs;
}

function appleTimestamp(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  return Date.parse(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function newResolutionToken(modificationTime: number): {
  counter: number;
  modificationTime: number;
  replicaID: string;
} {
  return {
    counter: 1,
    modificationTime,
    replicaID: crypto.randomUUID().toUpperCase(),
  };
}

export function createResolutionTokenMap(
  fieldNames: readonly string[],
  nowMs: number,
): string {
  const modificationTime = nowMs / 1000 - APPLE_EPOCH_SECONDS;
  const map: Record<
    string,
    ReturnType<typeof newResolutionToken>
  > = Object.create(null) as Record<
    string,
    ReturnType<typeof newResolutionToken>
  >;
  for (const fieldName of fieldNames)
    map[fieldName] = newResolutionToken(modificationTime);
  return JSON.stringify({ map });
}

function existingResolutionMap(
  current: CloudKitRecord,
): Record<string, unknown> {
  if (!Object.hasOwn(current.fields, "ResolutionTokenMap"))
    return Object.create(null) as Record<string, unknown>;
  const wrapper = current.fields.ResolutionTokenMap;
  if (
    !isPlainObject(wrapper) ||
    wrapper.type !== "STRING" ||
    typeof wrapper.value !== "string"
  ) {
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The current reminder has an invalid ResolutionTokenMap field.",
    );
  }
  const encoded = wrapper.value;
  if (new TextEncoder().encode(encoded).length > MAX_RESOLUTION_MAP_BYTES)
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The current reminder ResolutionTokenMap is oversized.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded) as unknown;
  } catch {
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The current reminder ResolutionTokenMap is malformed.",
    );
  }
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !Object.hasOwn(parsed, "map") ||
    !isPlainObject(parsed.map) ||
    Object.keys(parsed.map).length > 512
  ) {
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The current reminder ResolutionTokenMap is malformed.",
    );
  }
  const map: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [fieldName, token] of Object.entries(parsed.map)) {
    if (
      !/^[!-~]{1,128}$/.test(fieldName) ||
      !isPlainObject(token) ||
      !Number.isSafeInteger(token.counter) ||
      (token.counter as number) < 1 ||
      typeof token.modificationTime !== "number" ||
      !Number.isFinite(token.modificationTime) ||
      typeof token.replicaID !== "string" ||
      !UUID.test(token.replicaID)
    ) {
      throw new AppError(
        "PROTOCOL_CHANGED",
        "The current reminder ResolutionTokenMap contains an invalid token.",
      );
    }
    map[fieldName] = token;
  }
  return map;
}

export function updateResolutionTokenMap(
  current: CloudKitRecord,
  fieldNames: readonly string[],
  nowMs: number,
): string {
  const map = existingResolutionMap(current);
  const modificationTime = nowMs / 1000 - APPLE_EPOCH_SECONDS;
  // Latest Xzese keeps the replica identity and advances the existing counter.
  // Replacing it with a new counter=1 token can lose the native merge lineage.
  for (const fieldName of new Set(fieldNames)) {
    const existing = map[fieldName] as
      | { counter: number; modificationTime: number; replicaID: string }
      | undefined;
    if (!existing) map[fieldName] = newResolutionToken(modificationTime);
    else {
      if (!Number.isSafeInteger(existing.counter + 1))
        throw new AppError(
          "PROTOCOL_CHANGED",
          "The existing resolution counter cannot be advanced safely.",
        );
      map[fieldName] = {
        ...existing,
        counter: existing.counter + 1,
        modificationTime: Math.max(modificationTime, existing.modificationTime),
      };
    }
  }
  const encoded = JSON.stringify({ map });
  if (
    Object.keys(map).length > 512 ||
    new TextEncoder().encode(encoded).length > MAX_RESOLUTION_MAP_BYTES
  ) {
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The updated reminder ResolutionTokenMap exceeds the supported budget.",
    );
  }
  return encoded;
}

function assertOwnedReminder(
  record: CloudKitRecord,
  expectedOwner: string,
): void {
  const recordOwner = record.zoneID?.ownerRecordName;
  if (
    recordOwner !== undefined &&
    recordOwner !== DEFAULT_OWNER &&
    recordOwner !== expectedOwner
  ) {
    throw new AppError(
      "FORBIDDEN",
      "The reminder belongs to a different CloudKit owner.",
      403,
    );
  }
  if (record.zoneID && record.zoneID.zoneName !== "Reminders") {
    throw new AppError(
      "FORBIDDEN",
      "The reminder belongs to a different CloudKit zone.",
      403,
    );
  }
  const listField = record.fields.List;
  if (isPlainObject(listField) && isPlainObject(listField.value)) {
    const zone = listField.value.zoneID;
    if (
      isPlainObject(zone) &&
      typeof zone.ownerRecordName === "string" &&
      zone.ownerRecordName !== DEFAULT_OWNER &&
      zone.ownerRecordName !== expectedOwner
    ) {
      throw new AppError(
        "FORBIDDEN",
        "The reminder list belongs to a different CloudKit owner.",
        403,
      );
    }
  }
}

function currentReminder(
  record: CloudKitRecord,
  expectedOwner: string,
  listId: string,
  recordName: string,
  recordChangeTag: string,
  expectedCompleted: boolean | null = false,
) {
  assertOwnedReminder(record, expectedOwner);
  if (
    record.recordType !== "Reminder" ||
    record.recordName !== recordName ||
    record.deleted === true
  ) {
    throw new AppError(
      "CONFLICT",
      "The reminder is no longer available for this update.",
      409,
    );
  }
  const reminder = normalizeReminder(record, expectedOwner);
  if (
    reminder.listId !== listId ||
    typeof reminder.completed !== "boolean" ||
    (expectedCompleted !== null && reminder.completed !== expectedCompleted) ||
    reminder.deleted !== false ||
    reminder.recordChangeTag !== recordChangeTag
  ) {
    throw new AppError(
      "CONFLICT",
      "The reminder changed or is no longer in the required state in the requested list.",
      409,
    );
  }
  return reminder;
}

function requireAllDayValues(
  allDay: boolean,
  due: string | null,
  zone: string | null,
): void {
  if (!allDay) return;
  requireValue(
    due !== null && zone !== null,
    "An all-day reminder requires a due date and a time zone.",
  );
  requireValue(
    validTimeZone(zone),
    "An all-day reminder requires a valid time zone.",
  );
}

const CREATE_TOKEN_FIELDS = [
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
] as const;

export function buildCreateReminder(
  input: CreateReminderInputData,
  nowMs = Date.now(),
): CloudKitWriteRecord {
  const parsed = CreateReminderInput.parse(input);
  validateNow(nowMs);
  const due = parsed.dueDate ?? null;
  const zone = parsed.timeZone ?? null;
  requireAllDayValues(parsed.allDay, due, zone);
  const recordName = `Reminder/${parsed.idempotencyKey.toUpperCase()}`;
  const fields: CloudKitWriteRecord["fields"] = {
    AllDay: { type: "INT64", value: parsed.allDay ? 1 : 0 },
    Completed: { type: "INT64", value: 0 },
    CompletionDate: { type: "TIMESTAMP", value: null },
    CreationDate: { type: "TIMESTAMP", value: nowMs },
    Deleted: { type: "INT64", value: 0 },
    Flagged: { type: "INT64", value: parsed.flagged ? 1 : 0 },
    Imported: { type: "INT64", value: 0 },
    LastModifiedDate: { type: "TIMESTAMP", value: nowMs },
    List: {
      type: "REFERENCE",
      value: { recordName: parsed.listId, action: "VALIDATE" },
    },
    NotesDocument: { type: "STRING", value: encodeDocument(parsed.notes) },
    Priority: { type: "INT64", value: parsed.priority },
    ResolutionTokenMap: {
      type: "STRING",
      value: createResolutionTokenMap(CREATE_TOKEN_FIELDS, nowMs),
    },
    TitleDocument: { type: "STRING", value: encodeDocument(parsed.title) },
  };
  if (due !== null)
    fields.DueDate = { type: "TIMESTAMP", value: appleTimestamp(due) };
  if (zone !== null) fields.TimeZone = { type: "STRING", value: zone };
  return {
    recordName,
    recordType: "Reminder",
    fields,
    parent: { recordName: parsed.listId },
  };
}

function sameDate(left: string | null, right: string | null): boolean {
  return appleTimestamp(left) === appleTimestamp(right);
}

export function buildUpdateReminder(
  input: UpdateReminderInputData,
  current: CloudKitRecord,
  expectedOwner: string,
  nowMs = Date.now(),
): CloudKitWriteRecord {
  const parsed = UpdateReminderInput.parse(input);
  validateNow(nowMs);
  const changes = parsed.changes;
  const proposedKeys = Object.keys(changes).filter(
    (key) => changes[key as keyof ReminderChangesData] !== undefined,
  );
  requireValue(
    proposedKeys.length > 0,
    "At least one reminder change is required.",
  );
  const reminder = currentReminder(
    current,
    expectedOwner,
    parsed.listId,
    parsed.reminderId,
    parsed.recordChangeTag,
  );

  let nextDue = reminder.dueDate;
  let nextZone = reminder.timeZone;
  let nextAllDay = reminder.allDay ?? false;
  if (changes.dueDate !== undefined) nextDue = changes.dueDate;
  if (changes.timeZone !== undefined) nextZone = changes.timeZone;
  if (changes.allDay !== undefined) nextAllDay = changes.allDay;
  if (changes.dueDate === null) {
    if (changes.allDay === undefined && nextAllDay) nextAllDay = false;
    if (changes.timeZone === undefined) nextZone = null;
  }
  // Apple can retain AllDay=1 on an undated reminder. Preserve that existing
  // state for unrelated edits; validate dependencies when changing date fields.
  const nativeAllDay =
    reminder.allDay === true &&
    nextAllDay &&
    nextZone === null &&
    changes.timeZone === undefined &&
    nextDue !== null;
  if (nativeAllDay && changes.dueDate !== undefined)
    requireValue(
      changes.dueDate !== null &&
        changes.dueDate.endsWith("Z") &&
        Date.parse(changes.dueDate) % 86400000 === 0,
      "An all-day date without a stored zone requires an explicit midnight-UTC calendar date.",
    );
  if (
    !nativeAllDay &&
    (changes.dueDate !== undefined ||
      changes.timeZone !== undefined ||
      changes.allDay !== undefined)
  )
    requireAllDayValues(nextAllDay, nextDue, nextZone);

  const dateChanged = !sameDate(reminder.dueDate, nextDue);
  const zoneChanged = (reminder.timeZone ?? null) !== nextZone;
  const allDayChanged = (reminder.allDay ?? false) !== nextAllDay;
  if (
    (dateChanged || zoneChanged || allDayChanged) &&
    ((reminder.recurrenceRuleIds?.length ?? 0) > 0 ||
      (reminder.alarmIds?.length ?? 0) > 0 ||
      Object.hasOwn(current.fields, "DueDateDeltaAlertsData"))
  ) {
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "Due date, time zone, and all-day updates are unavailable for recurring or alarmed reminders.",
    );
  }

  const fields: CloudKitWriteRecord["fields"] = {};
  const tokenFields: string[] = [];
  const change = (
    key: string,
    tokenName: string,
    type: string,
    value: unknown,
  ) => {
    fields[key] = { type, value };
    tokenFields.push(tokenName);
  };
  if (changes.title !== undefined && changes.title !== reminder.title)
    change(
      "TitleDocument",
      "titleDocument",
      "STRING",
      encodeDocument(changes.title),
    );
  if (changes.notes !== undefined && changes.notes !== reminder.notes)
    change(
      "NotesDocument",
      "notesDocument",
      "STRING",
      encodeDocument(changes.notes),
    );
  if (changes.priority !== undefined && changes.priority !== reminder.priority)
    change("Priority", "priority", "INT64", changes.priority);
  if (changes.flagged !== undefined && changes.flagged !== reminder.flagged)
    change("Flagged", "flagged", "INT64", changes.flagged ? 1 : 0);
  if (dateChanged)
    change("DueDate", "dueDate", "TIMESTAMP", appleTimestamp(nextDue));
  if (zoneChanged) change("TimeZone", "timeZone", "STRING", nextZone);
  if (allDayChanged) change("AllDay", "allDay", "INT64", nextAllDay ? 1 : 0);
  requireValue(
    tokenFields.length > 0,
    "The requested reminder changes do not change any fields.",
  );
  fields.LastModifiedDate = { type: "TIMESTAMP", value: nowMs };
  tokenFields.push("lastModifiedDate");
  fields.ResolutionTokenMap = {
    type: "STRING",
    value: updateResolutionTokenMap(current, tokenFields, nowMs),
  };
  return {
    recordName: parsed.reminderId,
    recordType: "Reminder",
    recordChangeTag: parsed.recordChangeTag,
    fields,
  };
}

export function buildLifecycleReminder(
  action: ReminderLifecycleAction,
  input: ReminderTargetInputData,
  current: CloudKitRecord,
  expectedOwner: string,
  nowMs = Date.now(),
): CloudKitWriteRecord {
  const parsed = ReminderTargetInput.parse(input);
  validateNow(nowMs);
  requireValue(
    ["complete", "reopen", "delete"].includes(action),
    "Unsupported reminder state change.",
  );
  const reminder = currentReminder(
    current,
    expectedOwner,
    parsed.listId,
    parsed.reminderId,
    parsed.recordChangeTag,
    action === "delete" ? null : action === "reopen",
  );
  if (
    (reminder.recurrenceRuleIds?.length ?? 0) > 0 ||
    (reminder.alarmIds?.length ?? 0) > 0 ||
    reminder.parentReminderId !== null
  ) {
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "Completion, reopening and deletion are unavailable for recurring, alarmed or nested reminders.",
    );
  }
  const fields: CloudKitWriteRecord["fields"] = {
    LastModifiedDate: { type: "TIMESTAMP", value: nowMs },
  };
  const tokenFields = ["lastModifiedDate"];
  if (action === "delete") {
    fields.Deleted = { type: "INT64", value: 1 };
    tokenFields.push("deleted");
  } else {
    fields.Completed = { type: "INT64", value: action === "complete" ? 1 : 0 };
    fields.CompletionDate = {
      type: "TIMESTAMP",
      value: action === "complete" ? nowMs : null,
    };
    tokenFields.push("completed", "completionDate");
  }
  fields.ResolutionTokenMap = {
    type: "STRING",
    value: updateResolutionTokenMap(current, tokenFields, nowMs),
  };
  return {
    recordName: parsed.reminderId,
    recordType: "Reminder",
    recordChangeTag: parsed.recordChangeTag,
    fields,
  };
}

export function matchesCreatedReminder(
  input: CreateReminderInputData,
  current: CloudKitRecord,
  expectedOwner: string,
): boolean {
  const parsed = CreateReminderInput.parse(input);
  try {
    assertOwnedReminder(current, expectedOwner);
    if (
      current.recordType !== "Reminder" ||
      current.recordName !==
        `Reminder/${parsed.idempotencyKey.toUpperCase()}` ||
      current.deleted === true
    )
      return false;
    const reminder = normalizeReminder(current, expectedOwner);
    return (
      reminder.listId === parsed.listId &&
      reminder.completed === false &&
      reminder.deleted === false &&
      reminder.title === parsed.title &&
      (reminder.notes ?? "") === parsed.notes &&
      reminder.priority === parsed.priority &&
      reminder.flagged === parsed.flagged &&
      (reminder.allDay ?? false) === parsed.allDay &&
      sameDate(reminder.dueDate, parsed.dueDate ?? null) &&
      (reminder.timeZone ?? null) === (parsed.timeZone ?? null)
    );
  } catch {
    return false;
  }
}
