import { z } from "zod";
import { SavedListSchema } from "../persistence/apple-sessions.ts";

const counter = z.number().int().nonnegative().safe();
const nullableTime = counter.nullable();
const text = z.string().nullable();
const flag = z.boolean().nullable();
const ids = z.array(z.string()).nullable();

export const ExpectedGenerationInput = counter
  .optional()
  .describe(
    "Apple session generation from connection_status. Supply it to bind reads and writes to that session; retain it for reconciliation. A changed session returns CONFLICT.",
  );

// Public normalized data only. Strict objects keep raw Apple records, proof
// material and transport metadata outside the advertised success contracts.
export const ReminderOutput = z
  .object({
    id: z
      .string()
      .describe(
        "Exact reminder ID to retain for subsequent reads and changes.",
      ),
    listId: z.string(),
    title: text,
    notes: text,
    completed: flag,
    completedDate: text.describe(
      "ISO completion timestamp, or null when absent.",
    ),
    dueDate: text,
    startDate: text,
    priority: z.number().int().nullable(),
    flagged: flag,
    allDay: flag,
    deleted: flag,
    timeZone: text,
    parentReminderId: text,
    alarmIds: ids,
    attachmentIds: ids,
    hashtagIds: ids,
    recurrenceRuleIds: ids,
    created: text,
    modified: text,
    recordChangeTag: text.describe(
      "Current Apple version token. Read again after a change; never invent or automatically replace it to retry a conflicting write.",
    ),
  })
  .strict();

const recordError = z.object({ id: text, code: z.string() }).strict();
const freshness = z
  .object({
    mode: z.literal("live"),
    retrievedAt: counter
      .optional()
      .describe(
        "Time the current list set was retrieved; reminder contents are queried live per page.",
      ),
  })
  .strict();
const page = {
  generation: counter,
  complete: z
    .boolean()
    .describe(
      "Whether this page has no unresolved record errors; use paginationComplete to determine whether the list has finished.",
    ),
  paginationComplete: z.boolean(),
  continuation: z
    .string()
    .nullable()
    .describe(
      "Opaque next-page value. Keep the same list and read options when continuing; null means no further page.",
    ),
  pendingReason: text,
  recordErrors: z.array(recordError),
  freshness,
  source: z.enum(["direct-cloudkit-query", "direct-known-list-query"]),
  writesEnabled: z.boolean(),
};

export const ListsOutput = z
  .object({
    ...page,
    records: z.array(
      SavedListSchema.pick({ id: true })
        .extend({
          title: text,
          color: text,
          count: counter.nullable(),
          isGroup: flag,
          deleted: flag,
          reminderIds: ids,
        })
        .strict(),
    ),
  })
  .strict();
export const RemindersPageOutput = z
  .object({
    ...page,
    listId: z.string(),
    records: z.array(
      z.union([
        ReminderOutput,
        z.object({ id: z.string(), deleted: z.literal(true) }).strict(),
      ]),
    ),
  })
  .strict();
export const ReminderLookupOutput = z
  .object({
    generation: counter,
    record: ReminderOutput.nullable(),
    missing: z
      .boolean()
      .describe(
        "True only when Apple reports the exact item absent. A soft-deleted item may instead be returned with record.deleted=true.",
      ),
  })
  .strict();

export const AllOpenOutput = z
  .object({
    generation: counter,
    records: z.array(ReminderOutput),
    lists: z.array(SavedListSchema),
    recordErrors: z.array(recordError),
    errors: z.array(
      z
        .object({
          code: z.string(),
          message: z.string().optional(),
          listId: z.string().optional(),
          retryable: z.boolean(),
          retryAfterSeconds: z.number().nonnegative().optional(),
        })
        .strict(),
    ),
    complete: z
      .boolean()
      .describe(
        "True only when every discovered list finished without record or read errors. Otherwise combine pages using continuation and inspect errors.",
      ),
    paginationComplete: z.boolean(),
    continuation: z
      .string()
      .uuid()
      .nullable()
      .describe(
        "Short-lived single-use continuation bound to this owner and Apple session. Use the newly returned token for the next call.",
      ),
    pendingReason: text,
    progress: z
      .object({
        listsTotal: counter,
        listsCompleted: counter,
        pagesRead: counter,
        totalPages: counter,
      })
      .strict(),
    freshness,
    source: z.literal("direct-cloudkit-query"),
    scope: z.literal("all-open-reminders"),
    writesEnabled: z.boolean(),
  })
  .strict();

export function MutationOutput(
  action: "create" | "update" | "complete" | "reopen" | "delete",
) {
  const result = z
    .object({
      generation: counter,
      operation: z.literal(action),
      replayed: z
        .boolean()
        .describe(
          "True for an identical create reconciled from the existing item without another Apple write.",
        ),
      record: ReminderOutput,
      writesEnabled: z.literal(true),
    })
    .strict();
  return action === "create"
    ? result.extend({ idempotencyKey: z.string().uuid() }).strict()
    : result;
}

export const ConnectionStatusOutput = z
  .object({
    generation: counter,
    version: counter,
    state: z.enum([
      "DISCONNECTED",
      "CONNECTING",
      "DEVICE_APPROVAL_PENDING",
      "READY",
    ]),
    action: z
      .enum(["approve-device-consent", "wait-for-reminders-keys"])
      .nullable(),
    nextAttemptAt: counter,
    transportReady: z.boolean(),
    expiresAt: nullableTime.describe(
      "Fixed local retention deadline in Unix milliseconds, separate from Apple credential expiry; operations and renewal never extend it.",
    ),
    retentionDays: counter.nullable(),
    retentionSource: z
      .enum([
        "interactive-consent",
        "owner-authorised-migration",
        "legacy-consent",
      ])
      .nullable(),
    lastValidatedAt: nullableTime,
    lastAppleSuccessAt: nullableTime,
    lastRenewedAt: nullableTime,
    nextRetryAt: nullableTime,
    requiredAction: z
      .enum([
        "verify-device",
        "review-terms",
        "approve-reminders",
        "retry",
        "local-retention-expired",
        "apple-sign-in",
      ])
      .nullable(),
    listDiscovery: z
      .object({
        strategy: z.literal("direct"),
        liveValidated: z.literal(false),
        experimental: z.literal(true),
      })
      .strict(),
    gates: z
      .object({
        enabled: z.boolean(),
        liveConnectionApproved: z.boolean(),
        cryptographyReviewed: z.boolean(),
        loginPolicy: z.literal("device-only-v2"),
        verificationMethod: z.literal("trusted-device-spake2"),
        passwordLocation: z.literal("browser-only"),
        sessionStorage: z.literal("owner-scoped-encrypted"),
        sessionLifetimeMs: counter.nullable(),
        socketLifetimeMs: counter,
        retentionDays: counter.nullable(),
        retentionWritesEnabled: z.boolean(),
        renewalEnabled: z.boolean(),
      })
      .strict(),
    connected: z.boolean(),
    writeEnabled: z.boolean(),
    phase: z.enum(["read-only", "read-write"]),
    capabilities: z
      .object({
        liveRead: z.boolean(),
        controlledRead: z.boolean(),
        listReminders: z.boolean(),
        allOpenReminders: z.boolean(),
        search: z.literal(false),
        create: z.boolean(),
        update: z.boolean(),
        complete: z.boolean(),
        reopen: z.boolean(),
        delete: z.boolean(),
      })
      .strict(),
    mcpTools: z.array(z.string()),
    message: z.string(),
  })
  .strict();
