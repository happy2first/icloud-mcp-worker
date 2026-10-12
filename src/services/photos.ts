import { WebClient, field, wrappedText } from "./web.ts";
import { AppError } from "../errors.ts";
const zone = { zoneName: "PrimarySync", zoneType: "REGULAR_CUSTOM_ZONE" };
const filter = (name: string, value: string | number) => ({
  fieldName: name,
  comparator: "EQUALS",
  fieldValue: { type: typeof value === "number" ? "INT64" : "STRING", value },
});
export function photoPairs(records: any[]) {
  const masters = new Map(
    records
      .filter((r) => r.recordType === "CPLMaster")
      .map((r) => [r.recordName, r]),
  );
  return records
    .filter((r) => r.recordType === "CPLAsset")
    .map((asset) => {
      const master = masters.get(
        field(asset, "masterRef")?.recordName ?? asset.recordName,
      );
      if (!master)
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple omitted the photo master; no incomplete metadata is returned.",
        );
      return { asset, master };
    });
}
export function photoSummary({ asset, master }: { asset: any; master: any }) {
  return {
    id: asset.recordName,
    filename: wrappedText(field(master, "filenameEnc")),
    date: field(asset, "assetDate") ?? null,
    width: field(master, "resOriginalWidth") ?? null,
    height: field(master, "resOriginalHeight") ?? null,
    type: field(master, "resOriginalFileType") ?? null,
    version: asset.recordChangeTag,
  };
}
export class PhotosClient {
  constructor(readonly web: WebClient) {}
  async albums(limit: number, continuation?: string) {
    const r = await this.web.ck("photos", "records/query", {
      zoneID: zone,
      query: { recordType: "CPLAlbumByPositionLive" },
      resultsLimit: limit,
      ...(continuation ? { continuationMarker: continuation } : {}),
    });
    if (!Array.isArray(r.records))
      throw new AppError("PROTOCOL_CHANGED", "Apple omitted albums.");
    return {
      records: r.records
        .filter((x: any) => x.recordType === "CPLAlbum" && !x.deleted)
        .map((x: any) => ({
          id: x.recordName,
          name: wrappedText(field(x, "albumNameEnc")),
          type: field(x, "albumType"),
          parentId: field(x, "parentId"),
        })),
      continuation: r.continuationMarker ?? null,
      complete: !r.continuationMarker,
    };
  }
  async query(limit: number, offset: number, albumId?: string, id?: string) {
    const r = await this.web.ck("photos", "records/query", {
      zoneID: zone,
      query: {
        recordType: albumId
          ? "CPLContainerRelationLiveByAssetDate"
          : "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted",
        filterBy: [
          filter("direction", "ASCENDING"),
          filter("startRank", offset),
          ...(albumId ? [filter("parentId", albumId)] : []),
          ...(id ? [filter("recordName", id)] : []),
        ],
      },
      resultsLimit: limit * 2,
    });
    if (!Array.isArray(r.records))
      throw new AppError("PROTOCOL_CHANGED", "Apple omitted photos.");
    const pairs = photoPairs(r.records);
    return {
      pairs,
      records: pairs.map(photoSummary),
      nextOffset: pairs.length >= limit ? offset + pairs.length : null,
      complete: pairs.length < limit,
      pagination: "live-index-offset",
    };
  }
  async get(id: string) {
    const r = await this.query(2, 0, undefined, id);
    const pair = r.pairs.find((x) => x.asset.recordName === id);
    if (!pair)
      throw new AppError(
        "CONFLICT",
        "Photo missing from the supported library index.",
        409,
      );
    return pair;
  }
  async asset(id: string, variant: "thumb" | "original") {
    const pair = await this.get(id);
    const token = field(
      pair.master,
      variant === "thumb" ? "resJPEGThumbRes" : "resOriginalRes",
    );
    if (!token?.downloadURL)
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "This photo resource is unavailable.",
        409,
      );
    return {
      url: token.downloadURL,
      filename: wrappedText(field(pair.master, "filenameEnc")) ?? id,
      size: token.size ?? null,
    };
  }
}
