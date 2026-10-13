import { z } from "zod";
import { AppError, WriteOutcomeUnknownError } from "../errors.ts";
import { omitField } from "../lib/omit-field.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import {
  AppleSessionRepository,
  mergeSavedLists,
  type AppleSession,
  type AllOpenScan,
  type ResumeFence,
} from "../persistence/apple-sessions.ts";
import {
  CloudKitRateLimitedError,
  CloudKitRemindersClient,
  normalizeList,
  normalizeReminder,
  type CloudKitPage,
  type CloudKitRecord,
  type CloudKitLookupResult,
} from "../icloud/cloudkit.ts";
import {
  CreateReminderInput,
  UpdateReminderInput,
  ReminderTargetInput,
  buildCreateReminder,
  buildUpdateReminder,
  buildLifecycleReminder,
  matchesCreatedReminder,
  type CloudKitWriteRecord,
} from "../reminders/writes.ts";
import { decodeDocument } from "../reminders/crdt.ts";
import { AppleAuthHTTP } from "./apple/http.ts";
import { advancePcs, freshPcsCheckpoint } from "./apple/pcs.ts";
import {
  AppleSessionRenewal,
  appleRequestBudget,
  appleSuccess,
  renewalCheckpoint,
  type AppleRequestBudget,
} from "./apple/session-renewal.ts";
import {
  appleDisabledMessage,
  appleGates,
  requireAppleEnabled,
} from "./gates.ts";

export const ResumeRequest = z
  .object({
    expectedGeneration: z.number().int().nonnegative().safe(),
    restartApproval: z.boolean().optional(),
  })
  .strict();
export const ReminderMutation = z.discriminatedUnion("action", [
  CreateReminderInput.extend({
    action: z.literal("create"),
    expectedGeneration: ResumeRequest.shape.expectedGeneration,
  }).strict(),
  UpdateReminderInput.extend({
    action: z.literal("update"),
    expectedGeneration: ResumeRequest.shape.expectedGeneration,
  }).strict(),
  ReminderTargetInput.extend({
    action: z.literal("complete"),
    expectedGeneration: ResumeRequest.shape.expectedGeneration,
  }).strict(),
  ReminderTargetInput.extend({
    action: z.literal("reopen"),
    expectedGeneration: ResumeRequest.shape.expectedGeneration,
  }).strict(),
  ReminderTargetInput.extend({
    action: z.literal("delete"),
    expectedGeneration: ResumeRequest.shape.expectedGeneration,
  }).strict(),
]);
const common = {
  expectedGeneration: z.number().int().nonnegative().safe(),
  continuation: z.string().min(1).max(8192).nullable().optional(),
  limit: z.number().int().min(1).max(200).default(200),
};
const listIdSchema = z
  .string()
  .min(6)
  .max(512)
  .regex(/^List\/[^/\u0000-\u0020\u007f]+$/);
const authenticationFailure = (error: unknown) =>
  error instanceof AppError &&
  [
    "REAUTH_REQUIRED",
    "AUTH_EXPIRED",
    "TERMS_ACTION_REQUIRED",
    "VERIFICATION_REQUIRED",
  ].includes(error.code);
type OperationMode =
  | "read-only"
  | "mutation-preparation"
  | "cursor-progress"
  | "pcs"
  | "snapshot";
interface OperationStage {
  phase: OperationMode | "mutation-dispatch" | "mutation-confirmation";
  dispatch(): void;
  confirm(): void;
}
export const ControlledRead = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("discover"),
      expectedGeneration: common.expectedGeneration,
    })
    .strict(),
  z
    .object({
      action: z.literal("saved-lists"),
      expectedGeneration: common.expectedGeneration,
    })
    .strict(),
  z
    .object({
      action: z.literal("current-lists"),
      expectedGeneration: common.expectedGeneration,
    })
    .strict(),
  z
    .object({
      action: z.literal("refresh-saved-lists"),
      expectedGeneration: common.expectedGeneration,
    })
    .strict(),
  z
    .object({
      action: z.literal("probe-shared-lists"),
      expectedGeneration: common.expectedGeneration,
      listIds: z
        .array(z.string().min(6).max(512).startsWith("List/"))
        .min(1)
        .max(10),
    })
    .strict(),
  z
    .object({
      action: z.literal("lookup-lists"),
      expectedGeneration: common.expectedGeneration,
      listIds: z
        .array(z.string().min(6).max(512).startsWith("List/"))
        .min(1)
        .max(10),
      expectedZoneOwner: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reminders-batch"),
      expectedGeneration: common.expectedGeneration,
      listIds: z
        .array(listIdSchema)
        .min(1)
        .max(2)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "List IDs must be unique.",
        ),
      includeCompleted: z.boolean(),
      limit: common.limit,
    })
    .strict(),
  z
    .object({
      action: z.literal("reminders"),
      ...common,
      listId: listIdSchema,
      includeCompleted: z.boolean(),
    })
    .strict(),
]);
type PageOptions = {
  action: "reminders";
  listId: string;
  includeCompleted?: boolean;
};
interface MCPReadPage extends Record<string, unknown> {
  records: Record<string, unknown>[];
  recordErrors: { id: string | null; code: string }[];
  complete: boolean;
  paginationComplete: boolean;
  continuation: string | null;
  source: string;
  freshness: { mode: string; caughtUpAt?: number | null; retrievedAt?: number };
}
interface MCPReadResult {
  result: MCPReadPage;
  generation: number;
  liveReadValidated: boolean;
  writesEnabled: boolean;
}
function normalizeReadPage(
  page: CloudKitPage,
  options: PageOptions,
  remindersZoneOwner?: string,
) {
  if (
    page.recordErrors.some((error) =>
      [
        "AUTHENTICATION_REQUIRED",
        "NOT_AUTHENTICATED",
        "INVALID_AUTH_TOKEN",
        "AUTHENTICATION_FAILED",
      ].includes(error.serverErrorCode.toUpperCase()),
    )
  )
    throw new AppError(
      "REAUTH_REQUIRED",
      "Apple rejected the Reminders read. Reconnect your Apple account.",
      409,
    );
  const auxiliaryRecordCounts: Record<string, number> = {};
  const relatedRecords: {
    id: string;
    recordType: string;
    deleted: boolean;
    appleRecord: Record<string, unknown>;
  }[] = [];
  const records = page.records.flatMap<Record<string, unknown>>((record) => {
    const recordType =
      "recordType" in record
        ? record.recordType
        : record.recordName.split("/")[0];
    if (recordType !== "Reminder") {
      auxiliaryRecordCounts[recordType] =
        (auxiliaryRecordCounts[recordType] ?? 0) + 1;
      relatedRecords.push({
        id: record.recordName,
        recordType,
        deleted: record.deleted === true,
        appleRecord: record.raw,
      });
      return [];
    }
    if (record.deleted)
      return [
        { id: record.recordName, deleted: true, appleRecord: record.raw },
      ];
    if (!("recordType" in record))
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted the type of a returned record.",
      );
    const normalized = normalizeReminder(record, remindersZoneOwner);
    if (!options.includeCompleted && normalized.completed === true) return [];
    const { raw, ...safe } = normalized;
    return [{ ...safe, appleRecord: raw }];
  });
  return {
    records,
    recordErrors: page.recordErrors.map((error) => ({
      id: error.recordName,
      code: error.serverErrorCode,
      reason: error.reason,
      appleRecord: error.raw,
    })),
    complete: page.complete,
    paginationComplete: page.paginationComplete,
    continuation: page.continuation,
    pendingReason: page.pendingReason,
    scope: "controlled-page",
    auxiliaryRecordCounts,
    auxiliaryDetailsIncluded: true,
    relatedRecords,
    listId: options.listId,
  };
}

function writeLookupRecord(
  result: CloudKitLookupResult,
  id: string,
  allowMissing: boolean,
): CloudKitRecord | null {
  if (
    result.unresolvedRecordNames.length ||
    result.recordErrors.some((error) => error.recordName === null)
  )
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple omitted an exact write-preparation lookup result.",
    );
  const error = result.recordErrors.find((error) => error.recordName === id);
  if (error) {
    const code = error.serverErrorCode.toUpperCase();
    if (
      [
        "AUTHENTICATION_REQUIRED",
        "NOT_AUTHENTICATED",
        "INVALID_AUTH_TOKEN",
        "AUTHENTICATION_FAILED",
      ].includes(code)
    )
      throw new AppError(
        "REAUTH_REQUIRED",
        "Apple rejected the write-preparation lookup. Reconnect your Apple account.",
        409,
      );
    if (
      ["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(
        code,
      )
    )
      throw new AppError(
        "FORBIDDEN",
        "Apple denied access to the target list or reminder.",
        403,
      );
    if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(code))
      throw new CloudKitRateLimitedError(null);
    if (["UNKNOWN_ITEM", "NOT_FOUND"].includes(code)) {
      if (allowMissing) return null;
      throw new AppError(
        "CONFLICT",
        "The target list or reminder no longer exists.",
        409,
      );
    }
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple rejected the exact write-preparation lookup.",
    );
  }
  const record = result.records.find((record) => record.recordName === id);
  if (!record || !("recordType" in record) || record.deleted)
    throw new AppError(
      "CONFLICT",
      "The target list or reminder is no longer available.",
      409,
    );
  return record;
}

function verifyWriteFields(
  write: CloudKitWriteRecord,
  confirmed: CloudKitRecord,
  current: CloudKitRecord,
  owner: string,
  listId: string,
) {
  const reminder = normalizeReminder(confirmed, owner);
  const before = normalizeReminder(current, owner);
  const expectedCompleted = write.fields.Completed
    ? write.fields.Completed.value === 1
    : before.completed;
  const expectedDeleted = write.fields.Deleted
    ? write.fields.Deleted.value === 1
    : before.deleted;
  if (
    reminder.listId !== listId ||
    reminder.completed !== expectedCompleted ||
    reminder.deleted !== expectedDeleted
  )
    throw new WriteOutcomeUnknownError(write.recordName);
  const values: Record<string, unknown> = {
    Completed: Number(reminder.completed),
    Deleted: Number(reminder.deleted),
    CompletionDate:
      reminder.completedDate === null
        ? null
        : Date.parse(reminder.completedDate),
    Priority: reminder.priority,
    Flagged: reminder.flagged === null ? null : Number(reminder.flagged),
    AllDay: reminder.allDay === null ? null : Number(reminder.allDay),
    TimeZone: reminder.timeZone,
    DueDate: reminder.dueDate === null ? null : Date.parse(reminder.dueDate),
  };
  for (const [key, field] of Object.entries(write.fields)) {
    if (key === "TitleDocument" || key === "NotesDocument") {
      const expected = decodeDocument(String(field.value)).text;
      if (
        (key === "TitleDocument" ? reminder.title : (reminder.notes ?? "")) !==
        expected
      )
        throw new WriteOutcomeUnknownError(write.recordName);
    } else if (Object.hasOwn(values, key) && values[key] !== field.value)
      throw new WriteOutcomeUnknownError(write.recordName);
  }
}

export class AppleConnectionService {
  readonly env: RuntimeEnv;
  readonly owner: string;
  constructor(env: RuntimeEnv, owner: string) {
    this.env = env;
    this.owner = owner;
  }
  async status() {
    const gates = appleGates(this.env);
    const session = await new AppleSessionRepository(
      this.env,
      this.owner,
    ).status();
    const readsAvailable =
      gates.enabled &&
      session.transportReady &&
      !["apple-sign-in", "verify-device", "review-terms"].includes(
        session.requiredAction ?? "",
      ) &&
      !(session.nextRetryAt && session.nextRetryAt > Date.now());
    const connection = omitField(session, "liveReadValidated");
    const writesAvailable = readsAvailable;
    const actionMessage =
      session.requiredAction === "local-retention-expired"
        ? "The fixed local retention window expired. Sign in and verify your device again."
        : session.requiredAction === "apple-sign-in" ||
            session.requiredAction === "verify-device"
          ? "Sign in again or complete the required device verification to use this Apple connection."
          : session.requiredAction === "review-terms"
            ? "Review Apple's updated terms in the official iCloud interface."
            : session.requiredAction === "retry" &&
                session.nextRetryAt &&
                session.nextRetryAt > Date.now()
              ? "Apple or the network is temporarily unavailable. The saved connection is preserved; wait until the retry time."
              : null;
    return {
      ...connection,
      listDiscovery: {
        strategy: "direct",
        liveValidated: false,
        experimental: true,
      },
      gates,
      connected: gates.enabled && session.transportReady,
      writeEnabled: writesAvailable,
      phase: writesAvailable ? "read-write" : "read-only",
      capabilities: {
        liveRead: readsAvailable,
        controlledRead: readsAvailable,
        listReminders: readsAvailable,
        allOpenReminders: readsAvailable,
        search: false,
        create: writesAvailable,
        update: writesAvailable,
        complete: writesAvailable,
        reopen: writesAvailable,
        delete: false,
      },
      mcpTools: [
        "connection_status",
        "get_reminder_lists",
        "get_reminders",
        "get_reminder",
        "get_all_open_reminders",
        "create_reminder",
        "update_reminder",
        "complete_reminder",
        "reopen_reminder",
      ],
      message: !gates.enabled
        ? appleDisabledMessage(gates)
        : (actionMessage ??
          (session.state === "READY"
            ? "You can read, create, edit, complete, reopen reminders. Use current IDs and version tags."
            : session.state === "DEVICE_APPROVAL_PENDING"
              ? session.action === "wait-for-reminders-keys"
                ? "Apple accepted device approval. Check again shortly while Apple makes the Reminders keys available."
                : "Approve Apple's web-access prompt on your device, then check approval again."
              : "Connect your Apple account through the private Site's secure connection form.")),
    };
  }
  async disconnect() {
    return await new AppleSessionRepository(this.env, this.owner).disconnect();
  }
  async readReminderForMCP(
    expectedGeneration: number,
    listId: string,
    reminderId: string,
  ) {
    const parsed = ReminderTargetInput.omit({
      recordChangeTag: true,
    }).safeParse({ listId, reminderId });
    if (!parsed.success)
      throw new AppError(
        "VALIDATION_ERROR",
        "Provide exact canonical list and reminder IDs.",
        400,
      );
    return this.operation(
      expectedGeneration,
      "read-only",
      async (http, saved, repository, fence) => {
        const client = new CloudKitRemindersClient(
          http.http,
          saved.session.connection,
        );
        if (
          client.remindersZoneOwner === undefined &&
          !(await client.listZones()).available
        )
          throw new AppError(
            "PROTOCOL_CHANGED",
            "Apple did not return an available private Reminders zone.",
          );
        const found = await client.lookup([listId, reminderId]);
        const list = writeLookupRecord(found, listId, false)!;
        if (
          list.recordType !== "List" ||
          normalizeList(list, false).deleted ||
          normalizeList(list, false).isGroup
        )
          throw new AppError(
            "CONFLICT",
            "The requested list is unavailable.",
            409,
          );
        const item = found.records.find(
          (record) => record.recordName === reminderId,
        );
        const current =
          item?.deleted === true
            ? null
            : writeLookupRecord(found, reminderId, true);
        let record = null;
        if (current) {
          const normalized = omitField(
            normalizeReminder(current, client.remindersZoneOwner),
            "raw",
          );
          if (normalized.listId !== listId)
            throw new AppError(
              "FORBIDDEN",
              "The reminder does not belong to the requested list.",
              403,
            );
          record = normalized;
        }
        await repository.commitResume(
          fence,
          appleSuccess({
            ...saved.session,
            connection: {
              ...saved.session.connection,
              remindersZoneOwner: client.remindersZoneOwner,
            },
            auth: http.snapshot(),
          }),
          "READY",
        );
        return {
          generation: fence.generation,
          record,
          missing: record === null,
        };
      },
    );
  }
  async mutate(value: unknown) {
    // Login availability precedes parsing, storage access and Apple requests.
    requireAppleEnabled(this.env);
    const parsed = ReminderMutation.safeParse(value);
    if (!parsed.success)
      throw new AppError(
        "VALIDATION_ERROR",
        "Provide a bounded reminder mutation request with the current session generation.",
        400,
      );
    const input = parsed.data;
    const targetId =
      input.action === "create"
        ? `Reminder/${input.idempotencyKey.toUpperCase()}`
        : input.reminderId;
    let applied = false;
    try {
      return await this.operation(
        input.expectedGeneration,
        "mutation-preparation",
        async (http, saved, repository, fence, stage) => {
          const client = new CloudKitRemindersClient(
            http.http,
            saved.session.connection,
          );
          let connection = saved.session.connection;
          if (client.remindersZoneOwner === undefined) {
            const zone = await client.listZones();
            if (!zone.available)
              throw new AppError(
                "PROTOCOL_CHANGED",
                "Apple did not return an available private Reminders zone.",
              );
            connection = {
              ...connection,
              remindersZoneOwner: client.remindersZoneOwner,
            };
          }
          const owner = client.remindersZoneOwner!;
          // One exact lookup proves the list and target in this authenticated
          // private zone; a stale saved catalogue is never sufficient for a write.
          const found = await client.lookup([input.listId, targetId]);
          const list = writeLookupRecord(found, input.listId, false)!;
          if (
            list.recordType !== "List" ||
            list.deleted ||
            normalizeList(list, false).deleted === true ||
            normalizeList(list, false).isGroup === true
          )
            throw new AppError(
              "CONFLICT",
              "The target list is deleted or is a list group.",
              409,
            );
          const current = writeLookupRecord(
            found,
            targetId,
            input.action === "create",
          );
          let write: CloudKitWriteRecord;
          let confirmed: CloudKitRecord;
          let replayed = false;
          if (input.action === "create") {
            const create = omitField(
              omitField(input, "action"),
              "expectedGeneration",
            );
            write = buildCreateReminder(create);
            if (current) {
              if (
                !matchesCreatedReminder(create, current, owner) ||
                !current.recordChangeTag
              )
                throw new AppError(
                  "CONFLICT",
                  "The create ID already exists with different content or state. Read that reminder; do not reuse this key for another item.",
                  409,
                );
              confirmed = current;
              replayed = true;
            } else {
              await repository.assertWriteLease(fence);
              stage.dispatch();
              confirmed = await client.modifyReminder("create", write);
              stage.confirm();
              applied = true;
              if (!matchesCreatedReminder(create, confirmed, owner))
                throw new WriteOutcomeUnknownError(
                  targetId,
                  input.idempotencyKey,
                );
            }
          } else {
            const update = omitField(
              omitField(input, "action"),
              "expectedGeneration",
            );
            if (input.action === "update") {
              write = buildUpdateReminder(
                { ...update, changes: input.changes },
                current!,
                owner,
              );
            } else {
              write = buildLifecycleReminder(
                input.action,
                update,
                current!,
                owner,
              );
            }
            await repository.assertWriteLease(fence);
            stage.dispatch();
            confirmed = await client.modifyReminder("update", write);
            stage.confirm();
            applied = true;
            verifyWriteFields(write, confirmed, current!, owner, input.listId);
          }
          const record = omitField(normalizeReminder(confirmed, owner), "raw");
          const session = omitField(saved.session, "allOpenScan");
          // A confirmation and cookie save share the existing owner/generation
          // fence. A lost fence after dispatch reports uncertainty, not success.
          await repository.commitResume(
            fence,
            appleSuccess({ ...session, connection, auth: http.snapshot() }),
            "READY",
          );
          return {
            generation: fence.generation,
            operation: input.action,
            replayed,
            record,
            writesEnabled: true,
            ...(input.action === "create"
              ? { idempotencyKey: input.idempotencyKey }
              : {}),
          };
        },
      );
    } catch (error) {
      if (applied || error instanceof WriteOutcomeUnknownError)
        throw new WriteOutcomeUnknownError(
          targetId,
          input.action === "create" ? input.idempotencyKey : undefined,
        );
      throw error;
    }
  }
  private async operation<T>(
    expectedGeneration: number,
    mode: OperationMode,
    run: (
      http: AppleAuthHTTP,
      saved: Awaited<ReturnType<AppleSessionRepository["load"]>>,
      repository: AppleSessionRepository,
      fence: ResumeFence,
      stage: OperationStage,
    ) => Promise<T>,
    budget = appleRequestBudget(),
  ) {
    requireAppleEnabled(this.env);
    const repository = new AppleSessionRepository(this.env, this.owner);
    const renewal = new AppleSessionRenewal(this.env, repository);
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved =
        mode === "snapshot"
          ? await repository.load()
          : await renewal.ensure(expectedGeneration, budget);
      if (saved.fence.generation !== expectedGeneration)
        throw new AppError(
          "CONFLICT",
          "The Apple connection changed before this operation.",
          409,
        );
      if (budget.deadline <= Date.now())
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          "The Apple request deadline was reached.",
          503,
          true,
        );
      if (mode === "pcs" && Date.now() < saved.session.pcs.nextAttemptAt)
        throw new AppError(
          "RATE_LIMITED",
          "Wait until the displayed retry time before checking approval.",
          429,
          true,
        );
      const fence =
        mode === "pcs"
          ? await repository.claimResume(
              expectedGeneration,
              saved.fence.version,
            )
          : await repository.claimRead(expectedGeneration, saved.fence.version);
      const http = AppleAuthHTTP.restore(
        saved.session.auth,
        fetch,
        AbortSignal.timeout(budget.deadline - Date.now()),
      );
      const stage: OperationStage = {
        phase: mode,
        dispatch() {
          if (budget.deadline - Date.now() < 9000)
            throw new AppError(
              "CONFLICT",
              "The complete request budget is too short for a write. No mutation was dispatched.",
              409,
              true,
            );
          this.phase = "mutation-dispatch";
        },
        confirm() {
          this.phase = "mutation-confirmation";
        },
      };
      let recover = false;
      try {
        return await run(http, saved, repository, fence, stage);
      } catch (error) {
        const dispatched =
          stage.phase === "mutation-dispatch" ||
          stage.phase === "mutation-confirmation";
        if (error instanceof AppError && error.code === "AUTH_EXPIRED")
          await repository.invalidate(fence, "local-retention-expired");
        if (
          !dispatched &&
          error instanceof AppError &&
          error.code === "REAUTH_REQUIRED" &&
          appleGates(this.env).renewalEnabled &&
          attempt === 0 &&
          !budget.recoveryUsed
        ) {
          recover = true;
        } else if (
          !dispatched &&
          error instanceof AppError &&
          error.code === "DEVICE_APPROVAL_PENDING"
        ) {
          await repository.releaseResume(fence);
          await renewal.requireDataApproval(expectedGeneration, budget);
        }
        if (
          !recover &&
          !dispatched &&
          error instanceof AppError &&
          error.code === "REAUTH_REQUIRED" &&
          appleGates(this.env).renewalEnabled
        ) {
          const metadata = saved.session.renewal ?? renewalCheckpoint();
          const failures = Math.min(8, metadata.failures + 1);
          await repository.commitResume(
            fence,
            {
              ...saved.session,
              auth: { ...saved.session.auth, cookies: http.snapshot().cookies },
              renewal: {
                ...metadata,
                failures,
                requiredAction: "retry",
                lastErrorCode: "UPSTREAM_UNAVAILABLE",
                nextRetryAt:
                  Date.now() +
                  Math.min(3_600_000, 30_000 * 2 ** (failures - 1)),
              },
            },
            saved.state,
            saved.action ?? undefined,
          );
        }
        if (!recover) throw error;
        await repository.releaseResume(fence);
        await renewal.ensure(expectedGeneration, budget, true);
        // Cursor callbacks may have acknowledged progress. Never replay them,
        // even if authentication has now recovered.
        if (mode === "cursor-progress" || mode === "pcs")
          throw new AppError(
            "RESTART_REQUIRED",
            "Apple authentication recovered. Resume using the current continuation or approval state; this callback was not replayed.",
            409,
          );
      } finally {
        await repository.releaseResume(fence);
      }
    }
    throw new AppError(
      "REAUTH_REQUIRED",
      "Apple rejected the operation after one recovery cycle. No automatic retry remains.",
      409,
    );
  }
  async resume(expectedGeneration: number, restartApproval = false) {
    await this.operation(
      expectedGeneration,
      "pcs",
      async (http, saved, repository, fence) => {
        if (saved.session.pcs.expiresAt <= Date.now() && !restartApproval)
          throw new AppError(
            "RESTART_REQUIRED",
            "This Reminders approval attempt expired. Use Check Apple approval to start a new bounded attempt; the Apple account connection is preserved.",
            409,
          );
        const checkpoint =
          saved.session.pcs.expiresAt <= Date.now()
            ? freshPcsCheckpoint()
            : saved.session.pcs;
        const result = await advancePcs(
          http,
          saved.session.connection.dsid,
          checkpoint,
        );
        await repository.commitResume(
          fence,
          appleSuccess({
            ...saved.session,
            auth: http.snapshot(),
            pcs: result.checkpoint,
            renewal: {
              ...(saved.session.renewal ?? renewalCheckpoint()),
              requiredAction:
                result.state === "READY" ? null : "approve-reminders",
              lastErrorCode: null,
            },
          }),
          result.state,
          result.state === "DEVICE_APPROVAL_PENDING"
            ? result.action
            : undefined,
        );
      },
    );
    return this.status();
  }
  private async fetchDirectLists(http: AppleAuthHTTP, session: AppleSession) {
    const client = new CloudKitRemindersClient(http.http, session.connection);
    const found = await client.queryAllLists();
    if (!found.complete)
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "Direct list discovery did not finish within its safe limits or returned record errors. The previous snapshot is preserved. Retry a refresh; if the error persists, direct discovery is not supported for this account or exceeds the current limits.",
        409,
      );
    const now = Date.now();
    const records = found.lists.map((list) => omitField(list, "raw"));
    const savedLists = mergeSavedLists([], records, now);
    return {
      records,
      pagesRead: found.pagesRead,
      session: {
        ...session,
        connection: {
          ...session.connection,
          remindersZoneOwner: client.remindersZoneOwner,
        },
        savedLists,
        directListSnapshot: { updatedAt: now },
        auth: http.snapshot(),
      },
    };
  }
  async getCurrentLists(expectedGeneration: number): Promise<MCPReadResult> {
    return this.operation(
      expectedGeneration,
      "read-only",
      async (http, saved, repository, fence) => {
        const current = await this.fetchDirectLists(http, saved.session);
        await repository.commitResume(
          fence,
          appleSuccess(current.session),
          "READY",
        );
        return {
          result: {
            records: current.records,
            recordErrors: [],
            complete: true,
            paginationComplete: true,
            continuation: null,
            pendingReason: null,
            source: "direct-cloudkit-query",
            freshness: {
              mode: "live",
              retrievedAt: current.session.directListSnapshot.updatedAt,
            },
            listDiscovery: {
              strategy: "direct",
              experimental: true,
              retrievedAt: current.session.directListSnapshot.updatedAt,
            },
            pagesRead: current.pagesRead,
          },
          generation: fence.generation,
          liveReadValidated: false,
          writesEnabled: appleGates(this.env).enabled,
        };
      },
    );
  }
  async readForMCP(
    input: z.infer<typeof ControlledRead>,
  ): Promise<MCPReadResult> {
    if (input.action !== "saved-lists" && input.action !== "reminders")
      throw new AppError(
        "VALIDATION_ERROR",
        "This MCP read supports only lists or current reminders.",
        400,
      );
    if (input.action === "reminders") {
      const read = await this.controlledRead(input);
      return {
        ...read,
        result: {
          ...(read.result as MCPReadPage),
          freshness: { mode: "live" },
          source: "direct-known-list-query",
        },
      };
    }
    return this.getCurrentLists(input.expectedGeneration);
  }
  private async startAllOpenScan(
    expectedGeneration: number,
    continuation: string | null,
    budget: AppleRequestBudget,
  ) {
    if (continuation) {
      const repository = new AppleSessionRepository(this.env, this.owner);
      const saved = await repository.load();
      if (
        saved.fence.generation !== expectedGeneration ||
        saved.session.allOpenScan?.token !== continuation
      )
        throw new AppError(
          "CONFLICT",
          "The all-open continuation was replaced or already used.",
          409,
        );
      if (saved.session.allOpenScan.expiresAt <= Date.now()) {
        const fence = await repository.claimRead(
          expectedGeneration,
          saved.fence.version,
        );
        try {
          await repository.commitResume(
            fence,
            omitField(saved.session, "allOpenScan"),
            "READY",
          );
        } finally {
          await repository.releaseResume(fence);
        }
        throw new AppError(
          "RESTART_REQUIRED",
          "The ten-minute all-open read expired. Start a new all-open read; the Apple account is preserved.",
          409,
        );
      }
    }
    return this.operation(
      expectedGeneration,
      "cursor-progress",
      async (http, saved, repository, fence) => {
        let session = saved.session;
        if (!continuation)
          session = appleSuccess(
            (await this.fetchDirectLists(http, session)).session,
          );
        let scan: AllOpenScan;
        if (continuation) {
          if (
            !session.allOpenScan ||
            session.allOpenScan.token !== continuation
          )
            throw new AppError(
              "CONFLICT",
              "The all-open continuation was replaced or already used. Restart the all-open read.",
              409,
            );
          if (session.allOpenScan.expiresAt <= Date.now()) {
            await repository.commitResume(
              fence,
              { ...session, allOpenScan: undefined },
              "READY",
            );
            throw new AppError(
              "RESTART_REQUIRED",
              "The ten-minute all-open read expired. Start a new all-open read.",
              409,
            );
          }
          scan = { ...session.allOpenScan, token: crypto.randomUUID() };
        } else {
          const lists = session.savedLists ?? [];
          scan = {
            source: "direct-cloudkit-query",
            lists: lists.filter((list) => !list.deleted && !list.isGroup),
            token: crypto.randomUUID(),
            expiresAt: Math.min(Date.now() + 600_000, session.login.expiresAt),
            listIds: lists
              .filter((list) => !list.deleted && !list.isGroup)
              .map((list) => list.id),
            index: 0,
            cursor: null,
            seen: [],
            listPages: 0,
            totalPages: 0,
            caughtUpAt: session.directListSnapshot!.updatedAt,
          };
        }
        // Rotation is fenced before the first query, making the supplied token
        // single-use even when another instance resumes concurrently.
        await repository.commitResume(
          fence,
          { ...session, allOpenScan: scan.listIds.length ? scan : undefined },
          "READY",
        );
        return { scan, lists: scan.lists };
      },
      budget,
    );
  }
  private async allOpenPage(
    expectedGeneration: number,
    token: string,
    remainingBytes: number,
    remainingRecords: number,
    budget: AppleRequestBudget,
  ) {
    return this.operation(
      expectedGeneration,
      "cursor-progress",
      async (http, saved, repository, fence) => {
        const session = saved.session;
        const scan = session.allOpenScan;
        if (!scan || scan.token !== token)
          throw new AppError(
            "CONFLICT",
            "The all-open read changed. Restart with the latest continuation.",
            409,
          );
        if (scan.expiresAt <= Date.now()) {
          await repository.commitResume(
            fence,
            { ...session, allOpenScan: undefined },
            "READY",
          );
          throw new AppError(
            "RESTART_REQUIRED",
            "The ten-minute all-open read expired. Start a new all-open read.",
            409,
          );
        }
        if (scan.totalPages >= 10000 || scan.listPages >= 1000)
          throw new AppError(
            "UNSUPPORTED_FEATURE",
            "The all-open read reached its safe pagination limit. Start a new read.",
            409,
          );
        const next: AllOpenScan = { ...scan, token: crypto.randomUUID() };
        const listId = scan.listIds[scan.index];
        let records: Record<string, unknown>[] = [];
        let recordErrors: { id: string | null; code: string }[] = [];
        let reason: string | null = null;
        let queried = false;
        {
          const client = new CloudKitRemindersClient(
            http.http,
            session.connection,
          );
          const page = await client.queryRemindersPage({
            listId,
            includeCompleted: false,
            limit: 200,
            continuation: scan.cursor,
          });
          queried = true;
          records = page.records.flatMap((record) => {
            if (
              !("recordType" in record) ||
              record.recordType !== "Reminder" ||
              record.deleted
            )
              return [];
            const reminder = omitField(
              normalizeReminder(record, client.remindersZoneOwner),
              "raw",
            );
            return reminder.deleted || reminder.completed === true
              ? []
              : [reminder];
          });
          if (records.length > 200)
            throw new AppError(
              "PROTOCOL_CHANGED",
              "Apple returned more reminders than the all-open page budget.",
            );
          recordErrors = page.recordErrors.map((error) => ({
            id: error.recordName,
            code: error.serverErrorCode,
          }));
          if (
            recordErrors.some((error) =>
              [
                "AUTHENTICATION_REQUIRED",
                "NOT_AUTHENTICATED",
                "INVALID_AUTH_TOKEN",
                "AUTHENTICATION_FAILED",
              ].includes(error.code),
            )
          )
            throw new AppError(
              "REAUTH_REQUIRED",
              "Apple rejected the all-open reminder read. Reconnect your Apple account.",
              409,
            );
          if (recordErrors.length) records = [];
          const bytes = new TextEncoder().encode(
            JSON.stringify({ records, recordErrors }),
          ).length;
          if (bytes > 1_048_576 - 4096)
            throw new AppError(
              "UNSUPPORTED_FEATURE",
              "One current reminder page exceeds the all-open response budget. Read individual lists instead.",
              409,
            );
          if (bytes > remainingBytes || records.length > remainingRecords) {
            // Do not acknowledge a page that cannot fit. The next invocation
            // re-queries this exact input cursor rather than skipping its records.
            records = [];
            recordErrors = [];
            reason = "response-limit";
          } else if (recordErrors.length) {
            reason = "record_errors";
          } else {
            next.totalPages++;
            next.listPages++;
            if (page.continuation !== null) {
              const digest = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(page.continuation),
              );
              const fingerprint = [...new Uint8Array(digest)]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
              if (scan.seen.includes(fingerprint))
                throw new AppError(
                  "PROTOCOL_CHANGED",
                  "Apple repeated an all-open reminder continuation. Start a new read.",
                );
              next.cursor = page.continuation;
              next.seen = [...scan.seen, fingerprint];
            } else {
              next.index++;
              next.cursor = null;
              next.seen = [];
              next.listPages = 0;
            }
          }
        }
        const complete = next.index >= next.listIds.length;
        await repository.commitResume(
          fence,
          appleSuccess({
            ...session,
            allOpenScan: complete ? undefined : next,
            auth: http.snapshot(),
          }),
          "READY",
        );
        return { scan: next, records, recordErrors, reason, queried };
      },
      budget,
    );
  }
  async readAllOpenForMCP(
    expectedGeneration: number,
    continuation?: string | null,
  ) {
    const token = continuation ?? null;
    if (token !== null && !z.string().uuid().safeParse(token).success)
      throw new AppError(
        "VALIDATION_ERROR",
        "The all-open continuation is invalid.",
        400,
      );
    const budget = appleRequestBudget();
    const until = Date.now() + 20_000;
    const started = await this.startAllOpenScan(
      expectedGeneration,
      token,
      budget,
    );
    let scan = started.scan;
    const records: Record<string, unknown>[] = [];
    const recordErrors: { id: string | null; code: string }[] = [];
    const errors: {
      code: string;
      message?: string;
      listId?: string;
      retryable: boolean;
      retryAfterSeconds?: number;
    }[] = [];
    let pagesRead = 0;
    let reason: string | null = null;
    const resultFor = () => {
      const complete =
        scan.index >= scan.listIds.length &&
        recordErrors.length === 0 &&
        errors.length === 0;
      return {
        records,
        lists: started.lists,
        recordErrors,
        errors,
        complete,
        paginationComplete: complete,
        continuation: complete ? null : scan.token,
        pendingReason: complete
          ? null
          : (reason ?? (Date.now() >= until ? "deadline" : "page-budget")),
        progress: {
          listsTotal: scan.listIds.length,
          listsCompleted: scan.index,
          pagesRead,
          totalPages: scan.totalPages,
        },
        source: "direct-cloudkit-query",
        freshness: { mode: "live", retrievedAt: scan.caughtUpAt },
        scope: "all-open-reminders",
      };
    };
    let bytesUsed =
      new TextEncoder().encode(JSON.stringify(resultFor())).length + 4096;
    if (bytesUsed > 1_048_576)
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "The saved list summaries exceed the all-open response budget. Read individual lists instead.",
        409,
      );
    while (
      scan.index < scan.listIds.length &&
      pagesRead < 20 &&
      records.length < 5000 &&
      Date.now() < until
    ) {
      try {
        const page = await this.allOpenPage(
          expectedGeneration,
          scan.token,
          1_048_576 - bytesUsed,
          5000 - records.length,
          budget,
        );
        scan = page.scan;
        if (page.queried) pagesRead++;
        records.push(...page.records);
        recordErrors.push(...page.recordErrors);
        bytesUsed += new TextEncoder().encode(
          JSON.stringify({
            records: page.records,
            recordErrors: page.recordErrors,
          }),
        ).length;
        if (page.reason) {
          reason = page.reason;
          break;
        }
      } catch (error) {
        if (
          error instanceof AppError &&
          [
            "RATE_LIMITED",
            "UPSTREAM_UNAVAILABLE",
            "CONFLICT",
            "PROTOCOL_CHANGED",
            "UNSUPPORTED_FEATURE",
          ].includes(error.code)
        ) {
          // A failed query never acknowledges a page. Expose the rotated token
          // only after checking it is still the owner's current saved scan.
          const current = await new AppleSessionRepository(
            this.env,
            this.owner,
          ).load();
          if (
            current.fence.generation !== expectedGeneration ||
            current.session.allOpenScan?.token !== scan.token ||
            current.session.allOpenScan.expiresAt <= Date.now()
          )
            throw new AppError(
              "CONFLICT",
              "The all-open scan changed during this request. Start a new all-open read.",
              409,
            );
          const retryAfterSeconds =
            error instanceof CloudKitRateLimitedError
              ? error.retryAfterSeconds
              : null;
          errors.push({
            code: error.code,
            message: error.message,
            listId: scan.listIds[scan.index],
            retryable: !["PROTOCOL_CHANGED", "UNSUPPORTED_FEATURE"].includes(
              error.code,
            ),
            ...(retryAfterSeconds !== null &&
            Number.isFinite(retryAfterSeconds) &&
            retryAfterSeconds >= 0
              ? { retryAfterSeconds }
              : {}),
          });
          reason = "read_error";
          break;
        }
        throw error;
      }
    }
    return {
      result: resultFor(),
      generation: expectedGeneration,
      liveReadValidated: false,
      writesEnabled: appleGates(this.env).enabled,
    };
  }
  private async authorizeLists(client: CloudKitRemindersClient, ids: string[]) {
    if (
      client.remindersZoneOwner === undefined &&
      !(await client.listZones()).available
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple did not return an available private Reminders zone.",
      );
    const found = await client.lookup(ids, true);
    for (const error of found.recordErrors) {
      if (
        [
          "AUTHENTICATION_REQUIRED",
          "NOT_AUTHENTICATED",
          "INVALID_AUTH_TOKEN",
          "AUTHENTICATION_FAILED",
        ].includes(error.serverErrorCode.toUpperCase())
      )
        throw new AppError(
          "REAUTH_REQUIRED",
          "Apple rejected the list lookup. Reconnect your Apple account.",
          409,
        );
      if (
        ["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(
          error.serverErrorCode.toUpperCase(),
        )
      )
        throw new AppError(
          "FORBIDDEN",
          "Apple denied access to the requested list.",
          403,
        );
      if (
        ["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(
          error.serverErrorCode.toUpperCase(),
        )
      )
        throw new CloudKitRateLimitedError(null);
      if (
        ["UNKNOWN_ITEM", "NOT_FOUND"].includes(
          error.serverErrorCode.toUpperCase(),
        )
      )
        throw new AppError(
          "FORBIDDEN",
          "The requested list is not accessible.",
          403,
        );
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple could not verify the requested list.",
      );
    }
    if (!found.complete || found.records.length !== ids.length)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted a requested list authorization result.",
      );
    for (const record of found.records) {
      if (
        !("recordType" in record) ||
        record.recordType !== "List" ||
        record.deleted
      )
        throw new AppError(
          "FORBIDDEN",
          "The requested list is unavailable.",
          403,
        );
      const list = normalizeList(record, false);
      if (list.deleted || list.isGroup)
        throw new AppError(
          "FORBIDDEN",
          "The requested list is unavailable or is a group.",
          403,
        );
    }
  }
  async read(input: z.infer<typeof ControlledRead>) {
    if (input.action === "current-lists")
      return this.getCurrentLists(input.expectedGeneration);
    return this.controlledRead(input);
  }
  private async controlledRead(input: z.infer<typeof ControlledRead>) {
    return this.operation(
      input.expectedGeneration,
      input.action === "saved-lists"
        ? "snapshot"
        : input.action === "reminders" && input.continuation
          ? "cursor-progress"
          : "read-only",
      async (http, saved, repository, fence) => {
        const client = new CloudKitRemindersClient(
          http.http,
          saved.session.connection,
        );
        let result: unknown;
        let connection = saved.session.connection;
        let savedLists = saved.session.savedLists ?? [];
        if (input.action === "current-lists")
          throw new AppError(
            "VALIDATION_ERROR",
            "Use current list discovery.",
            400,
          );
        if (input.action === "saved-lists") {
          result = {
            records: savedLists,
            recordErrors: [],
            complete: true,
            paginationComplete: true,
            continuation: null,
            pendingReason: null,
            scope: "saved-list-snapshot",
            auxiliaryRecordCounts: {},
            auxiliaryDetailsIncluded: false,
            listDiscovery: {
              strategy: "direct",
              experimental: true,
              retrievedAt: saved.session.directListSnapshot?.updatedAt ?? null,
            },
          };
        } else if (input.action === "discover") {
          const discovered = await client.listZones();
          if (client.remindersZoneOwner !== undefined)
            connection = {
              ...connection,
              remindersZoneOwner: client.remindersZoneOwner,
            };
          // Do not expose unrelated private zone names or arbitrary Apple fields.
          result = {
            available: discovered.available,
            complete: discovered.complete,
            zoneDiagnostics: discovered.zones.map((zone) => ({
              category:
                zone.zoneID.zoneName === "Reminders"
                  ? "primary-reminders"
                  : zone.zoneID.zoneName.toLowerCase().includes("reminder")
                    ? "other-reminders"
                    : "other",
              type: zone.zoneID.zoneType ?? null,
              matchesPrimaryOwner:
                (zone.zoneID.ownerRecordName ?? "__defaultOwner__") ===
                client.remindersZoneOwner,
              deleted: zone.deleted,
            })),
            remindersZone: discovered.remindersZone
              ? {
                  zoneID: {
                    zoneName: discovered.remindersZone.zoneID.zoneName,
                    ...(discovered.remindersZone.zoneID.zoneType
                      ? { zoneType: discovered.remindersZone.zoneID.zoneType }
                      : {}),
                  },
                  deleted: discovered.remindersZone.deleted,
                }
              : null,
          };
        } else if (input.action === "probe-shared-lists") {
          result = await client.probeSharedLists(input.listIds);
        } else if (
          input.action === "lookup-lists" ||
          input.action === "refresh-saved-lists"
        ) {
          if (client.remindersZoneOwner === undefined) {
            const discovered = await client.listZones();
            if (!discovered.available)
              throw new AppError(
                "PROTOCOL_CHANGED",
                "Apple did not return an available private Reminders zone.",
              );
            connection = {
              ...connection,
              remindersZoneOwner: client.remindersZoneOwner,
            };
          }
          if (
            input.action === "lookup-lists" &&
            input.expectedZoneOwner !== undefined &&
            input.expectedZoneOwner !== client.remindersZoneOwner
          )
            throw new AppError(
              "FORBIDDEN",
              "The supplied zone owner does not match this Apple session.",
              403,
            );
          const listIds =
            input.action === "lookup-lists"
              ? input.listIds
              : savedLists.slice(0, 100).map((list) => list.id);
          if (!listIds.length)
            throw new AppError(
              "VALIDATION_ERROR",
              "There are no saved lists to refresh.",
              400,
            );
          const found = await client.lookup(listIds, true);
          if (found.unresolvedRecordNames.length)
            throw new AppError(
              "PROTOCOL_CHANGED",
              "Apple omitted a requested list from its lookup response.",
            );
          const records = [
            ...found.records.map((record) => {
              if (record.deleted)
                return { id: record.recordName, deleted: true };
              if (!("recordType" in record) || record.recordType !== "List")
                throw new AppError(
                  "PROTOCOL_CHANGED",
                  "Apple returned an unexpected record in the list lookup.",
                );
              return omitField(normalizeList(record, false), "raw");
            }),
            ...found.recordErrors.flatMap((error) =>
              error.recordName &&
              ["UNKNOWN_ITEM", "NOT_FOUND"].includes(error.serverErrorCode)
                ? [{ id: error.recordName, deleted: true }]
                : [],
            ),
          ];
          savedLists = mergeSavedLists(savedLists, records);
          result = {
            records,
            recordErrors: found.recordErrors.map((error) => ({
              id: error.recordName,
              code: error.serverErrorCode,
            })),
            complete: found.complete,
            paginationComplete: true,
            continuation: null,
            pendingReason: found.complete ? null : "record_errors",
            scope: "controlled-lookup",
            auxiliaryRecordCounts: {},
            auxiliaryDetailsIncluded: false,
            unrefreshedLists:
              input.action === "refresh-saved-lists"
                ? Math.max(0, saved.session.savedLists!.length - listIds.length)
                : 0,
          };
        } else if (input.action === "reminders-batch") {
          // Drain every request while this operation still owns the lease and jar.
          // Prefer authentication recovery over an ordinary upstream error, but
          // do not equate a resource rejection with confirmed account revocation.
          await this.authorizeLists(client, input.listIds);
          connection = {
            ...connection,
            remindersZoneOwner: client.remindersZoneOwner,
          };
          const pages = await Promise.allSettled(
            input.listIds.map((listId) =>
              client.queryRemindersPage({
                listId,
                includeCompleted: input.includeCompleted,
                limit: input.limit,
              }),
            ),
          );
          const failures = pages.filter(
            (page): page is PromiseRejectedResult => page.status === "rejected",
          );
          if (failures.length)
            throw (
              failures.find((page) => authenticationFailure(page.reason)) ??
              failures[0]
            ).reason;
          result = {
            pages: pages.map((page, index) => {
              if (page.status !== "fulfilled")
                throw new AppError(
                  "PROTOCOL_CHANGED",
                  "Apple did not return a requested reminders page.",
                );
              return normalizeReadPage(
                page.value,
                {
                  action: "reminders",
                  listId: input.listIds[index],
                  includeCompleted: input.includeCompleted,
                },
                client.remindersZoneOwner,
              );
            }),
          };
        } else {
          if (input.action === "reminders")
            await this.authorizeLists(client, [input.listId]);
          if (client.remindersZoneOwner !== undefined)
            connection = {
              ...connection,
              remindersZoneOwner: client.remindersZoneOwner,
            };
          const page = await client.queryRemindersPage({
            listId: input.listId,
            includeCompleted: input.includeCompleted,
            continuation: input.continuation,
            limit: input.limit,
          });
          const normalized = normalizeReadPage(
            page,
            input,
            client.remindersZoneOwner,
          );
          result = normalized;
        }
        // Cookie changes and the response share a generation/version fence. A
        // concurrent disconnect prevents both the save and a successful response.
        const session = {
          ...saved.session,
          connection,
          savedLists,
          auth: http.snapshot(),
        };
        await repository.commitResume(
          fence,
          input.action === "saved-lists" ? session : appleSuccess(session),
          "READY",
        );
        result = {
          ...(result as Record<string, unknown>),
          requestTrace: client.readTrace,
        };
        return {
          result,
          generation: fence.generation,
          liveReadValidated: false,
          writesEnabled: appleGates(this.env).enabled,
        };
      },
    );
  }
}
