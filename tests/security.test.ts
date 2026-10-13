import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { Envelopes, envelopesFromSecret } from "../src/crypto/envelopes.ts";
import { b64, utf8 } from "../src/crypto/bytes.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { AppleHTTP, validatedAppleURL } from "../src/transport/apple-http.ts";
import { validatedPushURL } from "../src/transport/apple-push.ts";
import { decodeDocument } from "../src/reminders/crdt.ts";
import { applicationRoute } from "../src/api/router.ts";
import { publicError } from "../src/errors.ts";

test("single Secret chooses the key automatically and preserves existing encrypted records", async () => {
  const storageFailure = publicError(
    new Error("D1_ERROR: no such table: synthetic-private-detail"),
    "synthetic-request",
  );
  assert.equal(storageFailure.code, "STORAGE_UNAVAILABLE");
  assert.ok(!storageFailure.message.includes("private-detail"));
  assert.throws(
    () => envelopesFromSecret(undefined),
    (error: any) =>
      error.code === "CONFIGURATION_REQUIRED" &&
      error.message === "The runtime Secret ENCRYPTION_KEYS_JSON is missing.",
  );
  const secret = b64(crypto.getRandomValues(new Uint8Array(32)));
  const old = new Envelopes("v1", { v1: secret });
  const context = {
    ownerId: "first",
    accountId: "apple",
    generation: 1,
    recordId: "session",
    schemaVersion: 1 as const,
  };
  const envelope = await old.encrypt({ token: "synthetic" }, context);
  const automatic = envelopesFromSecret(JSON.stringify({ v1: secret }));
  assert.deepEqual(await automatic.decrypt(envelope, context), {
    token: "synthetic",
  });
  const plain = envelopesFromSecret("\n" + secret + "\n");
  assert.deepEqual(await plain.decrypt(envelope, context), {
    token: "synthetic",
  });
  const namedLegacy = new Envelopes("old-custom-name", {
    "old-custom-name": secret,
  });
  assert.deepEqual(
    await plain.decrypt(
      await namedLegacy.encrypt({ token: "legacy" }, context),
      context,
    ),
    { token: "legacy" },
  );
  const fresh = await plain.encrypt({ token: "new" }, context);
  assert.deepEqual(await envelopesFromSecret(secret).decrypt(fresh, context), {
    token: "new",
  });
  await assert.rejects(plain.decrypt(fresh, { ...context, ownerId: "second" }));
  await assert.rejects(
    automatic.decrypt(envelope, { ...context, ownerId: "second" }),
  );
  for (const invalid of [
    undefined,
    "invalid",
    "",
    JSON.stringify(secret),
    b64(crypto.getRandomValues(new Uint8Array(31))),
    b64(crypto.getRandomValues(new Uint8Array(33))),
    secret.replace("=", ""),
    "{}",
    "null",
    "[]",
    '{"v1":"short"}',
    JSON.stringify({ v1: secret, v2: secret }),
  ])
    assert.throws(
      () => envelopesFromSecret(invalid),
      (error: any) => error.code === "CONFIGURATION_REQUIRED",
    );
});

test("AES-GCM binds owner, account, generation and record and supports key overlap", async () => {
  const old = b64(crypto.getRandomValues(new Uint8Array(32)));
  const fresh = b64(crypto.getRandomValues(new Uint8Array(32)));
  const context = {
    ownerId: "synthetic-owner",
    accountId: "synthetic-account",
    generation: 1,
    recordId: "record-1",
    schemaVersion: 1 as const,
  };
  const original = new Envelopes("old", { old });
  const rotated = new Envelopes("new", { old, new: fresh });
  const payload = { title: "<script>malicious instructions</script>" };
  const envelope = await original.encrypt(payload, context);
  assert.ok(!JSON.stringify(envelope).includes(payload.title));
  assert.deepEqual(await rotated.decrypt(envelope, context), payload);
  for (const changed of [
    { ownerId: "other" },
    { accountId: "other" },
    { generation: 2 },
    { recordId: "other" },
  ])
    await assert.rejects(rotated.decrypt(envelope, { ...context, ...changed }));
  const corrupted = {
    ...envelope,
    ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA",
  };
  await assert.rejects(rotated.decrypt(corrupted, context));
  const migrated = await rotated.encrypt(payload, context);
  assert.equal(migrated.keyId, "new");
  assert.notEqual(migrated.iv, envelope.iv);
  await assert.rejects(
    new Envelopes("new", { new: fresh }).decrypt(envelope, context),
  );
});

test("cookie jar handles separate Expires, paths, host-only scope and deletion", () => {
  const jar = new CookieJar();
  const url = new URL("https://idmsa.apple.com/a/start");
  const now = 1_000_000;
  jar.set("session=host; Secure; Path=/", url, now);
  jar.set(
    "session=narrow; Path=/a; Secure; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
    url,
    now,
  );
  jar.set("domain=apple; Domain=.apple.com; Path=/; Secure", url, now);
  assert.equal(
    jar.header(new URL("https://idmsa.apple.com/a/next"), now),
    "session=narrow; session=host; domain=apple",
  );
  assert.equal(jar.header(new URL("https://setup.icloud.com/a/next"), now), "");
  assert.equal(
    jar.header(new URL("https://www.apple.com/"), now),
    "domain=apple",
  );
  assert.equal(jar.header(new URL("http://idmsa.apple.com/a/next"), now), "");
  jar.set(
    "session=gone; Path=/a; Max-Age=0; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
    url,
    now,
  );
  jar.set(
    "expiry=short; Path=/; Max-Age=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
    url,
    now,
  );
  assert.ok(!jar.header(url, now + 2000).includes("expiry="));
  assert.ok(!jar.header(url, now).includes("narrow"));
  jar.set("publicsuffix=bad; Domain=com", url, now);
  jar.set("other=bad; Domain=icloud.com", url, now);
  assert.ok(!jar.header(url, now).includes("bad"));
});

test("Apple transport rejects SSRF and credential-bearing cross-origin redirects", async () => {
  for (const url of [
    "http://idmsa.apple.com/",
    "https://idmsa.apple.com.evil.test/",
    "https://idmsa.apple.com@evil.test/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://idmsa.apple.com:444/",
    "https://p10-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private",
  ])
    assert.throws(() => validatedAppleURL(url, true));
  assert.equal(
    validatedAppleURL(
      "https://p10-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private/records/query",
      true,
    ).hostname,
    "p10-ckdatabasews.icloud.com",
  );
  assert.throws(() =>
    validatedPushURL("wss://websocket.push.apple.com.evil.test/"),
  );
  const requests: { url: string; headers: Headers }[] = [];
  const send = (async (input: RequestInfo | URL, options?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: new Headers(options?.headers),
    });
    return new Response(null, {
      status: 302,
      headers: { location: "https://setup.icloud.com/" },
    });
  }) as typeof fetch;
  const jar = new CookieJar();
  jar.set(
    "token=synthetic-secret; Path=/; Secure",
    new URL("https://idmsa.apple.com/"),
  );
  await assert.rejects(
    new AppleHTTP(jar, send).request("https://idmsa.apple.com/", {
      method: "POST",
      body: "synthetic-proof",
    }),
  );
  assert.equal(requests.length, 1);
  const redirectCookies = new CookieJar();
  let calls = 0;
  const sendSameOrigin = (async (
    _input: RequestInfo | URL,
    options?: RequestInit,
  ) => {
    calls++;
    if (calls === 1) {
      const headers = new Headers({ location: "/after" });
      headers.append(
        "set-cookie",
        "one=1; Path=/; Secure; Expires=Wed, 21 Oct 2037 07:28:00 GMT",
      );
      headers.append("set-cookie", "two=2; Path=/; Secure");
      return new Response(null, { status: 302, headers });
    }
    assert.equal(new Headers(options?.headers).get("cookie"), "one=1; two=2");
    return Response.json({ ok: true });
  }) as typeof fetch;
  assert.equal(
    (
      await new AppleHTTP(redirectCookies, sendSameOrigin).request(
        "https://idmsa.apple.com/",
      )
    ).status,
    200,
  );
});

test("oversized decompression and upstream error material fail safely", () => {
  assert.throws(() => decodeDocument(b64(gzipSync(utf8("x".repeat(300_000))))));
  const safe = publicError(
    new Error("password=synthetic-sentinel-secret; upstream reminder title"),
    "synthetic-request",
  );
  assert.ok(!JSON.stringify(safe).includes("sentinel-secret"));
});

test("Apple redirect loops and excessive chains are bounded without exposing query tokens or session values", async () => {
  let loops = 0;
  const send = (async () => {
    loops++;
    return new Response(null, {
      status: 302,
      headers: {
        location: "/appleauth/auth/2sv/trust?token=synthetic-private-query",
      },
    });
  }) as typeof fetch;
  await assert.rejects(
    new AppleHTTP(new CookieJar(), send).request(
      "https://idmsa.apple.com/appleauth/auth/2sv/trust?token=synthetic-private-query",
      {
        maxRedirects: 8,
        stage: "browser-trust",
        headers: { scnt: "synthetic-private-header" },
      },
    ),
    (error: any) =>
      error.code === "APPLE_REDIRECT_ERROR" &&
      /loop.*HTTP 302/.test(error.message) &&
      !error.message.includes("private"),
  );
  assert.equal(loops, 1);
  let hops = 0;
  const chain = (async () =>
    new Response(null, {
      status: 302,
      headers: { location: "/appleauth/auth/2sv/trust?step=" + ++hops },
    })) as typeof fetch;
  await assert.rejects(
    new AppleHTTP(new CookieJar(), chain).request(
      "https://idmsa.apple.com/appleauth/auth/2sv/trust",
      { maxRedirects: 8, stage: "browser-trust" },
    ),
    (error: any) =>
      error.code === "APPLE_REDIRECT_ERROR" &&
      /limit exceeded.*8\/8/.test(error.message),
  );
  assert.equal(hops, 9);
});

test("API authorization precedes storage, with CSRF and disabled live operations", async () => {
  const origin = "https://private.example.test";
  const env = { REMINDERS_OWNER_ID: "synthetic-owner", APP_ORIGIN: origin };
  const request = (path: string, user?: string, opts?: RequestInit) =>
    new Request(origin + path, {
      ...opts,
      headers: {
        ...(user ? { "oai-authenticated-user-id": user } : {}),
        ...opts?.headers,
      },
    });
  assert.equal(
    (await applicationRoute(request("/api/connection"), env))?.status,
    401,
  );
  assert.equal(
    (await applicationRoute(request("/api/connection", "other"), env))?.status,
    403,
  );
  assert.equal(
    (await applicationRoute(request("/api/connection", "synthetic-owner"), {}))
      ?.status,
    503,
  );
  assert.equal(
    (
      await applicationRoute(
        new Request("https://wrong.example.test/api/connection", {
          headers: { "oai-authenticated-user-id": "synthetic-owner" },
        }),
        env,
      )
    )?.status,
    403,
  );
  const badOrigin = {
    method: "POST",
    headers: {
      origin: "https://evil.test",
      "content-type": "application/json",
    },
    body: "{}",
  };
  assert.equal(
    (
      await applicationRoute(
        request("/api/auth/disconnect", "synthetic-owner", badOrigin),
        env,
      )
    )?.status,
    403,
  );
  const setup = {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ password: "synthetic-sentinel-secret" }),
  };
  const blocked = await applicationRoute(
    request("/api/auth/start", "synthetic-owner", setup),
    env,
  );
  assert.equal(blocked?.status, 422);
  const error = (await blocked!.json()) as { error: { code: string } };
  assert.equal(error.error.code, "UNSUPPORTED_AUTH");
  assert.ok(!JSON.stringify(error).includes("sentinel-secret"));
  const pausedSocket = await applicationRoute(
    request("/api/auth/socket?generation=0", "synthetic-owner"),
    {
      ...env,
      APPLE_LOGIN_ENABLED: "false",
      APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
    },
  );
  assert.equal(pausedSocket?.status, 422);
  const paused = (await pausedSocket!.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(paused.error.code, "UNSUPPORTED_AUTH");
  assert.ok(paused.error.message.includes("disabled"));
  assert.ok(paused.error.message.includes("APPLE_LOGIN_ENABLED"));
  const oldApproval = await applicationRoute(
    request("/api/auth/config", "synthetic-owner"),
    {
      ...env,
      APPLE_CRYPTO_REVIEW_APPROVED: "browser-proof-v1",
      LIVE_APPLE_CONNECTION_APPROVED: "controlled-read-v1",
    },
  );
  assert.equal(
    ((await oldApproval!.json()) as { enabled: boolean }).enabled,
    true,
  );
  const pausedDocument = await applicationRoute(
    request("/connect/apple", "synthetic-owner"),
    { ...env, APPLE_LOGIN_ENABLED: "false" },
  );
  assert.equal(pausedDocument?.status, 200);
  assert.ok(!(await pausedDocument!.text()).includes("<input"));
  assert.equal(
    (await applicationRoute(request("/connect/apple", "other"), env))?.status,
    403,
  );
  const lists = await applicationRoute(
    request("/api/lists", "synthetic-owner"),
    env,
  );
  assert.equal(lists?.status, 404);
  assert.equal(
    ((await lists!.json()) as { error: { code: string } }).error.code,
    "NOT_FOUND",
  );
});
