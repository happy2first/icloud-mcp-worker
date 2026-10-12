import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { publicError, AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { requireService } from "../services/config.ts";
import { serviceStatus } from "../services/status.ts";
import { DavClient, calendarData, contactData } from "../services/dav.ts";
import { webOperation } from "../services/web.ts";
import { NotesClient } from "../services/notes.ts";
import { PhotosClient } from "../services/photos.ts";
import { DriveClient, ROOT } from "../services/drive.ts";
import { issueDownload, download } from "../services/downloads.ts";
import { limitedBytes } from "../transport/apple-http.ts";
const id = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => !/[\x00-\x1f]/.test(s));
const url = z.string().url().max(2048);
const limit = z.number().int().min(1).max(100).default(50);
const continuation = z.string().max(8192).optional();
const offset = z.number().int().min(0).max(100000).default(0);
const date = z
  .string()
  .regex(/^\d{8}T\d{6}Z$/)
  .refine((s) => {
    const d = new Date(
      s.slice(0, 4) +
        "-" +
        s.slice(4, 6) +
        "-" +
        s.slice(6, 8) +
        "T" +
        s.slice(9, 11) +
        ":" +
        s.slice(11, 13) +
        ":" +
        s.slice(13, 15) +
        "Z",
    );
    return (
      !isNaN(d.getTime()) &&
      d
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z/, "Z") === s
    );
  });
const etag = z
  .string()
  .min(1)
  .max(512)
  .regex(/^"[^"\r\n]*"$/);
function result(value: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}
export function registerServices(
  server: McpServer,
  env: RuntimeEnv,
  owner: string,
) {
  const register = (
    name: string,
    service: any,
    schema: any,
    write: boolean,
    fn: (args: any) => Promise<any>,
    description: string,
  ) =>
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema,
        annotations: {
          readOnlyHint: !write,
          destructiveHint: write,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args: any) => {
        try {
          if (service) await requireService(env, owner, service, write);
          return result(await fn(args));
        } catch (e) {
          return {
            ...result({ error: publicError(e, crypto.randomUUID()) }),
            isError: true,
          };
        }
      },
    );
  register(
    "icloud_status",
    null,
    z.object({}).strict(),
    false,
    () => serviceStatus(env, owner),
    "Read six service settings and stored authentication state. Stored state is not proof of live Apple availability.",
  );
  for (const kind of ["calendar", "contacts"] as const) {
    register(
      kind + "_collections",
      kind,
      z.object({}).strict(),
      false,
      async () => (await DavClient.for(env, owner, kind)).discover(),
      "Discover Apple DAV collections. Use exact returned collection URLs.",
    );
    register(
      kind + "_query",
      kind,
      z
        .object({
          collection: url,
          start: date.optional(),
          end: date.optional(),
          limit,
          offset,
          query: z.string().max(256).optional(),
        })
        .strict(),
      false,
      async (a) => {
        if (kind === "calendar" && (!a.start || !a.end || a.end <= a.start))
          throw new AppError(
            "VALIDATION_ERROR",
            "Provide increasing UTC start/end times.",
          );
        const records = await (
          await DavClient.for(env, owner, kind)
        ).query(a.collection, a.start, a.end);
        const matched = records.filter(
          (x: any) =>
            !a.query ||
            String(x.data)
              .toLocaleLowerCase()
              .includes(a.query.toLocaleLowerCase()),
        );
        return {
          records: matched.slice(a.offset, a.offset + a.limit),
          nextOffset:
            a.offset + a.limit < matched.length ? a.offset + a.limit : null,
          complete: a.offset + a.limit >= matched.length,
          pagination: "bounded-DAV-response-offset",
        };
      },
      "Query a bounded DAV response and return one page. Calendar requires UTC start/end. Large address books fail explicitly at 2 MiB.",
    );
    register(
      kind + "_get",
      kind,
      z.object({ url }).strict(),
      false,
      async (a) => (await DavClient.for(env, owner, kind)).get(a.url),
      "Read exact DAV resource including ETag before modifying.",
    );
  }
  const event = z
    .object({
      title: z.string().min(1).max(512),
      start: date,
      end: date,
      description: z.string().max(16000).optional(),
      location: z.string().max(1024).optional(),
    })
    .strict()
    .refine((a) => a.end > a.start, "End must follow start.");
  const contact = z
    .object({
      name: z.string().min(1).max(512),
      email: z.string().email().max(320).optional(),
      phone: z
        .string()
        .max(80)
        .regex(/^[+0-9 ()-]+$/)
        .optional(),
    })
    .strict();
  register(
    "calendar_create",
    "calendar",
    z
      .object({ collection: url, idempotencyKey: z.string().uuid(), event })
      .strict(),
    true,
    async (a) => {
      const target =
        a.collection.replace(/\/?$/, "/") + a.idempotencyKey + ".ics";
      return (await DavClient.for(env, owner, "calendar")).put(
        target,
        calendarData({ uid: a.idempotencyKey, ...a.event }),
      );
    },
    "Create one event using If-None-Match. Retain idempotencyKey when retrying. CONFLICT means read exact URL; never retry with a new key.",
  );
  register(
    "contacts_create",
    "contacts",
    z
      .object({ collection: url, idempotencyKey: z.string().uuid(), contact })
      .strict(),
    true,
    async (a) =>
      (await DavClient.for(env, owner, "contacts")).put(
        a.collection.replace(/\/?$/, "/") + a.idempotencyKey + ".vcf",
        contactData({ uid: a.idempotencyKey, ...a.contact }),
      ),
    "Create one contact using a stable UUID and If-None-Match. A duplicate UUID returns CONFLICT; reconcile the exact resource.",
  );
  // Preserve every unknown property and nested component. Refuse ambiguous/recurring edits.
  for (const kind of ["calendar", "contacts"] as const)
    register(
      kind + "_update",
      kind,
      z
        .object({ url, etag, changes: kind === "calendar" ? event : contact })
        .strict(),
      true,
      async (a) => {
        const client = await DavClient.for(env, owner, kind),
          current = await client.get(a.url);
        if (current.etag !== a.etag)
          throw new AppError(
            "CONFLICT",
            "ETag changed. Read and review current data.",
            409,
          );
        const unfolded = current.text.replace(/\r?\n[ \t]/g, "");
        if (
          kind === "calendar" &&
          ((unfolded.match(/BEGIN:VEVENT/g) ?? []).length !== 1 ||
            /^(?:RRULE|RDATE|RECURRENCE-ID)[;:]/m.test(unfolded))
        )
          throw new AppError(
            "UNSUPPORTED_FEATURE",
            "Recurring or multi-event edits are unsupported. Use Apple Calendar.",
            409,
          );
        if (
          kind === "contacts" &&
          (unfolded.match(/BEGIN:VCARD/g) ?? []).length !== 1
        )
          throw new AppError(
            "UNSUPPORTED_FEATURE",
            "Ambiguous contact resource.",
            409,
          );
        const uid = unfolded.match(/^UID(?:;[^:]*)?:(.+)$/m)?.[1]?.trim();
        if (!uid)
          throw new AppError("PROTOCOL_CHANGED", "DAV resource has no UID.");
        const updated =
          kind === "calendar"
            ? calendarData({ uid, ...a.changes })
            : contactData({ uid, ...a.changes });
        const keys =
          kind === "calendar"
            ? [
                "SUMMARY",
                "DTSTART",
                "DTEND",
                ...(a.changes.description !== undefined ? ["DESCRIPTION"] : []),
                ...(a.changes.location !== undefined ? ["LOCATION"] : []),
              ]
            : [
                "FN",
                "N",
                ...(a.changes.email !== undefined ? ["EMAIL"] : []),
                ...(a.changes.phone !== undefined ? ["TEL"] : []),
              ];
        const additions = updated
          .replace(/\r\n[ \t]/g, "")
          .split("\r\n")
          .filter((s: string) => keys.includes(s.split(/[;:]/)[0]));
        let level = 0;
        const target = kind === "calendar" ? "VEVENT" : "VCARD",
          lines = unfolded.split(/\r?\n/).filter(Boolean),
          output: string[] = [];
        for (const line of lines) {
          if (line === "BEGIN:" + target) level = 1;
          else if (line.startsWith("BEGIN:") && level) level++;
          if (level === 1 && keys.includes(line.split(/[;:]/)[0])) continue;
          if (line === "END:" + target) output.push(...additions);
          output.push(line);
          if (line.startsWith("END:") && level) level--;
        }
        return client.put(a.url, output.join("\r\n") + "\r\n", a.etag);
      },
      "Version checked field replacement. Unknown properties and alarm components are retained. Calendar recurrence edits are refused. Contacts changes replace the supplied property, including all values for that property.",
    );
  const notes = (fn: (n: NotesClient, a: any) => Promise<any>) => (a: any) =>
    webOperation(env, owner, "notes3", (w) => fn(new NotesClient(w), a));
  register(
    "notes_folders",
    "notes",
    z.object({ continuation }).strict(),
    false,
    notes((n, a) => n.folders(a.continuation)),
    "Read one Notes folder changes page; follow continuation until complete.",
  );
  register(
    "notes_list",
    "notes",
    z.object({ limit, continuation, folderId: id.optional() }).strict(),
    false,
    notes((n, a) => n.list(a.limit, a.continuation, a.folderId)),
    "List one recents page, optionally filter by folder. Continue through every page for exhaustive results.",
  );
  register(
    "notes_search",
    "notes",
    z
      .object({ query: z.string().min(1).max(256), limit, continuation })
      .strict(),
    false,
    notes((n, a) => n.list(a.limit, a.continuation, undefined, a.query)),
    "Search titles and snippets in one recents page. Follow continuation for exhaustive title/snippet search; body search is unsupported.",
  );
  register(
    "notes_get",
    "notes",
    z.object({ id }).strict(),
    false,
    notes((n, a) => n.get(a.id)),
    "Read and decode plain text Notes Protobuf. Locked notes, attachment rendering and complex tables are unsupported.",
  );
  const photos = (fn: (p: PhotosClient, a: any) => Promise<any>) => (a: any) =>
    webOperation(env, owner, "photos", (w) => fn(new PhotosClient(w), a));
  register(
    "photos_albums",
    "photos",
    z.object({ limit, continuation }).strict(),
    false,
    photos((p, a) => p.albums(a.limit, a.continuation)),
    "Read one personal library album page. Shared libraries are unsupported.",
  );
  register(
    "photos_query",
    "photos",
    z.object({ limit, offset, albumId: id.optional() }).strict(),
    false,
    photos(async (p, a) => {
      const { pairs, ...safe } = await p.query(a.limit, a.offset, a.albumId);
      return safe;
    }),
    "Read bounded photo metadata from live index. Follow nextOffset; concurrent library edits may change offsets.",
  );
  register(
    "photos_get",
    "photos",
    z.object({ id }).strict(),
    false,
    photos(async (p, a) => {
      const { photoSummary } = await import("../services/photos.ts");
      return photoSummary(await p.get(a.id));
    }),
    "Read exact personal-library photo metadata.",
  );
  register(
    "photos_download",
    "photos",
    z
      .object({
        id,
        variant: z.enum(["thumb", "original"]).default("original"),
      })
      .strict(),
    false,
    photos(async (p, a) =>
      issueDownload(env, owner, await p.asset(a.id, a.variant)),
    ),
    "Create a five-minute authenticated stream reference. No Apple signed URL is exposed. Maximum streamed size 100 MiB.",
  );
  register(
    "photos_thumbnail",
    "photos",
    z.object({ id }).strict(),
    false,
    async (a) => {
      const ticket = await photos(async (p: any, a: any) =>
        issueDownload(env, owner, await p.asset(a.id, "thumb")),
      )(a);
      const r = await download(env, owner, ticket.resourceUri.split("://")[1]);
      const bytes = await limitedBytes(r, 1048576);
      return {
        mimeType: r.headers.get("content-type"),
        base64: toBase64(bytes),
      };
    },
    "Read specified photo thumbnail, at most 1 MiB, as base64.",
  );
  register(
    "drive_browse",
    "drive",
    z
      .object({
        id: id.default(ROOT),
        limit,
        offset,
        query: z.string().max(256).optional(),
      })
      .strict(),
    false,
    (a) =>
      webOperation(env, owner, "iclouddrive", (w) =>
        new DriveClient(w).browse(a.id, a.offset, a.limit, a.query),
      ),
    "Browse or search one bounded directory, not recursively. Large directories fail at the Apple response budget.",
  );
  register(
    "drive_download",
    "drive",
    z.object({ documentId: id }).strict(),
    false,
    (a) =>
      webOperation(env, owner, "iclouddrive", async (w) =>
        issueDownload(
          env,
          owner,
          await new DriveClient(w).download(a.documentId),
        ),
      ),
    "Create an authenticated file stream reference from DocWS document ID. Shared-owner zones unsupported.",
  );
  server.registerResource(
    "icloud-file",
    new ResourceTemplate("icloud-file://{id}", { list: undefined }),
    {
      description:
        "Owner-bound file reference; MCP reads limited to 5 MiB. Use authenticated HTTP download for larger streams.",
    },
    async (uri, variables) => {
      const r = await download(env, owner, String(variables.id));
      const bytes = await limitedBytes(r, 5 * 1024 * 1024);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType:
              r.headers.get("content-type") ?? "application/octet-stream",
            blob: toBase64(bytes),
          },
        ],
      };
    },
  );
}
function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
