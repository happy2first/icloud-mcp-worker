import { WebClient } from "./web.ts";
import { AppError } from "../errors.ts";
export const ROOT = "FOLDER::com.apple.CloudDocs::root";
export class DriveClient {
  constructor(readonly web: WebClient) {}
  async browse(id: string = ROOT, offset = 0, limit = 100, query?: string) {
    const r = await this.web.request(
      "drivews",
      "/retrieveItemDetailsInFolders",
      [{ drivewsid: id, partialData: false }],
    );
    const node = r?.[0];
    if (
      !node ||
      (node.status && node.status !== "OK") ||
      !Array.isArray(node.items)
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted the directory or directory exceeds the bounded response budget.",
      );
    const items = node.items.filter(
      (x: any) =>
        !query ||
        String(x.name ?? "")
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
    );
    return {
      id,
      records: items.slice(offset, offset + limit).map((x: any) => ({
        id: x.drivewsid,
        documentId: x.docwsid ?? null,
        name: x.name,
        extension: x.extension ?? null,
        type: x.type,
        size: x.size ?? null,
        version: x.etag ?? null,
        modified: x.dateModified ?? null,
      })),
      nextOffset: offset + limit < items.length ? offset + limit : null,
      complete: offset + limit >= items.length,
      pagination: "bounded-directory-offset",
      searchScope: "this-directory",
    };
  }
  async download(id: string) {
    const r = await this.web.request(
      "docws",
      "/ws/com.apple.CloudDocs/download/by_id?document_id=" +
        encodeURIComponent(id),
    );
    const token = r.data_token ?? r.package_token;
    if (!token?.url)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted the Drive download token.",
      );
    return { url: token.url, filename: "icloud-drive-file" };
  }
}
