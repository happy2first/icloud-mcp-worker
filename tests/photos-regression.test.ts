import test from "node:test";
import assert from "node:assert/strict";
import { PhotosClient, photoSummary } from "../src/services/photos.ts";
import { WebClient, prepareWebRead } from "../src/services/web.ts";
import { AppError } from "../src/errors.ts";
const id = "97BA86C0-62F6-4F89-B55A-72613843B93F";
const f = (value: unknown) => ({ value });
const asset = {
  recordType: "CPLAsset",
  recordName: id,
  recordChangeTag: "4vu3",
  fields: {
    masterRef: f({ recordName: "master-4514" }),
    assetDate: f(1746094116298),
  },
};
const master = {
  recordType: "CPLMaster",
  recordName: "master-4514",
  fields: {
    filenameEnc: f(btoa("IMG_4514.HEIC")),
    resOriginalWidth: f(5712),
    resOriginalHeight: f(4284),
    resJPEGThumbRes: f({
      downloadURL: "https://asset.icloud-content.com/thumb?secret=test",
      size: 100,
    }),
    resOriginalRes: f({
      downloadURL: "https://asset.icloud-content.com/original?secret=test",
      size: 1000,
    }),
  },
};
test("listed deep-page IDs use exact lookup and masterRef for all resource variants", async () => {
  const calls: any[] = [];
  const client = new PhotosClient({
    ck: async (_s: string, op: string, payload: any) => {
      calls.push({ op, payload });
      if (op === "records/query") return { records: [asset, master] };
      assert.equal(payload.zoneID.zoneName, "PrimarySync");
      return {
        records: payload.records[0].recordName === id ? [asset] : [master],
      };
    },
  } as unknown as WebClient);
  assert.equal((await client.query(3, 9210)).records[0].id, id);
  assert.equal(photoSummary(await client.get(id)).filename, "IMG_4514.HEIC");
  assert.match((await client.asset(id, "thumb")).url, /thumb/);
  assert.match((await client.asset(id, "original")).url, /original/);
  assert.deepEqual(
    calls.slice(1).map((c) => [c.op, c.payload.records[0].recordName]),
    Array.from({ length: 3 }, () => [
      ["records/lookup", id],
      ["records/lookup", "master-4514"],
    ]).flat(),
  );
  assert.ok(
    !JSON.stringify(photoSummary({ asset, master })).includes("secret"),
  );
});
test("lookup rejects wrong type, missing master reference and deleted assets", async () => {
  for (const record of [
    undefined,
    { ...asset, deleted: true },
    master,
    { ...asset, fields: {} },
  ]) {
    const client = new PhotosClient({
      ck: async () => ({
        records: record ? [{ ...record, recordName: id }] : [],
      }),
    } as unknown as WebClient);
    await assert.rejects(client.get(id), (e: any) =>
      ["CONFLICT", "PROTOCOL_CHANGED"].includes(e.code),
    );
  }
});
test("large photo page shrinks within byte budget and advances by actual returned assets", async () => {
  const sizes: number[] = [];
  const client = new PhotosClient({
    ck: async (_s: string, _op: string, p: any) => {
      sizes.push(p.resultsLimit);
      assert.ok(p.desiredKeys.includes("masterRef"));
      assert.ok(!p.desiredKeys.includes("resOriginalRes"));
      if (p.resultsLimit > 10)
        throw new AppError(
          "PROTOCOL_CHANGED",
          "The Apple response exceeded the byte budget.",
        );
      return {
        records: [
          master,
          ...Array.from({ length: 5 }, (_, i) => ({
            ...asset,
            recordName: `asset-${i}`,
          })),
        ],
      };
    },
  } as unknown as WebClient);
  const result = await client.query(100, 9200);
  assert.deepEqual(sizes, [40, 20, 10]);
  assert.equal(result.records.length, 5);
  assert.equal(result.nextOffset, 9205);
  assert.equal(result.complete, false);
});
test("photo page does not retry authentication or unrelated protocol errors", async () => {
  let calls = 0;
  const client = new PhotosClient({
    ck: async () => {
      calls++;
      throw new AppError("REAUTH_REQUIRED", "expired");
    },
  } as unknown as WebClient);
  await assert.rejects(client.query(100, 9200));
  assert.equal(calls, 1);
});
test("lease acquisition retries transient contention with fresh preparation, stops for reconnect", async () => {
  let calls = 0,
    waits = 0;
  const result = await prepareWebRead(
    async () => {
      calls++;
      if (calls < 3) throw new AppError("CONFLICT", "busy", 409, true);
      return "fresh-fence";
    },
    Date.now() + 40_000,
    async () => {
      waits++;
    },
  );
  assert.equal(result, "fresh-fence");
  assert.equal(waits, 2);
  calls = 0;
  await assert.rejects(
    prepareWebRead(async () => {
      calls++;
      throw new AppError("CONFLICT", "connection changed", 409, false);
    }, Date.now() + 40_000),
  );
  assert.equal(calls, 1);
});
