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
  assert.equal(appleGates(approved).retentionWritesEnabled, false);
  assert.equal(appleGates(approved).renewalEnabled, false);
  const env = {
    ...approved,
    APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1",
  };
  assert.equal(appleGates(env).sessionLifetimeMs, 2_592_000_000);
  assert.equal(appleGates(env).loginPolicy, "device-only-v2");
  assert.equal(appleGates(env).socketLifetimeMs, 180_000);
  const html = await credentialDocument(
    new Request("https://synthetic.invalid/connect/apple"),
    env,
  ).text();
  assert.ok(html.includes("at most 30 days"));
  assert.ok(!html.includes("at most 24 hours"));
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
