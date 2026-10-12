import { fields, getBytes } from "../crypto/protobuf.ts";
import { unb64 } from "../crypto/bytes.ts";
import { AppError } from "../errors.ts";
import { limitedBytes } from "../transport/apple-http.ts";
import { WebClient, field, wrappedText, serviceError } from "./web.ts";
export async function decodeNote(value: string) {
  const compressed = unb64(value, 262144);
  let bytes: Uint8Array | undefined;
  for (const format of ["gzip", "deflate", "deflate-raw"] as const) {
    try {
      const stream = new Blob([compressed as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new DecompressionStream(format));
      bytes = await limitedBytes(new Response(stream), 262144);
      break;
    } catch {}
  }
  if (!bytes)
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Unsupported Notes compression or body too large.",
    );
  try {
    const doc = getBytes(fields(bytes), 2)[0];
    const note = getBytes(fields(doc), 3)[0];
    const text = getBytes(fields(note), 2)[0];
    if (!text) throw new Error();
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(text),
      format: "plain-text",
      attachmentsRendered: false,
    };
  } catch {
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Unsupported Notes Protobuf. Rich attachments and locked notes are not decoded.",
    );
  }
}
const zone = { zoneName: "Notes", zoneType: "REGULAR_CUSTOM_ZONE" };
export function noteSummary(r: any) {
  return {
    id: r.recordName,
    title: wrappedText(field(r, "TitleEncrypted")),
    snippet: wrappedText(field(r, "SnippetEncrypted")),
    folderId: field(r, "Folder")?.recordName ?? null,
    modified: field(r, "ModificationDate") ?? null,
    version: r.recordChangeTag,
    deleted: !!field(r, "Deleted"),
  };
}
export class NotesClient {
  constructor(readonly web: WebClient) {}
  async folders(continuation?: string) {
    const r = await this.web.ck("notes", "changes/zone", {
      zones: [
        {
          zoneID: zone,
          ...(continuation ? { syncToken: continuation } : {}),
          desiredRecordTypes: ["Folder"],
          desiredKeys: ["TitleEncrypted", "ParentFolder", "Deleted"],
          resultsLimit: 100,
        },
      ],
    });
    const page = r.zones?.[0];
    if (!page || !Array.isArray(page.records))
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted Notes folder page.",
      );
    for (const record of page.records)
      if (record.serverErrorCode) throw serviceError(record.serverErrorCode);
    if (page.moreComing && !page.syncToken)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted the Notes continuation.",
      );
    return {
      records: page.records
        .filter(
          (x: any) =>
            x.recordType === "Folder" && !x.deleted && !field(x, "Deleted"),
        )
        .map((x: any) => ({
          id: x.recordName,
          name: wrappedText(field(x, "TitleEncrypted")),
          parentId: field(x, "ParentFolder")?.recordName ?? null,
        })),
      continuation: page.moreComing ? page.syncToken : null,
      complete: !page.moreComing,
    };
  }
  async list(
    limit: number,
    continuation?: string,
    folderId?: string,
    query?: string,
  ) {
    const r = await this.web.ck("notes", "records/query", {
      zoneID: zone,
      query: {
        recordType: "SearchIndexes",
        filterBy: [
          {
            comparator: "EQUALS",
            fieldName: "indexName",
            fieldValue: { type: "STRING", value: "recents" },
          },
        ],
        sortBy: [{ fieldName: "modTime", ascending: false }],
      },
      desiredKeys: [
        "TitleEncrypted",
        "SnippetEncrypted",
        "ModificationDate",
        "Deleted",
        "Folder",
      ],
      resultsLimit: limit,
      ...(continuation ? { continuationMarker: continuation } : {}),
    });
    if (!Array.isArray(r.records))
      throw new AppError("PROTOCOL_CHANGED", "Apple omitted Notes records.");
    return {
      records: r.records
        .filter((x: any) => !x.deleted && !field(x, "Deleted"))
        .map(noteSummary)
        .filter(
          (x: any) =>
            (!folderId || x.folderId === folderId) &&
            (!query ||
              ((x.title ?? "") + " " + (x.snippet ?? ""))
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase())),
        ),
      continuation: r.continuationMarker ?? null,
      complete: !r.continuationMarker,
      searchScope: "title-and-snippet-in-this-page",
    };
  }
  async get(id: string) {
    const r = await this.web.ck("notes", "records/lookup", {
      zoneID: zone,
      records: [{ recordName: id }],
      desiredKeys: [
        "TitleEncrypted",
        "SnippetEncrypted",
        "Folder",
        "ModificationDate",
        "TextDataEncrypted",
        "IsLocked",
        "PasswordProtected",
        "Deleted",
      ],
    });
    const note = r.records?.find((x: any) => x.recordName === id);
    if (!note || note.deleted || field(note, "Deleted"))
      throw new AppError("CONFLICT", "Note is missing or deleted.", 409);
    if (
      note.recordType === "PasswordProtectedNote" ||
      field(note, "IsLocked") ||
      field(note, "PasswordProtected") ||
      !field(note, "TextDataEncrypted")
    )
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "Locked note or missing body. Open it in Apple Notes.",
        409,
      );
    return {
      ...noteSummary(note),
      ...(await decodeNote(field(note, "TextDataEncrypted"))),
    };
  }
}
