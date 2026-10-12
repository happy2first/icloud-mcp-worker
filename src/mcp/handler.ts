import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { AppleConnectionService, ControlledRead } from "../auth/service.ts";
import { publicError } from "../errors.ts";
import { omitField } from "../lib/omit-field.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import {
  CreateReminderInput,
  UpdateReminderInput,
  ReminderTargetInput,
} from "../reminders/writes.ts";
import {
  ExpectedGenerationInput,
  ListsOutput,
  RemindersPageOutput,
  AllOpenOutput,
  ReminderLookupOutput,
  MutationOutput,
  ConnectionStatusOutput,
} from "./schemas.ts";

import { registerServices } from "./services.ts";
import { serviceStatus } from "../services/status.ts";
import { requireService } from "../services/config.ts";

export async function handleMCP(
  request: Request,
  env: RuntimeEnv,
  owner: string,
) {
  const server = new McpServer({
    name: "hosted-icloud-reminders",
    version: "0.1.0",
  });
  registerServices(server, env, owner);
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
  const expectedGeneration = ExpectedGenerationInput;
  const toolError = (error: unknown) => {
    const result = { error: publicError(error, crypto.randomUUID()) };
    return {
      isError: true,
      structuredContent: result,
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  };
  const liveRead = async (args: Record<string, unknown>) => {
    try {
      await requireService(env, owner, "reminders");
      const apple = new AppleConnectionService(env, owner);
      const generation =
        args.expectedGeneration ?? (await apple.status()).generation;
      const response = await apple.readForMCP(
        ControlledRead.parse({ ...args, expectedGeneration: generation }),
      );
      const page = response.result as Record<string, unknown>;
      // Return normalized reminder fields. Raw CloudKit records/traces can carry
      // signed asset links or opaque cursors and stay in the controlled UI.
      const records = (page.records as Record<string, unknown>[])
        .filter(
          (record) =>
            args.action !== "saved-lists" ||
            (!record.deleted && !record.isGroup),
        )
        .map((record) => {
          return omitField(record, "appleRecord");
        });
      const result = {
        generation: response.generation,
        records,
        complete: page.complete,
        paginationComplete: page.paginationComplete,
        continuation: page.continuation,
        pendingReason: page.pendingReason,
        ...(args.action === "reminders" ? { listId: page.listId } : {}),
        recordErrors: (page.recordErrors as Record<string, unknown>[]).map(
          (error) => ({ id: error.id, code: error.code }),
        ),
        source: page.source,
        freshness: page.freshness,
        writesEnabled: response.writesEnabled,
      };
      return {
        structuredContent: result,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (error) {
      return toolError(error);
    }
  };
  server.registerTool(
    "get_reminder_lists",
    {
      title: "Get current iCloud reminder lists",
      description:
        "Retrieve the owner's current selectable lists directly from private-zone CloudKit Lists. The server follows bounded query pagination and saves only complete encrypted snapshots. Historical scanning is not used. An unsupported or incomplete discovery returns an actionable error and preserves the previous snapshot. Shared-database list discovery is not supported; broader live completeness remains under validation. expectedGeneration pins the Apple session. No reminders are modified.",
      inputSchema: z.object({ expectedGeneration }).strict(),
      outputSchema: ListsOutput,
      annotations: readAnnotations,
    },
    (args) => liveRead({ ...args, action: "saved-lists" }),
  );
  server.registerTool(
    "get_reminders",
    {
      title: "Get current reminders from an iCloud list",
      description:
        "Verify an exact listId with a live owner-bound lookup, then fetch one current Apple reminder page without historical catalogue synchronization. Open reminders only by default; includeCompleted includes completed items. Contents are live and never cached. Follow the opaque continuation with the same listId and includeCompleted option; paginationComplete indicates the final page. A saved list ID alone is not proof of access. Use the dedicated mutation tools for reminder changes.",
      inputSchema: z
        .object({
          expectedGeneration,
          listId: z
            .string()
            .min(6)
            .max(512)
            .startsWith("List/")
            .describe(
              "Exact list ID from get_reminder_lists; do not supply the list title.",
            ),
          includeCompleted: z
            .boolean()
            .default(false)
            .describe(
              "False returns open reminders only. True includes completed history; use get_reminder for an exact completed item.",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .default(200)
            .describe(
              "Maximum Apple page size, 1–200. Use 20 or 50 if compound history pages exceed the response budget.",
            ),
          continuation: z
            .string()
            .min(1)
            .max(8192)
            .nullable()
            .optional()
            .describe(
              "Opaque next-page value from get_reminders. Omit or use null for the first page; retain listId, includeCompleted and session when continuing.",
            ),
        })
        .strict(),
      outputSchema: RemindersPageOutput,
      annotations: readAnnotations,
    },
    (args) => liveRead({ ...args, action: "reminders" }),
  );
  server.registerTool(
    "get_all_open_reminders",
    {
      title: "Get open reminders across all iCloud lists",
      description:
        "Discover selectable private-zone lists directly from CloudKit, then read current open reminders across them without historical scanning. Unsupported or incomplete list discovery fails explicitly. Shared-database list discovery is not supported. Resumptions use the operation's saved list selection without rediscovery. A bounded incomplete reminder result includes progress and a single-use, ten-minute owner/session-bound continuation; combine returned records across successful pages. complete=true requires every selected list to finish. Inspect errors before retrying and respect retryAfterSeconds. Reminder contents are never persisted.",
      inputSchema: z
        .object({
          expectedGeneration,
          continuation: z
            .string()
            .uuid()
            .nullable()
            .optional()
            .describe(
              "Single-use continuation from get_all_open_reminders; omit or use null to start. Use the newly returned token for each subsequent page and combine records.",
            ),
        })
        .strict(),
      outputSchema: AllOpenOutput,
      annotations: readAnnotations,
    },
    async (args) => {
      try {
        await requireService(env, owner, "reminders");
        const apple = new AppleConnectionService(env, owner);
        const generation =
          args.expectedGeneration ?? (await apple.status()).generation;
        const response = await apple.readAllOpenForMCP(
          generation,
          args.continuation,
        );
        const page = response.result;
        const result = {
          ...page,
          generation: response.generation,
          records: page.records.map((record) =>
            omitField(record, "appleRecord"),
          ),
          writesEnabled: response.writesEnabled,
        };
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "get_reminder",
    {
      title: "Get one current iCloud reminder",
      description:
        "Read one exact reminder ID in its list, including completed or soft-deleted items, without scanning list history. Use listId and reminderId from prior results. Returns its normalized content and current recordChangeTag, or record=null and missing=true if Apple reports it absent. Useful to reconcile WRITE_OUTCOME_UNKNOWN before considering another change. No credentials, raw Apple records or write operations are accepted.",
      inputSchema: ReminderTargetInput.omit({ recordChangeTag: true })
        .extend({ expectedGeneration })
        .strict(),
      outputSchema: ReminderLookupOutput,
      annotations: readAnnotations,
    },
    async (args) => {
      try {
        await requireService(env, owner, "reminders");
        const apple = new AppleConnectionService(env, owner);
        const generation =
          args.expectedGeneration ?? (await apple.status()).generation;
        const result = await apple.readReminderForMCP(
          generation,
          args.listId,
          args.reminderId,
        );
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const write = async (
    action: "create" | "update" | "complete" | "reopen" | "delete",
    args: Record<string, unknown>,
  ) => {
    try {
      await requireService(env, owner, "reminders", true);
      const apple = new AppleConnectionService(env, owner);
      const generation =
        args.expectedGeneration ?? (await apple.status()).generation;
      const result = await apple.mutate({
        ...args,
        action,
        expectedGeneration: generation,
      });
      return {
        structuredContent: result,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    } catch (error) {
      return toolError(error);
    }
  };
  server.registerTool(
    "create_reminder",
    {
      title: "Create an iCloud reminder",
      description:
        "Create one open reminder in listId from get_reminder_lists. Requires the authenticated owner and a ready Apple session. Supply a new UUID idempotencyKey for each distinct reminder and keep that same key and input when retrying an uncertain creation; the UUID determines the Apple record ID and prevents duplicate items. Supports title, notes, priority (0 none, 1 high, 5 medium, 9 low), flagged, dueDate with an explicit ISO 8601 offset, timeZone and allDay. An all-day reminder requires a date and time zone. No alarms, recurrence, attachments, subtasks or completion changes are created. WRITE_OUTCOME_UNKNOWN means Apple may have committed: inspect the supplied reminderId and reuse the same idempotencyKey, never create a second key for that attempt. Returned replayed=true means the matching existing item was read and no new write was sent.",
      inputSchema: CreateReminderInput.extend({ expectedGeneration }).strict(),
      outputSchema: MutationOutput("create"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => write("create", args),
  );
  server.registerTool(
    "update_reminder",
    {
      title: "Edit an open iCloud reminder",
      description:
        "Edit one open reminder using listId, reminderId and the current recordChangeTag from get_reminder or get_reminders. Requires the authenticated owner and a ready Apple session. Provide a nonempty changes object with only the fields to edit: title, notes, priority (0/1/5/9), flagged, dueDate, timeZone or allDay. Omitted fields stay unchanged; null clears a date/time zone, and clearing a date also clears its time zone and all-day marker unless explicitly overridden. Text edits replace that field's text formatting; untouched documents are preserved. Date changes on alarmed or recurring reminders are refused because their linked records require a separate protocol. Repeating identical arguments causes no additional reminder change but may return CONFLICT because the original version is stale. Read and review before constructing any new request with a fresh tag. WRITE_OUTCOME_UNKNOWN means the change may have saved: read current state first. Never automatically retry with a new version or use force-update. Use the separate complete_reminder/reopen_reminder/delete_reminder tools for state changes. Cannot move lists or edit linked records.",
      inputSchema: UpdateReminderInput.extend({ expectedGeneration }).strict(),
      outputSchema: MutationOutput("update"),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args) => write("update", args),
  );
  for (const action of ["complete", "reopen"] as const) {
    const operation =
      action === "complete"
        ? "Mark one open reminder completed"
        : action === "reopen"
          ? "Reopen one completed reminder"
          : "Delete one open or completed reminder using Apple's Deleted marker";
    server.registerTool(
      `${action}_reminder`,
      {
        title: `${action === "complete" ? "Complete" : action === "reopen" ? "Reopen" : "Delete"} an iCloud reminder`,
        description: `${operation}. Requires the authenticated owner, a ready Apple session, listId, reminderId and the latest recordChangeTag from get_reminder or get_reminders. Use get_reminder for exact completed-item lookup, or includeCompleted=true to page list history. Preserves omitted content and resolution tokens. Recurring, alarmed and nested reminders are refused. This sends one tagged record update; it does not enumerate or update children. Parent/subtask workflows are unsupported; use Apple's app for them. No parent detection or cascade support is claimed. Repeating identical arguments causes no additional reminder change but may return CONFLICT because the original version is stale. Read and review before constructing any new request with a fresh tag. WRITE_OUTCOME_UNKNOWN means Apple may have saved the action: reconcile the exact ID first. Never automatically retry with a fresh tag or force a write. Deletion is a soft, version-checked update; no hard-delete or restore tool is exposed.`,
        inputSchema: ReminderTargetInput.extend({
          expectedGeneration,
        }).strict(),
        outputSchema: MutationOutput(action),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      (args) => write(action, args),
    );
  }
  server.registerTool(
    "connection_status",
    {
      title: "Reminders connection status",
      description:
        "Report connection state, session generation and available tools without fetching Apple data. A READY session supports bounded reads; All five mutation tools are available once the authenticated owner has a ready Apple session. writeEnabled and capabilities report current availability. Mutation tools enforce owner/session and version checks and never accept Apple credentials.",
      inputSchema: z.object({}).strict(),
      outputSchema: ConnectionStatusOutput,
      annotations,
    },
    async () => {
      try {
        const result = (await serviceStatus(env, owner)).web;
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 65_536,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
