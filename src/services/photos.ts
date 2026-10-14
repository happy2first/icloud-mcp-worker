import { WebClient, field, wrappedText } from "./web.ts";
import { AppError } from "../errors.ts";
const zone = { zoneName: "PrimarySync", zoneType: "REGULAR_CUSTOM_ZONE" };
const summaryKeys = [
  "masterRef",
  "filenameEnc",
  "assetDate",
  "resOriginalWidth",
  "resOriginalHeight",
  "resOriginalFileType",
];
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
  async query(limit: number, offset: number, albumId?: string) {
    // Return a bounded page even when the caller asks for 100. nextOffset is
    // based on the actual assets returned, never the requested page size.
    let pageSize = Math.min(limit, 20);
    let r: any;
    for (;;) {
      try {
        r = await this.web.ck("photos", "records/query", {
          zoneID: zone,
          desiredKeys: summaryKeys,
          query: {
            recordType: albumId
              ? "CPLContainerRelationLiveByAssetDate"
              : "CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted",
            filterBy: [
              filter("direction", "ASCENDING"),
              filter("startRank", offset),
              ...(albumId ? [filter("parentId", albumId)] : []),
            ],
          },
          resultsLimit: pageSize * 2,
        });
        break;
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          error.code !== "PROTOCOL_CHANGED" ||
          error.message !== "The Apple response exceeded the byte budget." ||
          pageSize <= 1
        )
          throw error;
        pageSize = Math.max(1, Math.floor(pageSize / 2));
      }
    }
    if (!Array.isArray(r.records))
      throw new AppError("PROTOCOL_CHANGED", "Apple omitted photos.");
    const pairs = photoPairs(r.records);
    return {
      pairs,
      records: pairs.map(photoSummary),
      nextOffset: pairs.length >= pageSize ? offset + pairs.length : null,
      complete: pairs.length < pageSize,
      pagination: "live-index-offset",
    };
  }
  async get(id: string) {
    // A rank index is for pagination, not exact record lookup. In particular,
    // a recordName filter on that index may be ignored by Apple.
    const r = await this.web.ck("photos", "records/lookup", {
      zoneID: zone,
      records: [{ recordName: id }],
      desiredKeys: [...summaryKeys, "resJPEGThumbRes", "resOriginalRes"],
    });
    const asset = r.records?.find((x: any) => x.recordName === id);
    if (!asset || asset.deleted)
      throw new AppError(
        "CONFLICT",
        "Requested photo is missing or deleted. Refresh the listing.",
        409,
      );
    if (asset.recordType !== "CPLAsset")
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple did not return a photo asset.",
      );
    const masterId = field(asset, "masterRef")?.recordName;
    if (typeof masterId !== "string" || !masterId)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted the photo master reference.",
      );
    let master = r.records?.find(
      (x: any) => x.recordName === masterId && x.recordType === "CPLMaster",
    );
    if (!master) {
      const m = await this.web.ck("photos", "records/lookup", {
        zoneID: zone,
        records: [{ recordName: masterId }],
        desiredKeys: [...summaryKeys, "resJPEGThumbRes", "resOriginalRes"],
      });
      master = m.records?.find(
        (x: any) => x.recordName === masterId && x.recordType === "CPLMaster",
      );
    }
    if (!master || master.deleted)
      throw new AppError(
        "CONFLICT",
        "Requested photo master is missing or deleted. Refresh the listing.",
        409,
      );
    return { asset, master };
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
