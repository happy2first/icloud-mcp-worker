import test from "node:test";
import assert from "node:assert/strict";
import { FindMyClient } from "../src/services/findmy.ts";
import { WebClient } from "../src/services/web.ts";
import { AppleAuthHTTP } from "../src/auth/apple/http.ts";
import { AppleHTTP, validatedAppleURL } from "../src/transport/apple-http.ts";
import { AppError } from "../src/errors.ts";
const device = (id = "self", extra = {}) => ({
  id,
  name: id,
  deviceClass: "iPhone",
  deviceStatus: "200",
  batteryLevel: 0.7,
  prsId: null,
  features: { LOC: true, SND: true },
  location: {
    latitude: 22.2,
    longitude: 113.5,
    timeStamp: 1000,
    isOld: false,
    horizontalAccuracy: 20,
  },
  ...extra,
});
const body = (content: unknown[], membersInfo = {}) => ({
  serverContext: { prsId: "owner", theftLoss: "private" },
  userInfo: { firstName: "Owner", hasMembers: true, membersInfo },
  content,
});
function fake(responses: unknown[]) {
  const calls: any[] = [];
  const web = {
    request: async (service: string, path: string, payload?: unknown) => {
      calls.push({ service, path, payload });
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return {
    client: new FindMyClient(
      web,
      async () => {},
      () => 2000,
    ),
    calls,
  };
}
test("own/family devices merge by ID, resolve prsId, preserve status and bounded LOADING", async () => {
  const { client, calls } = fake([
    body([device()], {
      member: { firstName: "Family", deviceFetchStatus: "LOADING" },
    }),
    body(
      [
        device("family", { prsId: "member" }),
        device("self", { batteryLevel: 0.5 }),
      ],
      { member: { firstName: "Family", deviceFetchStatus: "DONE" } },
    ),
  ]);
  const r = await client.list();
  assert.equal(r.devices.length, 2);
  assert.equal(r.devices[0].batteryLevel, 0.5);
  assert.equal(r.devices[1].owner.name, "Family");
  assert.equal(r.devices[1].owner.isSelf, false);
  assert.equal(r.familyComplete, true);
  assert.equal(calls[0].payload.clientContext.fmly, true);
  assert.equal(calls[1].payload.serverContext.theftLoss, null);
  assert.equal(calls[1].payload.clientContext.shouldLocate, undefined);
});
test("stuck family LOADING stops after no progress and reports partial result", async () => {
  const { client, calls } = fake([
    body([device()], { member: { deviceFetchStatus: "LOADING" } }),
  ]);
  const r = await client.list();
  assert.equal(calls.length, 2);
  assert.equal(r.familyLoading, true);
  assert.equal(r.familyComplete, false);
});
test("location refresh acceptance does not imply a fresh fix", async () => {
  const { client, calls } = fake([body([device()])]);
  const r = await client.getLocation("self");
  assert.equal(r.refreshAccepted, true);
  assert.equal(r.newLocationObtained, false);
  assert.equal(r.status, "LOCATION_TIMEOUT");
  assert.equal(r.location?.timestamp, 1000);
  assert.equal(calls[1].payload.clientContext.selectedDevice, "self");
  assert.equal(calls[1].payload.clientContext.shouldLocate, true);
});
test("only a newer nonhistorical timestamp after this request counts as a new fix", async () => {
  const { client } = fake([
    body([device()]),
    body([
      device("self", {
        location: {
          latitude: 22,
          longitude: 113,
          timeStamp: 2100,
          isOld: false,
        },
      }),
    ]),
  ]);
  const r = await client.getLocation("self");
  assert.equal(r.status, "NEW_LOCATION");
  assert.equal(r.newLocationObtained, true);
});
test("historical flag, offline and denied location are reported without fabricated positions", async () => {
  for (const [extra, status] of [
    [{ deviceStatus: "203" }, "DEVICE_OFFLINE"],
    [{ features: { LOC: false, SND: true } }, "NO_LOCATION_PERMISSION"],
    [{ locationEnabled: false }, "NO_LOCATION_PERMISSION"],
  ] as const) {
    const { client, calls } = fake([body([device("self", extra)])]);
    const r = await client.getLocation("self");
    assert.equal(r.status, status);
    if (status === "NO_LOCATION_PERMISSION") {
      assert.equal(r.location, null);
      assert.equal(calls.length, 1);
    }
  }
  const { client } = fake([
    body([device()]),
    body([
      device("self", {
        location: {
          latitude: 22,
          longitude: 113,
          timeStamp: 2100,
          isOld: true,
        },
      }),
    ]),
  ]);
  assert.equal((await client.getLocation("self")).newLocationObtained, false);
});
test("last-reported reads do not send shouldLocate; unknown IDs do not trigger actions", async () => {
  const { client, calls } = fake([body([device()])]);
  assert.equal(
    (await client.getLocation("self", false)).refreshAccepted,
    false,
  );
  assert.equal(calls.length, 1);
  await assert.rejects(
    client.getLocation("stranger"),
    (e: any) => e.code === "CONFLICT",
  );
  assert.ok(calls.every((c) => !c.payload.clientContext.shouldLocate));
});
test("sound requires confirmation, sound capability and accessible device; no replay on timeout", async () => {
  const { client, calls } = fake([body([device()]), new Error("network")]);
  await assert.rejects(client.playSound("self", false));
  assert.equal(calls.length, 0);
  await assert.rejects(
    client.playSound("self", true),
    (e: any) => e.code === "WRITE_OUTCOME_UNKNOWN",
  );
  assert.equal(calls.filter((c) => c.path.endsWith("playSound")).length, 1);
  assert.equal(calls[1].payload.clientContext.fmly, true);
  const good = fake([body([device()]), { statusCode: "200" }]);
  assert.equal(
    (await good.client.playSound("self", true)).playbackConfirmed,
    false,
  );
  const unavailable = fake([
    body([device("self", { features: { SND: false } })]),
  ]);
  await assert.rejects(unavailable.client.playSound("self", true));
});
test("Find My transport only permits three supported endpoints and rejects erase/lost mode", () => {
  for (const endpoint of ["initClient", "refreshClient", "playSound"])
    assert.ok(
      validatedAppleURL(
        `https://p12-fmipweb.icloud.com/fmipservice/client/web/${endpoint}`,
        true,
      ),
    );
  for (const endpoint of [
    "lostDevice",
    "remoteWipeWithUserAuth",
    "sendMessage",
  ])
    assert.throws(() =>
      validatedAppleURL(
        `https://p12-fmipweb.icloud.com/fmipservice/client/web/${endpoint}`,
        true,
      ),
    );
  assert.throws(() =>
    validatedAppleURL(
      "https://evil.example/fmipservice/client/web/initClient",
      true,
    ),
  );
});
test("expired sessions and invalid envelopes remain actionable errors", async () => {
  const { client } = fake([new AppError("REAUTH_REQUIRED", "Reconnect", 409)]);
  await assert.rejects(client.list(), (e: any) => e.code === "REAUTH_REQUIRED");
  await assert.rejects(
    fake([{ content: "changed" }]).client.list(),
    (e: any) => e.code === "PROTOCOL_CHANGED",
  );
});
test("real HTTP adapter sends saved Apple cookie and surfaces auth rejection", async () => {
  let status = 200;
  const http = new AppleAuthHTTP(
    new AppleHTTP(undefined, async (url, init) => {
      assert.equal(new URL(String(url)).hostname, "p12-fmipweb.icloud.com");
      assert.equal(
        new Headers(init?.headers).get("cookie"),
        "X-APPLE-WEBAUTH-TOKEN=synthetic",
      );
      return Response.json(body([device()]), { status });
    }),
  );
  http.http.jar.set(
    "X-APPLE-WEBAUTH-TOKEN=synthetic; Domain=.icloud.com; Path=/; Secure",
    new URL("https://www.icloud.com"),
  );
  const web = new WebClient(http, {
    connection: {
      dsid: "1",
      clientId: "test",
      clientBuildNumber: "1",
      clientMasteringNumber: "1",
      services: { fmip: "https://p12-fmipweb.icloud.com" },
    },
  } as any);
  assert.equal((await new FindMyClient(web).list()).devices.length, 1);
  status = 421;
  await assert.rejects(
    new FindMyClient(web).list(),
    (e: any) => e.code === "REAUTH_REQUIRED",
  );
});
