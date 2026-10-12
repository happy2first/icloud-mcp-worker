import { Miniflare, Log, LogLevel } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
const origin = "https://worker.example.test",
  issuer = "https://synthetic-team.cloudflareaccess.com",
  owner = "synthetic-owner";
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  alg: "RS256",
  use: "sig",
  kid: "synthetic",
};
const sign = (sub) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setSubject(sub)
    .setIssuer(issuer)
    .setAudience("synthetic-aud")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
const calls = [];
const mfEnvKey = JSON.stringify({ v1: randomBytes(32).toString("base64") });
const mf = new Miniflare({
  modules: true,
  scriptPath: "dist/worker.js",
  compatibilityDate: "2026-07-30",
  d1Databases: { DB: "local-test" },
  bindings: {
    APP_ORIGIN: origin,
    TEAM_DOMAIN: issuer,
    POLICY_AUD: "synthetic-aud",
    REMINDERS_OWNER_ID: owner,
    ENCRYPTION_KEY_ID: "v1",
    ENCRYPTION_KEYS_JSON: mfEnvKey,
    APPLE_LOGIN_ENABLED: "true",
    APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1",
    APPLE_SESSION_RENEWAL_ENABLED: "saved-tokens-v1",
  },
  outboundService: async (req) => {
    const u = new URL(req.url);
    if (u.origin === issuer) return Response.json({ keys: [jwk] });
    calls.push({
      url: req.url,
      method: req.method,
      body: await req.text(),
      headers: Object.fromEntries(req.headers),
    });
    if (u.hostname === "caldav.icloud.com" && req.method === "PUT")
      return new Response("", { status: 201, headers: { etag: '"created"' } });
    if (u.hostname === "asset.icloud-content.com")
      return new Response("synthetic-file", {
        headers: { "content-type": "text/plain" },
      });
    throw new Error("Unexpected outbound request (network disabled).");
  },
  log: new Log(LogLevel.ERROR),
});
try {
  const db = await mf.getD1Database("DB");
  const schema = await readFile("schema.sql", "utf8");
  for (const sql of schema
    .replace(/^--.*$/gm, "")
    .split(";")
    .filter((s) => s.trim()))
    await db.prepare(sql).run();
  const signed = {
    "cf-access-jwt-assertion": await sign(owner),
    "oai-authenticated-user-id": "forged",
  };
  const request = (path, value, extra = {}) =>
    mf.dispatchFetch(origin + path, {
      headers: {
        ...signed,
        ...(value === undefined
          ? {}
          : { "content-type": "application/json", origin }),
        ...extra,
      },
      ...(value === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(value) }),
    });
  assert.equal((await mf.dispatchFetch(origin + "/admin")).status, 401);
  assert.equal(
    (
      await mf.dispatchFetch(origin + "/admin", {
        headers: {
          "cf-access-jwt-assertion": await sign("other"),
          "oai-authenticated-user-id": owner,
        },
      })
    ).status,
    403,
  );
  const home = await request("/admin");
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes("iCloud MCP"));
  assert.ok(
    home.headers
      .get("content-security-policy")
      .includes("frame-ancestors 'none'"),
  );
  const login = await request("/connect/apple");
  assert.equal(login.status, 200);
  assert.ok((await login.text()).includes('id="password"'));
  const script = await request("/api/auth/client.js");
  assert.equal(script.status, 200);
  assert.ok((await script.text()).length > 10000);
  const status = await request("/api/admin/status");
  assert.equal(status.status, 200);
  const s = await status.json();
  assert.equal(s.web.state, "DISCONNECTED");
  assert.equal(s.services.length, 6);
  assert.ok(s.services.every((x) => !x.enabled));
  const rejected = await request(
    "/api/admin/credentials",
    {
      account: "synthetic@example.invalid",
      password: "aaaa-bbbb-cccc-dddd",
      expectedVersion: 0,
    },
    { origin: "https://evil.test" },
  );
  assert.equal(rejected.status, 403);
  const saved = await request("/api/admin/credentials", {
    account: "synthetic@example.invalid",
    password: "aaaa-bbbb-cccc-dddd",
    expectedVersion: 0,
  });
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.equal((await saved.json()).version, 1);
  const row = await db.prepare("SELECT envelope FROM credentials").first();
  assert.ok(!row.envelope.includes("aaaa-bbbb"));
  assert.ok(!row.envelope.includes("synthetic@example.invalid"));
  assert.equal(
    (
      await request("/api/admin/credentials", {
        account: "synthetic@example.invalid",
        password: "aaaa-bbbb-cccc-dddd",
        expectedVersion: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/admin/service", {
        service: "photos",
        enabled: true,
        writable: true,
      })
    ).status,
    403,
  );
  const mcp = async (method, params) => {
    const r = await request(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method, params },
      { accept: "application/json, text/event-stream" },
    );
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const tools = await mcp("tools/list", {});
  assert.ok(tools.result.tools.length >= 25);
  assert.ok(
    tools.result.tools.every(
      (t) =>
        !t.name.includes("delete") &&
        !t.name.includes("auth") &&
        !t.name.includes("pcs"),
    ),
  );
  for (const name of [
    "calendar_collections",
    "contacts_collections",
    "get_reminder_lists",
    "notes_list",
    "photos_albums",
    "drive_browse",
  ]) {
    const result = await mcp("tools/call", { name, arguments: {} });
    assert.equal(result.result.isError, true);
    assert.equal(result.result.structuredContent.error.code, "FORBIDDEN");
  }
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await request("/api/admin/service", {
        service: "calendar",
        enabled: true,
        writable: false,
      })
    ).status,
    200,
  );
  const createArgs = {
    collection: "https://caldav.icloud.com/test/",
    idempotencyKey: "cf998489-a579-4ca4-bf75-5d17f6a62fc3",
    event: {
      title: "Synthetic event",
      start: "20261012T010000Z",
      end: "20261012T020000Z",
    },
  };
  assert.equal(
    (
      await mcp("tools/call", {
        name: "calendar_create",
        arguments: createArgs,
      })
    ).result.structuredContent.error.code,
    "FORBIDDEN",
  );
  await request("/api/admin/service", {
    service: "calendar",
    enabled: true,
    writable: true,
  });
  const create = await mcp("tools/call", {
    name: "calendar_create",
    arguments: createArgs,
  });
  assert.equal(
    create.result.structuredContent.status,
    201,
    JSON.stringify({
      create,
      calls: calls.map((x) => ({ method: x.method, url: x.url })),
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["if-none-match"], "*");
  assert.ok(calls[0].body.includes("SUMMARY:Synthetic event"));
  assert.ok(!JSON.stringify(create).includes("aaaa-bbbb"));
  const info = await mcp("tools/call", {
    name: "icloud_status",
    arguments: {},
  });
  assert.equal(info.result.structuredContent.dav.configured, true);
  const { issueDownload } = await import("../src/services/downloads.ts");
  const ticketEnv = {
    DB: db,
    APP_ORIGIN: origin,
    ENCRYPTION_KEY_ID: "v1",
    ENCRYPTION_KEYS_JSON: mfEnvKey,
    APPLE_LOGIN_ENABLED: "true",
    APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1",
  };
  const { AppleSessionRepository } = await import(
    "../src/persistence/apple-sessions.ts"
  );
  const { loginAssurance } = await import("../src/auth/apple/policy.ts");
  const { freshPcsCheckpoint } = await import("../src/auth/apple/pcs.ts");
  const repo = new AppleSessionRepository(ticketEnv, owner);
  const setup = await repo.begin(0);
  await repo.commit(
    setup,
    {
      login: loginAssurance(),
      auth: { clientId: "synthetic-client", headers: {}, cookies: [] },
      connection: {
        dsid: "123",
        clientId: "synthetic-client",
        clientBuildNumber: "test",
        clientMasteringNumber: "test",
        cloudKitURL:
          "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
      },
      pcs: freshPcsCheckpoint(),
    },
    "READY",
  );
  await request("/api/admin/service", {
    service: "photos",
    enabled: true,
    writable: false,
  });
  const ticket = await issueDownload(
    ticketEnv,
    owner,
    {
      url: "https://asset.icloud-content.com/file?token=synthetic-secret",
      filename: "file.txt",
    },
    { service: "photos", generation: setup.generation },
  );
  assert.ok(!JSON.stringify(ticket).includes("synthetic-secret"));
  const streamed = await request(
    "/download/" + ticket.resourceUri.split("://")[1],
  );
  assert.equal(streamed.status, 200, await streamed.clone().text());
  assert.equal(await streamed.text(), "synthetic-file");
  const resource = await mcp("resources/read", { uri: ticket.resourceUri });
  assert.equal(
    Buffer.from(resource.result.contents[0].blob, "base64").toString(),
    "synthetic-file",
  );
  assert.ok(!calls.at(-1).headers.authorization);
  assert.ok(!calls.at(-1).headers.cookie);
  const beforeDenied = calls.length;
  await request("/api/admin/service", {
    service: "photos",
    enabled: false,
    writable: false,
  });
  assert.equal(
    (await request("/download/" + ticket.resourceUri.split("://")[1])).status,
    403,
  );
  const deniedResource = await mcp("resources/read", {
    uri: ticket.resourceUri,
  });
  assert.ok(deniedResource.error);
  assert.equal(
    calls.length,
    beforeDenied,
    "Disabled services cannot redeem outstanding tickets",
  );
  await request("/api/admin/service", {
    service: "photos",
    enabled: true,
    writable: false,
  });
  // Keep the encrypted ticket to prove the generation fence, independently of cleanup.
  await repo.disconnect();
  await repo.begin((await repo.status()).generation);
  const stale = await request(
    "/download/" + ticket.resourceUri.split("://")[1],
  );
  assert.notEqual(stale.status, 200);
  assert.equal(calls.length, beforeDenied);
  assert.equal(
    (await request("/api/admin/remove-credentials", { expectedVersion: 999 }))
      .status,
    409,
  );
  assert.equal(
    (await request("/api/admin/remove-credentials", { expectedVersion: 1 }))
      .status,
    200,
  );
  await request("/api/auth/disconnect", {});
  assert.equal(
    (await request("/download/" + ticket.resourceUri.split("://")[1])).status,
    409,
  );
  console.log(
    JSON.stringify({
      result: "passed",
      runtime: "local-workerd",
      checks: [
        "Access JWT verification and forged-header denial",
        "management CSP and browser SRP bundle",
        "D1 encrypted credential storage and version conflicts",
        "six service gates",
        "MCP discovery without destructive/auth tools",
        "DAV conditional write with permission gates",
        "owner/service/session-scoped encrypted downloads and MCP resources",
        "disabled service and changed session deny download without outbound requests",
        "credential removal requires current version",
      ],
      appleLiveValidated: false,
      productionValidated: false,
    }),
  );
} finally {
  await mf.dispose();
}
