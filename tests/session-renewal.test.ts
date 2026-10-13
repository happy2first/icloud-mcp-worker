import test from "node:test";
import assert from "node:assert/strict";
import {
  AppleAuthHTTP,
  AppleAuthenticationError,
  AppleRetryError,
  type AuthSnapshot,
} from "../src/auth/apple/http.ts";
import { sessionCheckInterval } from "../src/auth/apple/session-renewal.ts";
import { AppError } from "../src/errors.ts";
import { appleGates } from "../src/auth/gates.ts";
import { credentialDocument } from "../src/auth/credential-page.ts";

const snapshot = (): AuthSnapshot => ({
  clientId: "synthetic-stable-client",
  headers: {
    "X-Apple-Session-Token": "synthetic-session",
    "X-Apple-TwoSV-Trust-Token": "synthetic-trust",
  },
  cookies: [
    {
      name: "X-APPLE-WEBAUTH-TOKEN",
      value: "synthetic-cookie",
      domain: "icloud.com",
      path: "/",
      secure: true,
      hostOnly: false,
      expiresAt: Date.now() - 1,
    },
    {
      name: "synthetic-unknown-expiry",
      value: "synthetic-value",
      domain: "icloud.com",
      path: "/",
      secure: true,
      hostOnly: false,
      expiresAt: null,
    },
  ],
});
const accepted = () => ({
  hsaTrustedBrowser: true,
  hsaChallengeRequired: false,
  dsInfo: { dsid: "123456789" },
  webservices: { ckdatabasews: { url: "https://p01-ckdatabasews.icloud.com" } },
});
const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

test("unsupported optional Drive endpoints cannot prevent a valid shared CloudKit session", async () => {
  const http = AppleAuthHTTP.restore(snapshot(), async () =>
    Response.json({
      ...accepted(),
      webservices: {
        ...accepted().webservices,
        drivews: { url: "https://untrusted.invalid/" },
        docws: { url: "not-a-url" },
      },
    }),
  );
  const connection = await http.validateSession("123456789");
  assert.equal(
    connection.services?.ckdatabasews,
    "https://p01-ckdatabasews.icloud.com",
  );
  assert.equal(connection.services?.drivews, undefined);
  assert.equal(connection.services?.docws, undefined);
});

test("saved validation sends JSON null, drops expired cookies and respects deletions without inventing expiry", async () => {
  const http = AppleAuthHTTP.restore(snapshot(), async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/setup/ws/1/validate");
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "null");
    assert.equal(
      new Headers(init?.headers).get("cookie"),
      "synthetic-unknown-expiry=synthetic-value",
    );
    return new Response(JSON.stringify(accepted()), {
      headers: {
        "set-cookie":
          "synthetic-unknown-expiry=; Domain=icloud.com; Path=/; Max-Age=0",
      },
    });
  });
  await http.validateSession("123456789");
  assert.deepEqual(http.snapshot().cookies, []);
  const unchanged = AppleAuthHTTP.restore(snapshot());
  assert.equal(unchanged.snapshot().cookies[1].expiresAt, null);
});

test("HTTP 200 alone, rejection indicators, malformed trusted state, identity and service URLs never validate", async () => {
  for (const body of [
    null,
    {},
    { ...accepted(), success: false },
    { ...accepted(), error: "synthetic-error" },
    { ...accepted(), serviceErrors: [{ code: "unrecognized" }] },
    { ...accepted(), hsaTrustedBrowser: "true" },
    { ...accepted(), hsaChallengeRequired: "false" },
    { ...accepted(), termsUpdateNeeded: "false" },
    { ...accepted(), dsInfo: { dsid: "999" } },
    { ...accepted(), dsInfo: { dsid: "bad" } },
    {
      ...accepted(),
      webservices: { ckdatabasews: { url: "https://not-apple.invalid" } },
    },
    {
      ...accepted(),
      webservices: {
        ckdatabasews: { url: "https://p01-ckdatabasews.icloud.com/unknown" },
      },
    },
  ]) {
    const http = AppleAuthHTTP.restore(
      snapshot(),
      async () => new Response(JSON.stringify(body)),
    );
    await assert.rejects(
      http.validateSession("123456789"),
      code("PROTOCOL_CHANGED"),
    );
  }
  for (const body of [
    { ...accepted(), valid: false },
    { ...accepted(), authenticated: false },
  ]) {
    await assert.rejects(
      AppleAuthHTTP.restore(
        snapshot(),
        async () => new Response(JSON.stringify(body)),
      ).validateSession("123456789"),
      (error: unknown) =>
        error instanceof AppleAuthenticationError && !error.confirmed,
    );
  }
});

test("saved-token setup failures are endpoint-specific and never automatically accept terms or device challenges", async () => {
  for (const [status, body, expected] of [
    [200, { ...accepted(), termsUpdateNeeded: true }, "TERMS_ACTION_REQUIRED"],
    [
      200,
      { ...accepted(), hsaChallengeRequired: true },
      "VERIFICATION_REQUIRED",
    ],
    [200, { ...accepted(), hsaTrustedBrowser: false }, "VERIFICATION_REQUIRED"],
    [412, {}, "VERIFICATION_REQUIRED"],
    [403, {}, "FORBIDDEN"],
    [503, {}, "UPSTREAM_UNAVAILABLE"],
  ] as const) {
    const http = AppleAuthHTTP.restore(
      snapshot(),
      async () => new Response(JSON.stringify(body), { status }),
    );
    await assert.rejects(http.validateSession("123456789"), code(expected));
  }
  let calls = 0;
  const revoked = AppleAuthHTTP.restore(snapshot(), async () => {
    calls++;
    return new Response("{}", { status: 401 });
  });
  await assert.rejects(
    revoked.accountLogin("123456789"),
    (error: unknown) =>
      error instanceof AppleAuthenticationError && error.confirmed,
  );
  assert.equal(calls, 1);
  const limited = AppleAuthHTTP.restore(
    snapshot(),
    async () =>
      new Response("{}", { status: 429, headers: { "retry-after": "7200" } }),
  );
  await assert.rejects(
    limited.validateSession("123456789"),
    (error: unknown) =>
      error instanceof AppleRetryError && error.retryAfterMs === 7_200_000,
  );
});

test("rollout gates are independent, consent text follows server policy and intervals are bounded", async () => {
  const approved = {
    APPLE_LOGIN_ENABLED: "true",
    LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
    APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
  };
  assert.equal(appleGates(approved).retentionWritesEnabled, true);
  assert.equal(appleGates(approved).renewalEnabled, true);
  assert.equal(appleGates({}).enabled, true);
  assert.equal(appleGates({ APPLE_LOGIN_ENABLED: "false" }).enabled, false);
  assert.equal(
    appleGates({ APPLE_SESSION_RENEWAL_ENABLED: "false" }).renewalEnabled,
    false,
  );
  const env = {
    ...approved,
    APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1",
  };
  assert.equal(appleGates(env).sessionLifetimeMs, null);
  assert.equal(appleGates(env).loginPolicy, "device-only-v2");
  assert.equal(appleGates(env).socketLifetimeMs, 180_000);
  const html = await credentialDocument(
    new Request("https://synthetic.invalid/connect/apple"),
    env,
  ).text();
  assert.ok(html.includes("本地永久保留"));
  assert.ok(!html.includes("最长保存 1 天"));
  assert.equal(sessionCheckInterval({}), 21_600_000);
  assert.equal(
    sessionCheckInterval({ APPLE_SESSION_CHECK_INTERVAL_MS: "300000" }),
    300_000,
  );
  for (const interval of ["-1", "NaN", "0", "1", "1.5", "86400001"])
    assert.throws(
      () => sessionCheckInterval({ APPLE_SESSION_CHECK_INTERVAL_MS: interval }),
      code("CONFIGURATION_REQUIRED"),
    );
});

test("Find My discovery preserves valid roots and rejects hostile optional roots", async () => {
  for (const root of [
    "https://p12-fmipweb.icloud.com",
    "https://fmipweb.icloud.com.cn",
    "https://evil.invalid",
    "https://p12-fmipweb.icloud.com/lostDevice",
  ]) {
    const http = AppleAuthHTTP.restore(snapshot(), async () =>
      Response.json({
        ...accepted(),
        webservices: { ...accepted().webservices, fmip: { url: root } },
      }),
    );
    const c = await http.validateSession("123456789");
    assert.equal(
      c.services?.fmip,
      root.includes("evil") || root.includes("lostDevice") ? undefined : root,
    );
  }
});

test("restored mainland sessions validate and request PCS using their saved region", async () => {
  const saved = { ...snapshot(), region: "cn" as const, cookies: [] };
  const requests: { url: URL; headers: Headers }[] = [];
  const http = AppleAuthHTTP.restore(saved, (async (input, init) => {
    requests.push({
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
    });
    return Response.json({
      hsaTrustedBrowser: true,
      dsInfo: { dsid: "123456789" },
      webservices: {
        ckdatabasews: { url: "https://p123-ckdatabasews.icloud.com.cn" },
        drivews: { url: "https://p123-drivews.icloud.com.cn" },
      },
    });
  }) as typeof fetch);
  await http.validateSession("123456789");
  await http.setup("/requestPCS", { appName: "photos" });
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.equal(r.url.hostname, "setup.icloud.com.cn");
    assert.equal(r.headers.get("origin"), "https://www.icloud.com.cn");
    assert.equal(r.headers.get("referer"), "https://www.icloud.com.cn/");
  }
  assert.equal(AppleAuthHTTP.restore(snapshot()).region, "international");
  assert.throws(() =>
    AppleAuthHTTP.restore({ ...saved, region: "hostile.invalid" }),
  );
});
