import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  AppleSessionRepository,
  mergeSavedLists,
  type AppleSession,
} from "../src/persistence/apple-sessions.ts";
import { AppleConnectionService, ControlledRead } from "../src/auth/service.ts";
import { AppError } from "../src/errors.ts";
import { omitField } from "../src/lib/omit-field.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { Envelopes } from "../src/crypto/envelopes.ts";
import {
  LoginAssuranceSchema,
  loginAssurance,
  SESSION_RETENTION_MS,
} from "../src/auth/apple/policy.ts";
import {
  AppleSessionRenewal,
  appleRequestBudget,
  renewalCheckpoint,
} from "../src/auth/apple/session-renewal.ts";
import { encodeDocument } from "../src/reminders/crdt.ts";
import { b64 } from "../src/crypto/bytes.ts";
import { webOperation } from "../src/services/web.ts";

// Real SQLite executes repository SQL. This adapter models D1's transactional batch.
// The produced Worker is separately tested in workerd with real D1 bindings.
class SQLiteD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  afterStatement: ((sql: string) => Promise<void>) | null = null;
  constructor() {
    this.sqlite.exec(
      readFileSync(new URL("../schema.sql", import.meta.url), "utf8"),
    );
  }
  withSession() {
    return this;
  }
  prepare(sql: string) {
    const source = this;
    function make(params: SQLInputValue[]) {
      return {
        bind(...values: SQLInputValue[]) {
          return make(values);
        },
        async first<T>() {
          const result = source.sqlite.prepare(sql).get(...params);
          if (source.afterStatement) await source.afterStatement(sql);
          return (result as T) ?? null;
        },
        async run() {
          const result = source.sqlite.prepare(sql).run(...params);
          if (source.afterStatement) await source.afterStatement(sql);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
    }
    return make([]);
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  env() {
    return { DB: this as unknown as D1Database };
  }
}
const key = () =>
  new Envelopes("synthetic", {
    synthetic: b64(crypto.getRandomValues(new Uint8Array(32))),
  });
const owner = "synthetic-owner";
const appleSession = (): AppleSession => ({
  login: loginAssurance(Date.now(), true),
  auth: {
    clientId: "auth-session-123",
    headers: { "X-Apple-Session-Token": "header-session-secret" },
    cookies: [
      {
        name: "X-APPLE-WEBAUTH-TOKEN",
        value: "cookie-session-secret",
        domain: "icloud.com",
        hostOnly: false,
        path: "/",
        secure: true,
        expiresAt: null,
      },
    ],
  },
  connection: {
    dsid: "123456789",
    clientId: "auth-session-123",
    clientBuildNumber: "2534Project66",
    clientMasteringNumber: "2534B22",
    cloudKitURL:
      "https://p123-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
  },
  pcs: {
    consentRequested: true,
    pcsAttempts: 1,
    consentChecks: 2,
    expiresAt: Date.now() + 300_000,
    nextAttemptAt: 0,
  },
});
test("generic services recover rejected read once and keep the session generation", async () => {
  const db = new SQLiteD1(),
    envelopes = key(),
    env = testEnv(db, envelopes);
  const repo = new AppleSessionRepository(env, owner);
  const original = appleSession();
  original.servicePcs = { notes3: { ...original.pcs, ready: true } };
  original.renewal = { ...renewalCheckpoint(), lastValidatedAt: Date.now() };
  const setup = await repo.begin(0);
  await repo.commit(setup, original, "READY");
  const nativeFetch = globalThis.fetch;
  let validations = 0,
    reads = 0;
  globalThis.fetch = async (value) => {
    assert.ok(String(value).includes("/validate"));
    validations++;
    return Response.json(acceptedAccount());
  };
  try {
    const result = await webOperation(env, owner, "notes3", async (w) => {
      reads++;
      assert.equal(w.generation, setup.generation);
      if (reads === 1) throw new AppError("REAUTH_REQUIRED", "synthetic", 409);
      return { ok: true };
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(reads, 2);
    assert.equal(validations, 1);
    let pcsCalls = 0;
    globalThis.fetch = async (value) => {
      if (String(value).includes("/requestWebAccessState")) {
        pcsCalls++;
        return new Response("", { status: 401 });
      }
      assert.ok(String(value).includes("/validate"));
      return Response.json(acceptedAccount());
    };
    await assert.rejects(
      webOperation(
        env,
        owner,
        "notes3",
        async () => {
          throw new Error("approval must not read data");
        },
        true,
      ),
      (e: any) => e.code === "RESTART_REQUIRED",
    );
    assert.equal(
      pcsCalls,
      1,
      "PCS callback is not replayed after auth recovery",
    );
    globalThis.fetch = async (value) => {
      assert.ok(String(value).includes("/validate"));
      validations++;
      return Response.json(acceptedAccount());
    };
    let rejectedReads = 0;
    await assert.rejects(
      webOperation(env, owner, "notes3", async () => {
        rejectedReads++;
        throw new AppError("REAUTH_REQUIRED", "synthetic", 409);
      }),
    );
    assert.equal(rejectedReads, 2);
    assert.equal(validations, 2);
    await assert.rejects(
      webOperation(env, owner, "notes3", async () => {
        throw new Error("cooldown must block callback");
      }),
      (e: any) => e.code === "UPSTREAM_UNAVAILABLE",
    );
    assert.equal(
      validations,
      2,
      "another request cannot start a recovery storm",
    );
    await assert.rejects(
      webOperation(
        { ...env, APPLE_LOGIN_ENABLED: "false" },
        owner,
        "notes3",
        async () => {
          throw new Error("must not run");
        },
      ),
    );
  } finally {
    globalThis.fetch = nativeFetch;
    db.sqlite.close();
  }
});
test("generic PCS rejection resets only the affected approval checkpoint", async () => {
  const db = new SQLiteD1(),
    envelopes = key(),
    env = testEnv(db, envelopes),
    repo = new AppleSessionRepository(env, owner);
  const original = appleSession();
  original.renewal = { ...renewalCheckpoint(), lastValidatedAt: Date.now() };
  original.servicePcs = {
    notes3: { ...original.pcs, ready: true, pcsAttempts: 10 },
    photos: { ...original.pcs, ready: true },
  };
  await repo.commit(await repo.begin(0), original, "READY");
  try {
    await assert.rejects(
      webOperation(env, owner, "notes3", async () => {
        throw new AppError("DEVICE_APPROVAL_PENDING", "synthetic", 409);
      }),
    );
    const saved = await repo.load();
    assert.equal(saved.session.servicePcs?.notes3?.ready, false);
    assert.equal(saved.session.servicePcs?.notes3?.pcsAttempts, 0);
    assert.equal(saved.session.servicePcs?.photos?.ready, true);
  } finally {
    db.sqlite.close();
  }
});
const appleRepo = (db: SQLiteD1, who = owner, envelopes = key()) =>
  new AppleSessionRepository(
    {
      ...db.env(),
      ENCRYPTION_KEYS_JSON: JSON.stringify(envelopes.keys),
    },
    who,
    envelopes,
  );

const testEnv = (db: SQLiteD1, envelopes: Envelopes) => ({
  ...db.env(),
  REMINDERS_OWNER_ID: owner,
  ENCRYPTION_KEYS_JSON: JSON.stringify(envelopes.keys),
  APPLE_LOGIN_ENABLED: "true",
  LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
  APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
  APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1",
  APPLE_SESSION_RENEWAL_ENABLED: "saved-tokens-v1",
});
async function fixedClock(run: (clock: { now: number }) => Promise<void>) {
  const nativeNow = Date.now;
  const clock = { now: Date.parse("2026-10-09T19:25:12.131Z") };
  Date.now = () => clock.now;
  try {
    await run(clock);
  } finally {
    Date.now = nativeNow;
  }
}
const acceptedAccount = (
  dsid = "123456789",
  host = "p123-ckdatabasews.icloud.com",
) => ({
  hsaTrustedBrowser: true,
  hsaChallengeRequired: false,
  termsUpdateNeeded: false,
  dsInfo: { dsid },
  webservices: { ckdatabasews: { url: `https://${host}` } },
});
const hasCode = (code: string) => (error: unknown) =>
  error instanceof AppError && error.code === code;

test("legacy and retained assurance variants stay strict and separate authentication from retention", () => {
  const now = Date.parse("2026-10-09T19:25:12.131Z");
  const legacy = loginAssurance(now, false);
  const current = loginAssurance(now, true);
  assert.equal(legacy.expiresAt - now, 86_400_000);
  assert.equal(current.expiresAt - now, 2_592_000_000);
  assert.equal(current.policy, legacy.policy);
  for (const bad of [
    { ...legacy, expiresAt: current.expiresAt },
    { ...current, expiresAt: legacy.expiresAt },
    { ...current, verifiedAt: Number.MAX_SAFE_INTEGER },
    { ...current, factor: "password" },
    { ...current, consentPersistentSession: false },
    { ...current, consentAppleTrust: "true" },
    { ...current, version: 4 },
    { ...legacy, retentionSource: "owner-authorised-migration" },
    { ...current, previousExpiresAt: legacy.expiresAt },
  ])
    assert.equal(LoginAssuranceSchema.safeParse(bad).success, false);
  assert.equal(
    new Date(current.expiresAt).toISOString(),
    "2026-11-08T19:25:12.131Z",
    "UTC arithmetic crosses the UK DST change without sliding.",
  );
});

test("approved migration preserves all encrypted evidence, cursors and identities with zero Apple requests", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error("Migration must not contact Apple.");
    };
    const db = new SQLiteD1(),
      envelopes = key(),
      repository = appleRepo(db, owner, envelopes);
    try {
      const original = appleSession();
      original.login = loginAssurance(clock.now, false);
      original.auth.headers["X-Apple-TwoSV-Trust-Token"] =
        "synthetic-trust-token";
      original.savedLists = mergeSavedLists(
        [],
        [{ id: "List/PRESERVED", title: "Synthetic list" }],
      );
      original.directListSnapshot = { updatedAt: clock.now };
      original.allOpenScan = {
        token: crypto.randomUUID(),
        expiresAt: clock.now + 600_000,
        listIds: ["List/PRESERVED"],
        lists: original.savedLists,
        index: 0,
        cursor: "synthetic-cursor",
        seen: [],
        listPages: 0,
        totalPages: 0,
        caughtUpAt: clock.now,
        source: "direct-cloudkit-query",
      };
      const setup = await repository.begin(0);
      await repository.commit(setup, original, "READY");
      const before = await repository.load();
      const beforeCipher = db.sqlite
        .prepare("SELECT envelope FROM apple_session_state")
        .get()?.envelope;
      clock.now += 2 * 86_400_000;
      const approval = {
        migrationId: "synthetic-owner-approval",
        owner,
        account: "apple-reminders",
        generation: setup.generation,
      };
      const env = {
        ...testEnv(db, envelopes),
        APPLE_SESSION_RETENTION_MIGRATION_JSON: JSON.stringify(approval),
      };
      const compatible = new AppleSessionRepository(env, owner);
      const migrated = await compatible.migrateOwnerSessionRetention();
      assert.equal(requests, 0);
      assert.equal(migrated.fence.generation, before.fence.generation);
      assert.equal(migrated.fence.version, before.fence.version + 1);
      assert.deepEqual(
        omitField(migrated.session, "login"),
        omitField(original, "login"),
      );
      assert.equal(
        migrated.session.login.verifiedAt,
        original.login.verifiedAt,
      );
      assert.equal(
        migrated.session.login.expiresAt,
        original.login.verifiedAt + 2_592_000_000,
      );
      assert.equal(migrated.session.login.factor, original.login.factor);
      assert.ok(
        migrated.session.login.version === 3 &&
          migrated.session.login.retentionSource ===
            "owner-authorised-migration",
      );
      assert.equal(
        migrated.session.login.previousExpiresAt,
        original.login.expiresAt,
      );
      assert.equal(migrated.session.login.migratedAt, clock.now);
      assert.notEqual(
        db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()
          ?.envelope,
        beforeCipher,
      );
      clock.now += 1000;
      assert.deepEqual(
        await compatible.migrateOwnerSessionRetention(),
        migrated,
      );
      const restarted = new AppleSessionRepository(
        testEnv(db, envelopes),
        owner,
      );
      assert.deepEqual(
        await restarted.load(),
        migrated,
        "Removing approval and restarting must not shorten the committed session.",
      );
      for (let index = 0; index < 3; index++)
        assert.equal(
          (await new AppleConnectionService(env, owner).status()).retentionDays,
          30,
        );
      assert.equal(requests, 0, "Status polling is local-only.");
      const snapshot = await new AppleConnectionService(env, owner).read(
        ControlledRead.parse({
          action: "saved-lists",
          expectedGeneration: setup.generation,
        }),
      );
      assert.equal(
        (snapshot.result as { records: unknown[] }).records.length,
        1,
      );
      assert.equal(
        requests,
        0,
        "Dashboard snapshot polling must not perform renewal, even when a check is due.",
      );
      await assert.rejects(
        new AppleConnectionService(env, owner).readAllOpenForMCP(
          setup.generation,
          original.allOpenScan.token,
        ),
        hasCode("RESTART_REQUIRED"),
      );
      assert.equal((await restarted.load()).session.allOpenScan, undefined);
      assert.equal(
        (await restarted.status()).state,
        "READY",
        "Expired pagination must not expire the migrated account.",
      );
    } finally {
      globalThis.fetch = nativeFetch;
      db.sqlite.close();
    }
  }));

test("migration eligibility rejects unapproved, wrong-owner/generation, disconnected and hard-expired sessions", async () =>
  fixedClock(async (clock) => {
    for (const variant of [
      "unapproved",
      "wrong-generation",
      "wrong-requester",
      "expired",
      "disconnected",
      "absent",
      "pending",
    ] as const) {
      const db = new SQLiteD1(),
        envelopes = key(),
        repository = appleRepo(db, owner, envelopes),
        original = appleSession();
      original.login = loginAssurance(clock.now, false);
      const setup = await repository.begin(0);
      await repository.commit(
        setup,
        original,
        variant === "pending" ? "DEVICE_APPROVAL_PENDING" : "READY",
        variant === "pending" ? "approve-device-consent" : undefined,
      );
      const approval = {
        migrationId: "synthetic-scope",
        owner,
        account: "apple-reminders",
        generation: variant === "wrong-generation" ? 99 : setup.generation,
      };
      const env = {
        ...testEnv(db, envelopes),
        APPLE_SESSION_RETENTION_MIGRATION_JSON:
          variant === "unapproved" ? undefined : JSON.stringify(approval),
      };
      const compatible = new AppleSessionRepository(
        env,
        variant === "wrong-requester" ? "other-owner" : owner,
      );
      if (variant === "disconnected") await repository.disconnect();
      if (variant === "absent")
        db.sqlite
          .prepare("UPDATE apple_session_state SET envelope = NULL")
          .run();
      const savedTime = clock.now;
      if (variant === "expired") clock.now += SESSION_RETENTION_MS;
      try {
        if (["disconnected", "wrong-requester"].includes(variant))
          await assert.rejects(compatible.load(), hasCode("NOT_CONNECTED"));
        else if (variant === "expired")
          await assert.rejects(compatible.load(), hasCode("AUTH_EXPIRED"));
        else if (variant === "absent")
          await assert.rejects(compatible.load(), hasCode("REAUTH_REQUIRED"));
        else {
          const saved = await compatible.load();
          assert.equal(
            saved.session.login.version,
            variant === "pending" ? 3 : 2,
          );
          if (variant === "pending")
            assert.equal(saved.state, "DEVICE_APPROVAL_PENDING");
        }
        if (variant === "wrong-requester")
          assert.equal((await repository.load()).session.login.version, 2);
      } finally {
        clock.now = savedTime;
        db.sqlite.close();
      }
    }
    const db = new SQLiteD1(),
      envelopes = key();
    for (const approval of [
      "not-json",
      JSON.stringify({ owner: "wrong" }),
      JSON.stringify({
        migrationId: "bad",
        owner: "other",
        account: "apple-reminders",
        generation: 1,
      }),
    ]) {
      assert.throws(
        () =>
          new AppleSessionRepository(
            {
              ...testEnv(db, envelopes),
              APPLE_SESSION_RETENTION_MIGRATION_JSON: approval,
            },
            owner,
          ),
        hasCode("CONFIGURATION_REQUIRED"),
      );
    }
    db.sqlite.close();
  }));

test("migration CAS serializes concurrent calls, defers active leases and cannot restore a disconnect", async () =>
  fixedClock(async (clock) => {
    for (const race of [
      "parallel",
      "operation",
      "disconnect",
      "cookie-update",
    ] as const) {
      const db = new SQLiteD1(),
        envelopes = key(),
        repository = appleRepo(db, owner, envelopes),
        original = appleSession();
      original.login = loginAssurance(clock.now, false);
      const setup = await repository.begin(0);
      await repository.commit(setup, original, "READY");
      const env = {
        ...testEnv(db, envelopes),
        APPLE_SESSION_RETENTION_MIGRATION_JSON: JSON.stringify({
          migrationId: "race",
          owner,
          account: "apple-reminders",
          generation: setup.generation,
        }),
      };
      const compatible = new AppleSessionRepository(env, owner);
      const before = await repository.load();
      if (race === "operation") {
        await repository.claimRead(
          before.fence.generation,
          before.fence.version,
        );
        clock.now += 86_400_001;
        db.sqlite
          .prepare("UPDATE apple_session_state SET resume_expires_at = ?")
          .run(clock.now + 30_000);
        await assert.rejects(compatible.status(), hasCode("CONFLICT"));
        assert.ok(
          db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()
            ?.envelope,
        );
        db.sqlite
          .prepare("UPDATE apple_session_state SET resume_expires_at = ?")
          .run(clock.now);
        assert.equal((await compatible.load()).session.login.version, 3);
        clock.now -= 86_400_001;
      } else if (race === "parallel") {
        const results = await Promise.allSettled([
          compatible.load(),
          new AppleSessionRepository(env, owner).load(),
        ]);
        assert.ok(results.some((result) => result.status === "fulfilled"));
        assert.equal(
          (await compatible.load()).fence.version,
          before.fence.version + 1,
        );
      } else {
        const nativeEncrypt = compatible.envelopes.encrypt.bind(
          compatible.envelopes,
        );
        compatible.envelopes.encrypt = async (
          ...args: Parameters<Envelopes["encrypt"]>
        ) => {
          const result = await nativeEncrypt(...args);
          if (race === "disconnect") await repository.disconnect();
          else
            db.sqlite
              .prepare("UPDATE apple_session_state SET version = version + 1")
              .run();
          return result;
        };
        await assert.rejects(compatible.load(), hasCode("CONFLICT"));
        compatible.envelopes.encrypt = nativeEncrypt;
        if (race === "disconnect") {
          assert.equal((await compatible.status()).state, "DISCONNECTED");
          assert.equal(
            db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()
              ?.envelope,
            null,
          );
        } else assert.deepEqual((await repository.load()).session, original);
      }
      db.sqlite.close();
    }
  }));

test("ordinary commits cannot change migrated retention evidence, consent or account identity", async () =>
  fixedClock(async (clock) => {
    const db = new SQLiteD1(),
      envelopes = key(),
      repository = appleRepo(db, owner, envelopes),
      original = appleSession();
    original.login = loginAssurance(clock.now, false);
    const setup = await repository.begin(0);
    await repository.commit(setup, original, "READY");
    const compatible = new AppleSessionRepository(
      {
        ...testEnv(db, envelopes),
        APPLE_SESSION_RETENTION_MIGRATION_JSON: JSON.stringify({
          migrationId: "immutable",
          owner,
          account: "apple-reminders",
          generation: setup.generation,
        }),
      },
      owner,
    );
    const saved = await compatible.load(),
      fence = await compatible.claimRead(
        saved.fence.generation,
        saved.fence.version,
      );
    const login = saved.session.login;
    assert.ok(
      login.version === 3 &&
        login.retentionSource === "owner-authorised-migration",
    );
    for (const modified of [
      { ...login, migratedAt: clock.now + 1 },
      { ...login, migrationId: "another" },
      loginAssurance(clock.now + 1),
    ]) {
      await assert.rejects(
        compatible.commitResume(
          fence,
          { ...saved.session, login: modified },
          "READY",
        ),
        hasCode("VALIDATION_ERROR"),
      );
    }
    await assert.rejects(
      compatible.commitResume(
        fence,
        {
          ...saved.session,
          connection: { ...saved.session.connection, dsid: "999" },
        },
        "READY",
      ),
      hasCode("VALIDATION_ERROR"),
    );
    await compatible.commitResume(fence, saved.session, "READY");
    assert.deepEqual((await compatible.load()).session.login, login);
    db.sqlite.close();
  }));

test("renewal reuses accepted credentials and exchanges saved tokens once without sliding retention", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    const db = new SQLiteD1(),
      envelopes = key(),
      env = testEnv(db, envelopes),
      repository = new AppleSessionRepository(env, owner);
    const original = appleSession();
    original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust";
    const setup = await repository.begin(0);
    await repository.commit(setup, original, "READY");
    const requests: { path: string; body: unknown; cookie: string | null }[] =
      [];
    let rejectValidation = false;
    globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      requests.push({
        path,
        body: JSON.parse(String(init?.body)),
        cookie: new Headers(init?.headers).get("cookie"),
      });
      return new Response(
        JSON.stringify(
          acceptedAccount("123456789", "p42-ckdatabasews.icloud.com"),
        ),
        {
          status: path.endsWith("/validate") && rejectValidation ? 401 : 200,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "X-APPLE-WEBAUTH-TOKEN=synthetic-new; Domain=icloud.com; Path=/; Secure; Max-Age=3600",
            "X-Apple-Session-Token": "synthetic-updated",
          },
        },
      );
    };
    try {
      const renewal = new AppleSessionRenewal(env, repository);
      await renewal.ensure(setup.generation, appleRequestBudget(), true);
      assert.deepEqual(
        requests.map((request) => request.path),
        ["/setup/ws/1/validate"],
      );
      assert.equal(requests[0].body, null);
      const accepted = await repository.load();
      assert.equal(
        accepted.session.connection.cloudKitURL.includes("p42-"),
        true,
      );
      assert.equal(accepted.session.renewal?.lastValidatedAt, clock.now);
      assert.equal(accepted.session.renewal?.lastRenewedAt, null);
      assert.deepEqual(accepted.session.login, original.login);
      await renewal.ensure(setup.generation, appleRequestBudget());
      assert.equal(requests.length, 1);
      clock.now += 6 * 60 * 60_000;
      rejectValidation = true;
      await renewal.ensure(setup.generation, appleRequestBudget());
      assert.deepEqual(
        requests.map((request) => request.path),
        [
          "/setup/ws/1/validate",
          "/setup/ws/1/validate",
          "/setup/ws/1/accountLogin",
        ],
      );
      assert.equal(
        (requests[2].body as Record<string, unknown>).extended_login,
        true,
      );
      assert.equal(
        Object.hasOwn(requests[2].body as object, "password"),
        false,
      );
      const renewed = await repository.load();
      assert.deepEqual(renewed.session.login, original.login);
      assert.equal(
        renewed.session.auth.headers["X-Apple-Session-Token"],
        "synthetic-updated",
      );
      assert.equal(renewed.session.renewal?.lastRenewedAt, clock.now);
      assert.equal(renewed.session.renewal?.lastAppleSuccessAt, null);
      assert.equal(
        renewed.session.auth.cookies.find(
          (cookie) => cookie.name === "X-APPLE-WEBAUTH-TOKEN",
        )?.expiresAt,
        clock.now + 3_600_000,
      );
    } finally {
      globalThis.fetch = nativeFetch;
      db.sqlite.close();
    }
  }));

test("renewal outcomes preserve non-revoked sessions, save cooldowns and stop account mismatch", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    for (const scenario of [
      "revoked",
      "verification",
      "terms",
      "temporary",
      "rate",
      "protocol",
      "mismatch",
      "permission",
    ] as const) {
      const db = new SQLiteD1(),
        envelopes = key(),
        env = testEnv(db, envelopes),
        repository = new AppleSessionRepository(env, owner);
      const original = appleSession();
      original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust";
      const setup = await repository.begin(0);
      await repository.commit(setup, original, "READY");
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        const status =
          scenario === "revoked"
            ? 401
            : scenario === "temporary"
              ? 503
              : scenario === "rate"
                ? 429
                : scenario === "permission"
                  ? 403
                  : 200;
        const body =
          scenario === "verification"
            ? { ...acceptedAccount(), hsaChallengeRequired: true }
            : scenario === "terms"
              ? { ...acceptedAccount(), termsUpdateNeeded: true }
              : scenario === "protocol"
                ? { hsaTrustedBrowser: true }
                : scenario === "mismatch"
                  ? acceptedAccount("999")
                  : acceptedAccount();
        return new Response(JSON.stringify(body), {
          status,
          headers: scenario === "rate" ? { "retry-after": "7200" } : {},
        });
      };
      const code =
        scenario === "revoked"
          ? "REAUTH_REQUIRED"
          : scenario === "verification"
            ? "VERIFICATION_REQUIRED"
            : scenario === "terms"
              ? "TERMS_ACTION_REQUIRED"
              : scenario === "temporary"
                ? "UPSTREAM_UNAVAILABLE"
                : scenario === "rate"
                  ? "RATE_LIMITED"
                  : scenario === "permission"
                    ? "FORBIDDEN"
                    : "PROTOCOL_CHANGED";
      try {
        const renewal = new AppleSessionRenewal(env, repository);
        await assert.rejects(
          renewal.ensure(setup.generation, appleRequestBudget(), true),
          hasCode(code),
        );
        assert.equal(calls, scenario === "revoked" ? 2 : 1);
        if (scenario === "revoked") {
          assert.equal((await repository.status()).state, "DISCONNECTED");
          assert.equal(
            (await repository.status()).requiredAction,
            "apple-sign-in",
          );
        } else {
          const saved = await repository.load();
          assert.deepEqual(saved.session.login, original.login);
          assert.deepEqual(saved.session.connection, original.connection);
          assert.equal(saved.session.renewal?.lastValidatedAt, null);
          assert.ok(
            saved.session.renewal?.nextRetryAt &&
              saved.session.renewal.nextRetryAt > clock.now,
          );
          if (scenario === "rate")
            assert.equal(
              saved.session.renewal?.nextRetryAt,
              clock.now + 7_200_000,
            );
          await assert.rejects(
            renewal.ensure(setup.generation, appleRequestBudget(), true),
            AppError,
          );
          assert.equal(
            calls,
            1,
            "Persisted cooldown prevents another Worker from looping.",
          );
          const status = await new AppleConnectionService(env, owner).status();
          assert.equal(status.capabilities.create, false);
          const publicStatus = JSON.stringify(status);
          for (const secret of [
            "synthetic-trust",
            "header-session-secret",
            "cookie-session-secret",
            "123456789",
            "auth-session-123",
          ])
            assert.equal(publicStatus.includes(secret), false);
        }
      } finally {
        globalThis.fetch = nativeFetch;
        db.sqlite.close();
      }
    }
  }));

test("missing recovery tokens preserve the record and stop further automatic checks", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    const db = new SQLiteD1(),
      envelopes = key(),
      env = testEnv(db, envelopes),
      repository = new AppleSessionRepository(env, owner);
    const original = appleSession();
    original.auth.headers = {};
    const setup = await repository.begin(0);
    await repository.commit(setup, original, "READY");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 401 });
    };
    try {
      await assert.rejects(
        new AppleSessionRenewal(env, repository).ensure(
          setup.generation,
          appleRequestBudget(),
          true,
        ),
        hasCode("REAUTH_REQUIRED"),
      );
      const saved = await repository.load();
      assert.deepEqual(saved.session.login, original.login);
      assert.equal(saved.session.renewal?.requiredAction, "apple-sign-in");
      clock.now += 60_000;
      await assert.rejects(
        new AppleSessionRenewal(
          env,
          new AppleSessionRepository(env, owner),
        ).ensure(setup.generation, appleRequestBudget()),
        hasCode("REAUTH_REQUIRED"),
      );
      assert.equal(calls, 1);
      assert.equal((await repository.status()).state, "READY");
    } finally {
      globalThis.fetch = nativeFetch;
      db.sqlite.close();
    }
  }));

test("renewal releases its lease when the post-claim reload fails", async () =>
  fixedClock(async () => {
    const db = new SQLiteD1(),
      envelopes = key(),
      env = testEnv(db, envelopes),
      repository = new AppleSessionRepository(env, owner);
    const setup = await repository.begin(0);
    await repository.commit(setup, appleSession(), "READY");
    const nativeLoad = repository.load.bind(repository);
    let loads = 0;
    repository.load = async () => {
      if (++loads === 3)
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          "Synthetic reload failure.",
          503,
          true,
        );
      return nativeLoad();
    };
    try {
      await assert.rejects(
        new AppleSessionRenewal(env, repository).ensure(
          setup.generation,
          appleRequestBudget(),
          true,
        ),
        hasCode("UPSTREAM_UNAVAILABLE"),
      );
      assert.equal(
        db.sqlite.prepare("SELECT resume_id FROM apple_session_state").get()
          ?.resume_id,
        null,
      );
      assert.equal((await nativeLoad()).state, "READY");
    } finally {
      db.sqlite.close();
    }
  }));

test("renewal serialization and disconnect/expiry races fence token saves", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    try {
      for (const race of ["parallel", "disconnect", "expiry"] as const) {
        const db = new SQLiteD1(),
          envelopes = key(),
          env = testEnv(db, envelopes),
          repository = new AppleSessionRepository(env, owner),
          original = appleSession();
        const setup = await repository.begin(0);
        await repository.commit(setup, original, "READY");
        const renewal = new AppleSessionRenewal(env, repository);
        let release!: () => void, arrived!: () => void;
        const wait = new Promise<void>((resolve) => {
            release = resolve;
          }),
          ready = new Promise<void>((resolve) => {
            arrived = resolve;
          });
        let calls = 0;
        globalThis.fetch = async () => {
          calls++;
          arrived();
          await wait;
          return new Response(JSON.stringify(acceptedAccount()));
        };
        const pending = renewal.ensure(
          setup.generation,
          appleRequestBudget(),
          true,
        );
        await ready;
        if (race === "parallel")
          await assert.rejects(
            new AppleSessionRenewal(
              env,
              new AppleSessionRepository(env, owner),
            ).ensure(setup.generation, appleRequestBudget(), true),
            hasCode("CONFLICT"),
          );
        if (race === "disconnect") await repository.disconnect();
        if (race === "expiry") clock.now = original.login.expiresAt;
        release();
        if (race === "parallel") {
          await pending;
          assert.equal(calls, 1);
          assert.equal(
            (await repository.load()).session.renewal?.lastValidatedAt,
            clock.now,
          );
        } else {
          await assert.rejects(pending, AppError);
          assert.equal((await repository.status()).state, "DISCONNECTED");
          assert.equal(
            db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()
              ?.envelope,
            null,
          );
        }
        if (race === "expiry") clock.now = original.login.verifiedAt;
        db.sqlite.close();
      }
    } finally {
      globalThis.fetch = nativeFetch;
    }
  }));

test("recent authorised success suppresses proactive checks without claiming a full validation", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    const db = new SQLiteD1(),
      envelopes = key(),
      env = testEnv(db, envelopes),
      repository = new AppleSessionRepository(env, owner);
    const session = appleSession();
    session.renewal = { ...renewalCheckpoint(), lastAppleSuccessAt: clock.now };
    const setup = await repository.begin(0);
    await repository.commit(setup, session, "READY");
    clock.now += 1000;
    globalThis.fetch = async () => {
      throw new Error("Recent Apple operation must avoid validation.");
    };
    try {
      const saved = await new AppleSessionRenewal(env, repository).ensure(
        setup.generation,
        appleRequestBudget(),
      );
      assert.equal(saved.session.renewal?.lastValidatedAt, null);
      assert.equal(saved.session.renewal?.lastAppleSuccessAt, clock.now - 1000);
      await assert.rejects(
        new AppleSessionRenewal(env, repository).ensure(
          setup.generation,
          { deadline: clock.now + 1000, recoveryUsed: false },
          true,
        ),
        hasCode("UPSTREAM_UNAVAILABLE"),
      );
      await assert.rejects(
        new AppleSessionRenewal(env, repository).ensure(
          setup.generation,
          { deadline: clock.now + 40_000, recoveryUsed: true },
          true,
        ),
        hasCode("UPSTREAM_UNAVAILABLE"),
      );
    } finally {
      globalThis.fetch = nativeFetch;
      db.sqlite.close();
    }
  }));

test("missing encryption keys and conflicting setup leases preserve the retained envelope", async () =>
  fixedClock(async (clock) => {
    const db = new SQLiteD1(),
      envelopes = key(),
      repository = appleRepo(db, owner, envelopes),
      original = appleSession();
    original.login = loginAssurance(clock.now, false);
    const setup = await repository.begin(0);
    await repository.commit(setup, original, "READY");
    const approval = JSON.stringify({
      migrationId: "no-delete",
      owner,
      account: "apple-reminders",
      generation: setup.generation,
    });
    const env = {
      ...testEnv(db, envelopes),
      APPLE_SESSION_RETENTION_MIGRATION_JSON: approval,
    };
    const before = db.sqlite
      .prepare("SELECT envelope FROM apple_session_state")
      .get()?.envelope;
    const otherKeys = new Envelopes("replacement", {
      replacement: b64(crypto.getRandomValues(new Uint8Array(32))),
    });
    const missing = new AppleSessionRepository(
      {
        ...env,
        ENCRYPTION_KEYS_JSON: JSON.stringify(otherKeys.keys),
      },
      owner,
    );
    await assert.rejects(missing.load(), hasCode("CONFIGURATION_REQUIRED"));
    assert.equal(
      db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()
        ?.envelope,
      before,
    );
    db.sqlite
      .prepare(
        "UPDATE apple_session_state SET transaction_id = 'synthetic-active-setup', transaction_expires_at = ?",
      )
      .run(clock.now + 180_000);
    clock.now += 86_400_001;
    await assert.rejects(
      new AppleSessionRepository(env, owner).status(),
      hasCode("CONFLICT"),
    );
    assert.equal(
      db.sqlite.prepare("SELECT envelope FROM apple_session_state").get()
        ?.envelope,
      before,
    );
    db.sqlite.close();
  }));

test("an unresolved resource auth failure persists a cooldown instead of a later-instance recovery loop", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    const db = new SQLiteD1(),
      envelopes = key(),
      env = testEnv(db, envelopes),
      repository = new AppleSessionRepository(env, owner),
      original = appleSession();
    original.connection.remindersZoneOwner = "__defaultOwner__";
    original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
    const setup = await repository.begin(0);
    await repository.commit(setup, original, "READY");
    let calls = 0;
    globalThis.fetch = async (value) => {
      calls++;
      return new URL(String(value)).pathname.endsWith("/validate")
        ? new Response(JSON.stringify(acceptedAccount()))
        : new Response("{}", { status: 401 });
    };
    try {
      await assert.rejects(
        new AppleConnectionService(env, owner).getCurrentLists(
          setup.generation,
        ),
        hasCode("REAUTH_REQUIRED"),
      );
      assert.equal(calls, 3);
      const saved = await repository.load();
      assert.equal(saved.session.renewal?.requiredAction, "retry");
      assert.equal(saved.session.renewal?.nextRetryAt, clock.now + 30_000);
      await assert.rejects(
        new AppleConnectionService(env, owner).getCurrentLists(
          setup.generation,
        ),
        hasCode("UPSTREAM_UNAVAILABLE"),
      );
      assert.equal(calls, 3);
      assert.deepEqual(saved.session.login, original.login);
    } finally {
      globalThis.fetch = nativeFetch;
      db.sqlite.close();
    }
  }));

test("read-only recovery rebuilds the client and mutation preparation retries only before dispatch", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    try {
      for (const operation of ["read", "create"] as const) {
        const db = new SQLiteD1(),
          envelopes = key(),
          env = testEnv(db, envelopes),
          repository = new AppleSessionRepository(env, owner),
          original = appleSession();
        original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust";
        original.connection.remindersZoneOwner = "__defaultOwner__";
        original.renewal = {
          ...renewalCheckpoint(),
          lastValidatedAt: clock.now,
        };
        const setup = await repository.begin(0);
        await repository.commit(setup, original, "READY");
        const requests: { host: string; path: string }[] = [];
        let lookups = 0,
          dispatches = 0;
        globalThis.fetch = async (value, init) => {
          const url = new URL(String(value));
          requests.push({ host: url.hostname, path: url.pathname });
          if (url.pathname.endsWith("/validate"))
            return new Response("{}", { status: 401 });
          if (url.pathname.endsWith("/accountLogin"))
            return new Response(
              JSON.stringify(
                acceptedAccount("123456789", "p42-ckdatabasews.icloud.com"),
              ),
            );
          if (url.pathname.endsWith("/records/lookup")) {
            if (++lookups === 1) return new Response("{}", { status: 401 });
            assert.equal(
              url.hostname,
              "p42-ckdatabasews.icloud.com",
              "Recovery must not retain the old service endpoint.",
            );
            const payload = JSON.parse(String(init?.body));
            return new Response(
              JSON.stringify({
                records: payload.records.map(
                  (record: { recordName: string }) =>
                    record.recordName.startsWith("List/")
                      ? {
                          recordName: record.recordName,
                          recordType: "List",
                          fields: {
                            Name: { type: "STRING", value: "Synthetic list" },
                          },
                        }
                      : {
                          recordName: record.recordName,
                          serverErrorCode: "NOT_FOUND",
                        },
                ),
              }),
            );
          }
          if (url.pathname.endsWith("/records/modify")) {
            dispatches++;
            return new Response("{}", { status: 503 });
          }
          assert.ok(url.pathname.endsWith("/records/query"));
          return new Response('{"records":[]}');
        };
        const service = new AppleConnectionService(env, owner);
        if (operation === "read")
          assert.equal(
            (
              await service.readForMCP(
                ControlledRead.parse({
                  action: "reminders",
                  listId: "List/SAFE",
                  includeCompleted: false,
                  expectedGeneration: setup.generation,
                }),
              )
            ).result.complete,
            true,
          );
        else
          await assert.rejects(
            service.mutate({
              action: "create",
              expectedGeneration: setup.generation,
              listId: "List/SAFE",
              title: "Synthetic reminder",
              idempotencyKey: "11111111-1111-4111-8111-111111111111",
            }),
            hasCode("WRITE_OUTCOME_UNKNOWN"),
          );
        assert.equal(
          lookups,
          2,
          "Exact preparation is repeated against fresh credentials.",
        );
        assert.equal(
          dispatches,
          operation === "read" ? 0 : 1,
          "A submitted mutation must never be replayed.",
        );
        assert.equal(
          requests.filter((request) => request.path.endsWith("/accountLogin"))
            .length,
          1,
        );
        assert.deepEqual(
          (await repository.load()).session.login,
          original.login,
        );
        db.sqlite.close();
      }
    } finally {
      globalThis.fetch = nativeFetch;
    }
  }));

test("authentication rejection after dispatch never starts recovery or repeats a mutation", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    const db = new SQLiteD1(),
      envelopes = key(),
      env = testEnv(db, envelopes),
      repository = new AppleSessionRepository(env, owner),
      original = appleSession();
    original.connection.remindersZoneOwner = "__defaultOwner__";
    original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
    const setup = await repository.begin(0);
    await repository.commit(setup, original, "READY");
    let dispatches = 0,
      setupRequests = 0;
    globalThis.fetch = async (value, init) => {
      const url = new URL(String(value));
      if (url.hostname === "setup.icloud.com") {
        setupRequests++;
        throw new Error("A dispatched write cannot enter recovery.");
      }
      if (url.pathname.endsWith("/records/modify")) {
        dispatches++;
        return new Response("{}", { status: 401 });
      }
      const payload = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          records: payload.records.map((record: { recordName: string }) =>
            record.recordName.startsWith("List/")
              ? {
                  recordName: record.recordName,
                  recordType: "List",
                  fields: {},
                }
              : { recordName: record.recordName, serverErrorCode: "NOT_FOUND" },
          ),
        }),
      );
    };
    try {
      await assert.rejects(
        new AppleConnectionService(env, owner).mutate({
          action: "create",
          expectedGeneration: setup.generation,
          listId: "List/SAFE",
          title: "Synthetic reminder",
          idempotencyKey: "11111111-1111-4111-8111-111111111111",
        }),
        AppError,
      );
      assert.equal(dispatches, 1);
      assert.equal(setupRequests, 0);
      assert.equal((await repository.status()).state, "READY");
    } finally {
      globalThis.fetch = nativeFetch;
      db.sqlite.close();
    }
  }));

test("cursor recovery never replays an acknowledged all-open callback", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    const db = new SQLiteD1(),
      envelopes = key(),
      env = testEnv(db, envelopes),
      repository = new AppleSessionRepository(env, owner),
      original = appleSession();
    original.auth.headers["X-Apple-TwoSV-Trust-Token"] = "synthetic-trust";
    original.connection.remindersZoneOwner = "__defaultOwner__";
    original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
    const setup = await repository.begin(0);
    await repository.commit(setup, original, "READY");
    let queries = 0;
    globalThis.fetch = async (value, init) => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/validate"))
        return new Response("{}", { status: 401 });
      if (url.pathname.endsWith("/accountLogin"))
        return new Response(JSON.stringify(acceptedAccount()));
      const body = JSON.parse(String(init?.body));
      if (body.query.recordType === "Lists")
        return new Response(
          '{"records":[{"recordName":"List/SAFE","recordType":"List","fields":{}}]}',
        );
      queries++;
      return new Response("{}", { status: 401 });
    };
    try {
      await assert.rejects(
        new AppleConnectionService(env, owner).readAllOpenForMCP(
          setup.generation,
        ),
        hasCode("RESTART_REQUIRED"),
      );
      const saved = await repository.load();
      assert.equal(queries, 1);
      assert.ok(saved.session.allOpenScan?.token);
      assert.equal(saved.session.allOpenScan?.index, 0);
      assert.equal(saved.session.allOpenScan?.cursor, null);
      assert.deepEqual(saved.session.login, original.login);
    } finally {
      globalThis.fetch = nativeFetch;
      db.sqlite.close();
    }
  }));

test("PCS expiry and explicit web-access approval do not revoke an otherwise valid account", async () =>
  fixedClock(async (clock) => {
    const nativeFetch = globalThis.fetch;
    const db = new SQLiteD1(),
      envelopes = key(),
      env = testEnv(db, envelopes),
      repository = new AppleSessionRepository(env, owner),
      original = appleSession();
    original.connection.remindersZoneOwner = "__defaultOwner__";
    original.renewal = { ...renewalCheckpoint(), lastValidatedAt: clock.now };
    original.pcs.expiresAt = clock.now - 1;
    const setup = await repository.begin(0);
    await repository.commit(setup, original, "READY");
    let prompts = 0;
    globalThis.fetch = async (value) => {
      const path = new URL(String(value)).pathname;
      if (path.endsWith("/records/query"))
        return new Response('{"records":[]}');
      if (path.endsWith("/records/lookup"))
        return new Response('{"serverErrorCode":"PCS_REQUIRED"}', {
          status: 403,
        });
      if (path.endsWith("/requestWebAccessState"))
        return new Response(
          '{"isICDRSDisabled":true,"isDeviceConsentedForPCS":false}',
        );
      if (path.endsWith("/enableDeviceConsentForPCS")) {
        prompts++;
        return new Response('{"isDeviceConsentNotificationSent":true}');
      }
      throw new Error("Unexpected PCS test endpoint.");
    };
    try {
      const service = new AppleConnectionService(env, owner);
      assert.equal(
        (await service.getCurrentLists(setup.generation)).result.complete,
        true,
      );
      assert.deepEqual((await repository.load()).session.login, original.login);
      await assert.rejects(
        service.readForMCP(
          ControlledRead.parse({
            action: "reminders",
            listId: "List/SAFE",
            expectedGeneration: setup.generation,
            includeCompleted: false,
          }),
        ),
        hasCode("DEVICE_APPROVAL_PENDING"),
      );
      assert.equal(
        (await repository.status()).state,
        "DEVICE_APPROVAL_PENDING",
      );
      assert.equal(
        prompts,
        0,
        "Permission handling and status must never send a device prompt.",
      );
      clock.now += 600_001;
      await assert.rejects(
        service.resume(setup.generation),
        hasCode("RESTART_REQUIRED"),
      );
      assert.equal(prompts, 0);
      await service.resume(setup.generation, true);
      assert.equal(prompts, 1);
      assert.deepEqual((await repository.load()).session.login, original.login);
    } finally {
      globalThis.fetch = nativeFetch;
      db.sqlite.close();
    }
  }));

async function injectPreviousSession(
  db: SQLiteD1,
  repository: AppleSessionRepository,
  obsolete: Record<string, unknown>,
) {
  const saved = await repository.load();
  const context = {
    ownerId: owner,
    accountId: "apple-reminders",
    generation: saved.fence.generation,
    recordId: "apple-session",
    schemaVersion: 1 as const,
  };
  const envelope = await repository.envelopes.encrypt(
    { ...saved.session, ...obsolete },
    context,
  );
  db.sqlite
    .prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?")
    .run(JSON.stringify(envelope), owner);
}

test("key-ring configuration is checked before any persistence can begin", () => {
  for (const ring of [
    null,
    [],
    [b64(new Uint8Array(32))],
    { key: 42 },
    { key: "wrong" },
    {},
  ]) {
    assert.throws(
      () => new Envelopes("key", ring as unknown as Record<string, string>),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "CONFIGURATION_REQUIRED",
    );
  }
});

test("Apple sessions are encrypted, owner-scoped, and restore the cookie jar", async () => {
  const db = new SQLiteD1();
  const repository = appleRepo(db);
  const setup = await repository.begin(0);
  const unknownMetadata = {
    retentionDays: null,
    retentionSource: null,
    lastValidatedAt: null,
    lastAppleSuccessAt: null,
    lastRenewedAt: null,
    nextRetryAt: null,
    requiredAction: null,
  };
  assert.deepEqual(await repository.status(), {
    generation: 1,
    version: 1,
    state: "CONNECTING",
    action: null,
    nextAttemptAt: 0,
    transportReady: false,
    liveReadValidated: false,
    expiresAt: null,
    ...unknownMetadata,
  });
  const session = appleSession();
  session.savedLists = mergeSavedLists(
    [],
    [{ id: "List/SAVED-PRIVATE-ID", title: "Private saved list" }],
  );
  session.directListSnapshot = { updatedAt: Date.now() };
  await repository.commit(setup, session, "READY");
  const row = db.sqlite
    .prepare(
      "SELECT * FROM apple_session_state WHERE owner_id = ? AND account_id = ?",
    )
    .get(owner, "apple-reminders") as Record<string, unknown>;
  const stored = JSON.stringify(row);
  for (const secret of [
    "header-session-secret",
    "cookie-session-secret",
    "123456789",
    "auth-session-123",
    "List/SAVED-PRIVATE-ID",
    "Private saved list",
    "PRIVATE-CATALOGUE-TOKEN",
    "a".repeat(64),
  ])
    assert.equal(stored.includes(secret), false);
  assert.equal(typeof row.envelope, "string");
  const loaded = await repository.load();
  assert.deepEqual(loaded.session, session);
  const restoredCookies = new CookieJar(loaded.session.auth.cookies);
  assert.match(
    restoredCookies.header(
      new URL("https://setup.icloud.com/setup/ws/1/accountLogin"),
    ) ?? "",
    /X-APPLE-WEBAUTH-TOKEN=cookie-session-secret/,
  );
  assert.deepEqual(await repository.status(), {
    generation: 1,
    version: 2,
    state: "READY",
    action: null,
    nextAttemptAt: 0,
    transportReady: true,
    liveReadValidated: false,
    expiresAt: session.login.expiresAt,
    ...unknownMetadata,
    retentionDays: 30,
    retentionSource: "interactive-consent",
  });

  const other = appleRepo(db, "other-owner", repository.envelopes);
  assert.equal((await other.status()).state, "DISCONNECTED");
  await assert.rejects(other.load());
  await other.disconnect();
  assert.equal((await repository.status()).state, "READY");
  const restarted = appleRepo(db, owner, repository.envelopes);
  assert.deepEqual(
    (await restarted.load()).session.savedLists,
    session.savedLists,
  );
  assert.deepEqual(
    (await restarted.load()).session.directListSnapshot,
    session.directListSnapshot,
  );
  const removed = mergeSavedLists(session.savedLists, [
    { id: "List/SAVED-PRIVATE-ID", deleted: true },
  ]);
  const fence = await restarted.claimRead(
    loaded.fence.generation,
    loaded.fence.version,
  );
  await restarted.commitResume(
    fence,
    { ...session, savedLists: removed },
    "READY",
  );
  assert.equal((await restarted.load()).session.savedLists?.[0].deleted, true);
  await restarted.disconnect();
  const next = await restarted.begin((await restarted.status()).generation);
  await restarted.commit(next, appleSession(), "READY");
  assert.equal((await restarted.load()).session.savedLists, undefined);
  assert.equal((await restarted.load()).session.directListSnapshot, undefined);
});

test("existing encrypted sessions discard retired catalogue state without disconnecting", async () => {
  const db = new SQLiteD1(),
    repository = appleRepo(db),
    session = appleSession();
  session.savedLists = mergeSavedLists(
    [],
    [{ id: "List/CURRENT", title: "Current snapshot" }],
  );
  session.directListSnapshot = { updatedAt: Date.now() };
  const setup = await repository.begin(0);
  await repository.commit(setup, session, "READY");
  await injectPreviousSession(db, repository, {
    diagnosticCatalogue: { token: "retired-diagnostic" },
    catalogueSync: { token: "expired-history", pending: true },
    catalogueAuto: { lastErrorCode: "RESTART_REQUIRED", pausedForError: true },
    legacySavedLists: [{ id: "List/OLD" }],
    allOpenScan: { token: crypto.randomUUID(), source: "legacy-catalogue" },
  });
  const loaded = await repository.load();
  assert.deepEqual(loaded.session, session);
  assert.equal((await repository.status()).state, "READY");
  const fence = await repository.claimRead(
    loaded.fence.generation,
    loaded.fence.version,
  );
  await repository.commitResume(fence, loaded.session, "READY");
  const encrypted = db.sqlite
    .prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?")
    .get(owner)?.envelope;
  const decoded = await repository.envelopes.decrypt<Record<string, unknown>>(
    JSON.parse(String(encrypted)),
    {
      ownerId: owner,
      accountId: "apple-reminders",
      generation: setup.generation,
      recordId: "apple-session",
      schemaVersion: 1,
    },
  );
  assert.deepEqual(decoded, session);
  for (const action of [
    "sync-catalogue",
    "catalogue-auto",
    "lists",
    "probe-other-zones",
  ])
    assert.equal(
      ControlledRead.safeParse({ action, expectedGeneration: setup.generation })
        .success,
      false,
    );
  db.sqlite.close();
});

test("Apple setup and disconnect fences reject stale commits and cancellation clears only its own commit", async () => {
  const db = new SQLiteD1();
  const repository = appleRepo(db);
  const stale = await repository.begin(0);
  const current = await repository.begin(stale.generation);
  await assert.rejects(repository.commit(stale, appleSession(), "READY"));
  await repository.commit(current, appleSession(), "READY");
  assert.equal(await repository.abandon(current), true);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  assert.equal((await repository.status()).generation, current.generation + 1);

  const cancelled = await repository.begin(current.generation + 1);
  await repository.disconnect();
  await assert.rejects(repository.commit(cancelled, appleSession(), "READY"));
  assert.equal((await repository.status()).state, "DISCONNECTED");

  const expired = await repository.begin(
    (await repository.status()).generation,
  );
  db.sqlite
    .prepare(
      "UPDATE apple_session_state SET transaction_expires_at = ? WHERE owner_id = ?",
    )
    .run(Date.now() - 1, owner);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  await assert.rejects(repository.commit(expired, appleSession(), "READY"));
});

test("PCS resume leases serialize and stale resume commits are fenced", async () => {
  const db = new SQLiteD1();
  const repository = appleRepo(db);
  const setup = await repository.begin(0);
  await repository.commit(
    setup,
    appleSession(),
    "DEVICE_APPROVAL_PENDING",
    "approve-device-consent",
  );
  const saved = await repository.status();
  const resume = await repository.claimResume(saved.generation, saved.version);
  await assert.rejects(repository.claimResume(saved.generation, saved.version));
  assert.equal(await repository.releaseResume(resume), true);
  await assert.rejects(
    repository.commitResume(resume, appleSession(), "READY"),
  );
  const next = await repository.status();
  const renewed = await repository.claimResume(next.generation, next.version);
  await repository.commitResume(
    renewed,
    (await repository.load()).session,
    "READY",
  );
  assert.equal((await repository.status()).state, "READY");
});

test("ready reads claim the same short lease before committing refreshed cookies", async () => {
  const db = new SQLiteD1();
  const repository = appleRepo(db);
  const setup = await repository.begin(0);
  await repository.commit(setup, appleSession(), "READY");
  const saved = await repository.status();
  const read = await repository.claimRead(saved.generation, saved.version);
  const restored = await repository.load();
  assert.equal(restored.fence.version, read.version);
  await assert.rejects(repository.claimRead(saved.generation, read.version));
  await repository.commitResume(read, restored.session, "READY");
  assert.equal((await repository.status()).version, read.version + 1);
});

test("session restoration follows bounded same-generation progress without adopting a replacement account", async () => {
  const db = new SQLiteD1();
  const repository = appleRepo(db);
  const session = appleSession();
  const setup = await repository.begin(0);
  await repository.commit(setup, session, "READY");
  const advanced = {
    ...session,
    savedLists: mergeSavedLists(
      [],
      [
        { id: "List/A", title: "A" },
        { id: "List/B", title: "B" },
        { id: "List/C", title: "C" },
      ],
    ),
  };
  const advance = async () => {
    db.afterStatement = null;
    const saved = await repository.load();
    const lease = await repository.claimRead(
      saved.fence.generation,
      saved.fence.version,
    );
    await repository.commitResume(lease, advanced, "READY");
  };
  try {
    db.afterStatement = async (sql) => {
      if (
        sql.startsWith("SELECT generation, version") &&
        sql.includes("envelope")
      )
        await advance();
    };
    const restored = await repository.load();
    assert.equal(restored.session.savedLists?.length, 3);
    db.afterStatement = async (sql) => {
      if (
        sql.startsWith("SELECT generation, version") &&
        !sql.includes("envelope")
      )
        await advance();
    };
    const status = await repository.status();
    assert.equal(status.state, "READY");
    assert.equal(status.version, (await repository.load()).fence.version);
    let attempts = 0;
    db.afterStatement = async (sql) => {
      if (
        sql.startsWith("SELECT generation, version") &&
        sql.includes("envelope")
      ) {
        attempts++;
        db.sqlite
          .prepare(
            "UPDATE apple_session_state SET version = version + 1 WHERE owner_id = ?",
          )
          .run(owner);
      }
    };
    await assert.rejects(
      repository.load(),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "CONFLICT" &&
        error.retryable,
    );
    assert.equal(attempts, 3);
    db.afterStatement = null;
    db.afterStatement = async (sql) => {
      if (
        !sql.startsWith("SELECT generation, version") ||
        !sql.includes("envelope")
      )
        return;
      db.afterStatement = null;
      await repository.disconnect();
      const next = await repository.begin(
        (await repository.status()).generation,
      );
      await repository.commit(next, appleSession(), "READY");
    };
    await assert.rejects(
      repository.load(),
      (error: unknown) =>
        error instanceof AppError && error.code === "CONFLICT",
    );
    assert.equal((await repository.status()).state, "READY");
    assert.notEqual(
      (await repository.load()).fence.generation,
      setup.generation,
    );
  } finally {
    db.afterStatement = null;
    db.sqlite.close();
  }
});

test("tampered ciphertext fails closed and an invalid decrypted snapshot is invalidated", async () => {
  const db = new SQLiteD1();
  const envelopes = key();
  const repository = appleRepo(db, owner, envelopes);
  const setup = await repository.begin(0);
  await repository.commit(setup, appleSession(), "READY");
  const row = db.sqlite
    .prepare("SELECT generation FROM apple_session_state WHERE owner_id = ?")
    .get(owner) as { generation: number };
  const context = {
    ownerId: owner,
    accountId: "apple-reminders",
    generation: row.generation,
    recordId: "apple-session",
    schemaVersion: 1 as const,
  };
  const saved = db.sqlite
    .prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?")
    .get(owner) as { envelope: string };
  const envelope = JSON.parse(saved.envelope) as { ciphertext: string };
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA`;
  db.sqlite
    .prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?")
    .run(JSON.stringify(envelope), owner);
  await assert.rejects(repository.load());

  const afterTamper = await repository.status();
  assert.equal(afterTamper.state, "DISCONNECTED");
  const next = await repository.begin(afterTamper.generation);
  await repository.commit(next, appleSession(), "READY");
  const second = await repository.status();
  const invalidContext = { ...context, generation: second.generation };
  const invalidSnapshot = await envelopes.encrypt(
    { ...appleSession(), unexpectedProof: "must-not-persist" },
    invalidContext,
  );
  db.sqlite
    .prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?")
    .run(JSON.stringify(invalidSnapshot), owner);
  await assert.rejects(repository.load());
  assert.equal((await repository.status()).state, "DISCONNECTED");
  const invalidated = db.sqlite
    .prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?")
    .get(owner) as { envelope: string | null };
  assert.equal(invalidated.envelope, null);
});

test("new permanent sessions restore decades later while read leases remain short and owner scoped", async () => {
  await fixedClock(async (clock) => {
    const db = new SQLiteD1(),
      repository = appleRepo(db),
      session = appleSession();
    session.login = loginAssurance(clock.now);
    assert.equal(session.login.version, 4);
    assert.equal(LoginAssuranceSchema.safeParse(session.login).success, true);
    const setup = await repository.begin(0);
    await repository.commit(setup, session, "READY");
    clock.now += 100 * 365 * 86_400_000;
    const status = await repository.status();
    assert.equal(status.state, "READY");
    assert.equal(status.expiresAt, null);
    assert.equal(status.retentionDays, null);
    const read = await repository.claimRead(status.generation, status.version);
    assert.ok(read.expiresAt - clock.now <= 30_000);
    await assert.rejects(
      appleRepo(db, "other-user").load(),
      hasCode("NOT_CONNECTED"),
    );
    const restored = await repository.load();
    assert.deepEqual(restored.session.login, session.login);
    assert.equal((await repository.status()).expiresAt, null);
    db.sqlite.close();
  });
});

test("absolute login expiry invalidates old policy sessions and cannot slide during operations", async () => {
  const db = new SQLiteD1(),
    repository = appleRepo(db),
    session = appleSession();
  session.login = loginAssurance(Date.now() - 10_000, true);
  const setup = await repository.begin(0);
  await repository.commit(setup, session, "READY");
  const saved = await repository.status(),
    read = await repository.claimRead(saved.generation, saved.version);
  await assert.rejects(
    repository.commitResume(
      read,
      { ...session, login: loginAssurance() },
      "READY",
    ),
    (e: any) => e.code === "VALIDATION_ERROR",
  );
  await repository.commitResume(read, session, "READY");
  assert.equal((await repository.status()).expiresAt, session.login.expiresAt);
  const context = {
    ownerId: owner,
    accountId: "apple-reminders",
    generation: saved.generation,
    recordId: "apple-session",
    schemaVersion: 1 as const,
  };
  const expired = await repository.envelopes.encrypt(
    {
      ...session,
      login: loginAssurance(Date.now() - SESSION_RETENTION_MS - 1, true),
    },
    context,
  );
  db.sqlite
    .prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?")
    .run(JSON.stringify(expired), owner);
  assert.equal((await repository.status()).state, "DISCONNECTED");
  assert.equal(
    db.sqlite
      .prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?")
      .get(owner)?.envelope,
    null,
  );
  const next = await repository.begin((await repository.status()).generation);
  await repository.commit(next, appleSession(), "READY");
  const legacy = omitField(appleSession(), "login");
  const old = await repository.envelopes.encrypt(legacy, {
    ...context,
    generation: next.generation,
  });
  db.sqlite
    .prepare("UPDATE apple_session_state SET envelope = ? WHERE owner_id = ?")
    .run(JSON.stringify(old), owner);
  await assert.rejects(
    repository.load(),
    (e: any) => e.code === "REAUTH_REQUIRED",
  );
});

test("an operation crossing expiry during encryption or the final SQL cannot return success", async () => {
  for (const boundary of ["encryption", "final-sql"]) {
    const db = new SQLiteD1(),
      repository = appleRepo(db),
      session = appleSession();
    const setup = await repository.begin(0);
    await repository.commit(setup, session, "READY");
    const status = await repository.status(),
      fence = await repository.claimRead(status.generation, status.version);
    const nativeNow = Date.now,
      nativeEncrypt = repository.envelopes.encrypt.bind(repository.envelopes);
    if (boundary === "encryption")
      repository.envelopes.encrypt = async (
        ...args: Parameters<Envelopes["encrypt"]>
      ) => {
        const result = await nativeEncrypt(...args);
        Date.now = () => session.login.expiresAt;
        return result;
      };
    else
      db.afterStatement = async (sql) => {
        if (
          sql.startsWith(
            "UPDATE apple_session_state SET version = version + 1, state = ?",
          )
        )
          Date.now = () => session.login.expiresAt;
      };
    try {
      await assert.rejects(
        repository.commitResume(fence, session, "READY"),
        (e: any) => e.code === "AUTH_EXPIRED",
      );
      assert.equal((await repository.status()).state, "DISCONNECTED");
      assert.equal(
        db.sqlite
          .prepare(
            "SELECT envelope FROM apple_session_state WHERE owner_id = ?",
          )
          .get(owner)?.envelope,
        null,
      );
    } finally {
      Date.now = nativeNow;
    }
  }
});

test("all-open reads cover selectable lists, resume live pages without skips, and fence encrypted continuations", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const db = new SQLiteD1();
  const repository = appleRepo(db);
  const session = appleSession();
  session.connection.remindersZoneOwner = "__defaultOwner__";
  session.savedLists = mergeSavedLists(
    [],
    [
      { id: "List/A", title: "A" },
      { id: "List/B", title: "B" },
      { id: "List/C", title: "C" },
      { id: "List/DELETED", deleted: true },
      { id: "List/GROUP", isGroup: true },
    ],
  );
  const setup = await repository.begin(0);
  await repository.commit(setup, session, "READY");
  const env = {
    ...db.env(),
    REMINDERS_OWNER_ID: owner,
    ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys),
    APPLE_SESSION_RENEWAL_ENABLED: "false",
    APPLE_LOGIN_ENABLED: "true",
    LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
    APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
  };
  const service = () => new AppleConnectionService(env, owner);
  const discovery = {
    records: [
      ...["A", "B", "C"].map((id) => ({
        recordName: `List/${id}`,
        recordType: "List",
        fields: { Name: { type: "STRING", value: id } },
      })),
      { recordName: "List/DELETED", deleted: true },
      {
        recordName: "List/GROUP",
        recordType: "List",
        fields: { IsGroup: { type: "INT64", value: 1 } },
      },
    ],
  };
  const reminder = (
    id: string,
    listId: string,
    extra: Record<string, unknown> = {},
  ) => ({
    recordName: `Reminder/${id}`,
    recordType: "Reminder",
    fields: {
      List: { type: "REFERENCE", value: { recordName: listId } },
      Completed: { type: "INT64", value: 0 },
      ...extra,
    },
  });
  const replies: {
    status?: number;
    body: unknown;
    headers?: Record<string, string>;
    after?: () => Promise<void>;
  }[] = [];
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      path: new URL(String(input)).pathname,
      body: JSON.parse(String(init?.body)),
    });
    const next = replies.shift();
    assert.ok(next, "Unexpected all-open request");
    if (next.after) await next.after();
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.headers,
    });
  };
  try {
    replies.push({ body: discovery });
    for (let page = 1; page <= 20; page++)
      replies.push({
        body: {
          records: [
            reminder(`A-${page}`, "List/A"),
            ...(page === 1
              ? [
                  reminder("COMPLETED", "List/A", {
                    Completed: { type: "INT64", value: 1 },
                  }),
                  reminder("DELETED", "List/A", {
                    Deleted: { type: "INT64", value: 1 },
                  }),
                  { recordName: "Reminder/TOMBSTONE", deleted: true },
                ]
              : []),
          ],
          continuationMarker: `A-page-${page}`,
        },
      });
    const partial = await service().readAllOpenForMCP(setup.generation);
    assert.equal(partial.result.complete, false);
    assert.equal(partial.result.records.length, 20);
    assert.equal(partial.result.progress.pagesRead, 20);
    assert.equal(partial.result.progress.listsTotal, 3);
    assert.equal(partial.result.progress.listsCompleted, 0);
    assert.deepEqual(
      partial.result.lists.map((list) => list.id),
      ["List/A", "List/B", "List/C"],
    );
    const token = partial.result.continuation!;
    const saved = (await repository.load()).session;
    assert.equal(saved.allOpenScan?.cursor, "A-page-20");
    assert.equal(JSON.stringify(saved).includes("Reminder/A-20"), false);
    const encrypted = String(
      db.sqlite
        .prepare("SELECT envelope FROM apple_session_state WHERE owner_id = ?")
        .get(owner)?.envelope,
    );
    assert.equal(encrypted.includes(token), false);
    assert.equal(encrypted.includes("A-page-20"), false);
    const requestsBeforeMismatch = requests.length;
    await assert.rejects(
      service().readAllOpenForMCP(setup.generation - 1, token),
      (error: unknown) =>
        error instanceof AppError && error.code === "CONFLICT",
    );
    const other = appleRepo(db, "other-all-open-owner", repository.envelopes);
    const otherSetup = await other.begin(0);
    await other.commit(otherSetup, session, "READY");
    await assert.rejects(
      new AppleConnectionService(env, "other-all-open-owner").readAllOpenForMCP(
        otherSetup.generation,
        token,
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "CONFLICT",
    );
    assert.equal(requests.length, requestsBeforeMismatch);
    replies.push(
      { body: { records: [reminder("A-LAST", "List/A")] } },
      { body: { records: [reminder("B", "List/B")] } },
      {
        body: {
          records: [reminder("C-FIRST", "List/C")],
          continuationMarker: "C-page-1",
        },
      },
      { body: { records: [reminder("C-LAST", "List/C")] } },
    );
    const resumed = await service().readAllOpenForMCP(setup.generation, token);
    assert.equal(resumed.result.complete, true);
    assert.equal(resumed.result.continuation, null);
    assert.equal(resumed.result.records.length, 4);
    assert.equal(resumed.result.progress.listsCompleted, 3);
    assert.equal(
      requests[requestsBeforeMismatch].body.continuationMarker,
      "A-page-20",
    );
    assert.equal((await repository.load()).session.allOpenScan, undefined);
    assert.ok(
      requests
        .slice(requestsBeforeMismatch)
        .every((request) => request.path.endsWith("/records/query")),
    );
    for (const request of requests.filter(
      (request) =>
        (request.body.query as { recordType?: string } | undefined)
          ?.recordType === "reminderList",
    )) {
      const query = request.body.query as {
        filterBy: { fieldName: string; fieldValue: { value: number } }[];
      };
      assert.equal(
        query.filterBy.find((filter) => filter.fieldName === "includeCompleted")
          ?.fieldValue.value,
        0,
      );
    }
    await assert.rejects(
      service().readAllOpenForMCP(setup.generation, token),
      (error: unknown) =>
        error instanceof AppError && error.code === "CONFLICT",
    );
    // A page that does not fit must be fetched again from the same cursor.
    const largeText = "x".repeat(64_000);
    const document = encodeDocument(largeText);
    const largePage = (prefix: string) =>
      Array.from({ length: 6 }, (_, index) =>
        reminder(`${prefix}-${index}`, "List/A", {
          TitleDocument: { type: "ENCRYPTED_BYTES", value: document },
          NotesDocument: { type: "ENCRYPTED_BYTES", value: document },
        }),
      );
    replies.push(
      { body: discovery },
      {
        body: {
          records: largePage("LARGE-FIRST"),
          continuationMarker: "large-next",
        },
      },
      { body: { records: largePage("LARGE-NEXT") } },
    );
    const byteLimited = await service().readAllOpenForMCP(setup.generation);
    assert.equal(byteLimited.result.complete, false);
    assert.equal(byteLimited.result.pendingReason, "response-limit");
    assert.equal(byteLimited.result.records.length, 6);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(byteLimited)).length <= 1_048_576,
    );
    assert.equal(
      (await repository.load()).session.allOpenScan?.cursor,
      "large-next",
    );
    assert.equal((await repository.load()).session.allOpenScan?.totalPages, 1);
    replies.push(
      { body: { records: largePage("LARGE-NEXT") } },
      { body: { records: [reminder("BYTE-B", "List/B")] } },
      { body: { records: [reminder("BYTE-C", "List/C")] } },
    );
    const byteResumed = await service().readAllOpenForMCP(
      setup.generation,
      byteLimited.result.continuation,
    );
    assert.equal(byteResumed.result.complete, true);
    assert.equal(byteResumed.result.records.length, 8);
    assert.equal(requests.at(-3)!.body.continuationMarker, "large-next");
    // Recoverable failures expose the current token without losing records or
    // acknowledging the failed page, including a failed first resume query.
    replies.push(
      { body: discovery },
      {
        body: {
          records: [reminder("TRANSIENT-FIRST", "List/A")],
          continuationMarker: "transient-next",
        },
      },
      { status: 503, body: {} },
    );
    const transient = await service().readAllOpenForMCP(setup.generation);
    assert.equal(transient.result.complete, false);
    assert.equal(transient.result.records.length, 1);
    assert.equal(transient.result.pendingReason, "read_error");
    assert.deepEqual(transient.result.errors, [
      { code: "UPSTREAM_UNAVAILABLE", retryable: true },
    ]);
    assert.equal(
      (await repository.load()).session.allOpenScan?.cursor,
      "transient-next",
    );
    replies.push({ status: 503, body: {} });
    const failedResume = await service().readAllOpenForMCP(
      setup.generation,
      transient.result.continuation,
    );
    assert.equal(failedResume.result.complete, false);
    assert.equal(failedResume.result.records.length, 0);
    assert.equal(failedResume.result.errors[0].code, "UPSTREAM_UNAVAILABLE");
    assert.notEqual(
      failedResume.result.continuation,
      transient.result.continuation,
    );
    assert.equal(
      (await repository.load()).session.allOpenScan?.cursor,
      "transient-next",
    );
    assert.equal((await repository.load()).session.allOpenScan?.totalPages, 1);
    await assert.rejects(
      service().readAllOpenForMCP(
        setup.generation,
        transient.result.continuation,
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "CONFLICT",
    );
    replies.push(
      { body: { records: [reminder("TRANSIENT-LAST", "List/A")] } },
      { body: { records: [reminder("TRANSIENT-B", "List/B")] } },
      { body: { records: [reminder("TRANSIENT-C", "List/C")] } },
    );
    const recovered = await service().readAllOpenForMCP(
      setup.generation,
      failedResume.result.continuation,
    );
    assert.equal(recovered.result.complete, true);
    assert.equal(recovered.result.records.length, 3);
    assert.equal(requests.at(-3)!.body.continuationMarker, "transient-next");
    replies.push(
      { body: discovery },
      {
        body: {
          records: [
            reminder("SAFE-ON-ERRORED-PAGE", "List/A"),
            { recordName: "Reminder/ERRORED", serverErrorCode: "CONFLICT" },
          ],
          continuationMarker: "unacknowledged-marker",
        },
      },
    );
    const recordFailure = await service().readAllOpenForMCP(setup.generation);
    assert.equal(recordFailure.result.complete, false);
    assert.equal(recordFailure.result.pendingReason, "record_errors");
    assert.equal(recordFailure.result.records.length, 0);
    assert.deepEqual(recordFailure.result.recordErrors, [
      { id: "Reminder/ERRORED", code: "CONFLICT" },
    ]);
    assert.equal((await repository.load()).session.allOpenScan?.cursor, null);
    assert.equal((await repository.load()).session.allOpenScan?.totalPages, 0);
    replies.push(
      { body: { records: [reminder("SAFE-ON-ERRORED-PAGE", "List/A")] } },
      { body: { records: [] } },
      { body: { records: [] } },
    );
    const recordRecovered = await service().readAllOpenForMCP(
      setup.generation,
      recordFailure.result.continuation,
    );
    assert.equal(recordRecovered.result.complete, true);
    assert.equal(recordRecovered.result.records.length, 1);
    replies.push(
      { body: discovery },
      { status: 429, body: {}, headers: { "retry-after": "30" } },
    );
    const throttled = await service().readAllOpenForMCP(setup.generation);
    assert.equal(throttled.result.complete, false);
    assert.equal(throttled.result.records.length, 0);
    assert.deepEqual(throttled.result.errors, [
      { code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 30 },
    ]);
    now += 30_000;
    replies.push(
      { body: { records: [reminder("RATE-RECOVERED", "List/A")] } },
      { body: { records: [] } },
      { body: { records: [] } },
    );
    assert.equal(
      (
        await service().readAllOpenForMCP(
          setup.generation,
          throttled.result.continuation,
        )
      ).result.complete,
      true,
    );
    // Expiry discards progress rather than reusing an old list/query snapshot.
    replies.push(
      { body: discovery },
      {
        body: {
          records: [reminder("EXPIRING", "List/A")],
          continuationMarker: "expiry-next",
        },
        after: async () => {
          now += 20_000;
        },
      },
    );
    const expiring = await service().readAllOpenForMCP(setup.generation);
    assert.equal(expiring.result.complete, false);
    now += 600_000;
    const beforeExpiry = requests.length;
    await assert.rejects(
      service().readAllOpenForMCP(
        setup.generation,
        expiring.result.continuation,
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "RESTART_REQUIRED",
    );
    assert.equal(requests.length, beforeExpiry);
    assert.equal((await repository.load()).session.allOpenScan, undefined);
    replies.push({ body: discovery }, { status: 401, body: {} });
    await assert.rejects(
      service().readAllOpenForMCP(setup.generation),
      (error: unknown) =>
        error instanceof AppError && error.code === "REAUTH_REQUIRED",
    );
    assert.equal(
      (await repository.status()).state,
      "READY",
      "A CloudKit rejection alone is not confirmed account revocation.",
    );
    const nextSetup = await repository.begin(
      (await repository.status()).generation,
    );
    await repository.commit(
      nextSetup,
      { ...session, login: loginAssurance() },
      "READY",
    );
    assert.equal((await repository.load()).session.allOpenScan, undefined);
    replies.push(
      { body: discovery },
      {
        body: { records: [reminder("LATE", "List/A")] },
        after: async () => {
          await repository.disconnect();
        },
      },
    );
    await assert.rejects(
      service().readAllOpenForMCP(nextSetup.generation),
      (error: unknown) =>
        error instanceof AppError &&
        ["NOT_CONNECTED", "CONFLICT"].includes(error.code),
    );
    assert.equal((await repository.status()).state, "DISCONNECTED");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    db.sqlite.close();
  }
});

test("direct list snapshots replace only after complete discovery and preserve failed refreshes", async () => {
  const originalFetch = globalThis.fetch;
  const db = new SQLiteD1(),
    repository = appleRepo(db),
    session = appleSession();
  session.savedLists = mergeSavedLists(
    [],
    [{ id: "List/OLD", title: "Previous snapshot" }],
  );
  const setup = await repository.begin(0);
  await repository.commit(setup, session, "READY");
  const env = {
    ...db.env(),
    REMINDERS_OWNER_ID: owner,
    ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys),
    APPLE_SESSION_RENEWAL_ENABLED: "false",
    APPLE_LOGIN_ENABLED: "true",
    LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
    APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
  };
  const service = () => new AppleConnectionService(env, owner);
  const zoneID = {
    zoneName: "Reminders",
    ownerRecordName: "synthetic-direct-owner",
  };
  const list = (id: string, title: string, extra = {}) => ({
    recordName: id,
    recordType: "List",
    zoneID,
    fields: {
      Name: { type: "STRING", value: title },
      Count: { type: "INT64", value: 0 },
      ...extra,
    },
  });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const replies: {
    body: unknown;
    status?: number;
    after?: () => Promise<void>;
  }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      path: new URL(String(input)).pathname,
      body: JSON.parse(String(init?.body)),
    });
    const next = replies.shift();
    assert.ok(next, "Unexpected direct discovery request");
    if (next.after) await next.after();
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  };
  try {
    replies.push(
      { body: { zones: [{ zoneID }] } },
      {
        body: {
          records: [
            list("List/EMPTY", "Empty list"),
            list("List/GROUP", "Group", {
              IsGroup: { type: "INT64", value: 1 },
            }),
          ],
          continuationMarker: "direct-next",
        },
      },
      {
        body: {
          records: [
            {
              ...list("List/DELETED", "Removed", {
                Deleted: { type: "INT64", value: 1 },
              }),
              deleted: false,
            },
            list("List/NEW", "Current name"),
          ],
        },
      },
    );
    const first = await service().getCurrentLists(setup.generation);
    assert.equal(first.result.complete, true);
    assert.equal(first.result.source, "direct-cloudkit-query");
    assert.equal(first.result.freshness.mode, "live");
    assert.equal(
      first.result.records.find((item) => item.id === "List/DELETED")?.deleted,
      true,
    );
    assert.equal(first.result.records.length, 4);
    assert.equal(first.result.records[0].count, 0);
    const snapshot = (await repository.load()).session;
    assert.equal(
      snapshot.savedLists?.some((item) => item.id === "List/OLD"),
      false,
    );
    assert.ok(
      requests.every((request) => !request.path.endsWith("/changes/zone")),
    );
    const count = requests.length;
    await service().read(
      ControlledRead.parse({
        action: "saved-lists",
        expectedGeneration: setup.generation,
      }),
    );
    assert.equal(
      requests.length,
      count,
      "Dashboard polling must be display-only",
    );
    // Record failures and HTTP errors never erase the last complete snapshot.
    for (const reply of [
      {
        body: {
          records: [{ recordName: "List/NEW", serverErrorCode: "BAD_REQUEST" }],
        },
      },
      { body: {}, status: 503 },
      { body: {}, status: 403 },
    ]) {
      replies.push(reply);
      await assert.rejects(
        service().getCurrentLists(setup.generation),
        AppError,
      );
      assert.deepEqual(
        (await repository.load()).session.savedLists,
        snapshot.savedLists,
      );
    }
    // Refresh reflects renames/removals and a genuinely empty collection.
    replies.push({ body: { records: [list("List/NEW", "Renamed")] } });
    await service().getCurrentLists(setup.generation);
    assert.deepEqual(
      (await repository.load()).session.savedLists?.map((item) => item.title),
      ["Renamed"],
    );
    replies.push({ body: { records: [] } });
    assert.equal(
      (await service().getCurrentLists(setup.generation)).result.records.length,
      0,
    );
    assert.deepEqual((await repository.load()).session.savedLists, []);
    // A failed encrypted commit cannot publish new summaries or corrupt saved ones.
    const encrypt = Envelopes.prototype.encrypt;
    replies.push({
      body: { records: [list("List/NEW", "Must not be saved")] },
    });
    Envelopes.prototype.encrypt = async () => {
      throw new Error("synthetic encryption failure");
    };
    try {
      await assert.rejects(service().getCurrentLists(setup.generation));
    } finally {
      Envelopes.prototype.encrypt = encrypt;
    }
    assert.deepEqual((await repository.load()).session.savedLists, []);
    replies.push({
      body: { records: [list("List/NEW", "Never committed")] },
      after: async () => {
        await repository.disconnect();
      },
    });
    await assert.rejects(
      service().getCurrentLists(setup.generation),
      (e: unknown) =>
        e instanceof AppError && ["NOT_CONNECTED", "CONFLICT"].includes(e.code),
    );
    assert.equal((await repository.status()).state, "DISCONNECTED");
    assert.equal(replies.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.sqlite.close();
  }
});

test("known-list reads authorize live without any historical checkpoint and fence failures", async () => {
  const originalFetch = globalThis.fetch,
    originalNow = Date.now;
  const db = new SQLiteD1(),
    repository = appleRepo(db),
    session = appleSession();
  const setup = await repository.begin(0);
  await repository.commit(setup, session, "READY");
  const env = {
    ...db.env(),
    ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys),
    APPLE_SESSION_RENEWAL_ENABLED: "false",
    APPLE_LOGIN_ENABLED: "true",
    LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
    APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
  };
  const service = () => new AppleConnectionService(env, owner);
  const input = (
    includeCompleted = false,
    continuation: string | null = null,
  ) =>
    ControlledRead.parse({
      action: "reminders",
      expectedGeneration: setup.generation,
      listId: "List/KNOWN",
      includeCompleted,
      continuation,
    });
  const zoneID = {
    zoneName: "Reminders",
    ownerRecordName: "synthetic-known-owner",
  };
  const list = {
    recordName: "List/KNOWN",
    recordType: "List",
    zoneID,
    fields: { Name: { type: "STRING", value: "Current authorized list" } },
  };
  const reminder = (id: string, completed: number, listId = "List/KNOWN") => ({
    recordName: id,
    recordType: "Reminder",
    zoneID,
    fields: {
      List: {
        type: "REFERENCE",
        value: { recordName: listId, action: "VALIDATE", zoneID },
      },
      Completed: { type: "INT64", value: completed },
    },
  });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const replies: {
    body: unknown;
    status?: number;
    headers?: Record<string, string>;
    after?: () => Promise<void>;
  }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init?.body)),
    });
    const reply = replies.shift();
    assert.ok(reply, "Unexpected known-list request");
    if (reply.after) await reply.after();
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.headers,
    });
  };
  try {
    replies.push(
      { body: { zones: [{ zoneID }] } },
      { body: { records: [list] } },
      {
        body: {
          records: [
            reminder("Reminder/OPEN", 0),
            reminder("Reminder/CLOSED", 1),
            { recordName: "Alarm/A", recordType: "Alarm", zoneID, fields: {} },
          ],
          continuationMarker: "known-next",
        },
      },
    );
    const first = await service().readForMCP(input());
    assert.deepEqual(
      (first.result.records as { id: string }[]).map((item) => item.id),
      ["Reminder/OPEN"],
    );
    assert.equal(first.result.continuation, "known-next");
    assert.equal(
      (await repository.load()).session.directListSnapshot,
      undefined,
    );
    await injectPreviousSession(db, repository, {
      catalogueSync: {
        token: "expired-checkpoint",
        initialComplete: false,
        pending: true,
      },
      catalogueAuto: {
        lastErrorCode: "RESTART_REQUIRED",
        pausedForError: true,
      },
    });
    replies.push(
      { body: { records: [list] } },
      { body: { records: [reminder("Reminder/CLOSED", 1)] } },
    );
    const second = await service().readForMCP(input(true, "known-next"));
    assert.equal(
      (second.result.records as { completed: boolean }[])[0].completed,
      true,
    );
    assert.equal(requests.at(-1)!.body.continuationMarker, "known-next");
    assert.ok(
      requests.every((request) => !request.path.endsWith("/changes/zone")),
    );
    for (const invalid of ["List/A/B", "List/ bad", "List/a\n", "Reminder/A"])
      assert.equal(
        ControlledRead.safeParse({ ...input(), listId: invalid }).success,
        false,
      );
    for (const bad of [
      { ...list, deleted: true },
      { ...list, fields: { IsGroup: { type: "INT64", value: 1 } } },
      { recordName: list.recordName, serverErrorCode: "NOT_FOUND" },
      { ...list, zoneID: { ...zoneID, ownerRecordName: "other-owner" } },
    ]) {
      const before = requests.length;
      replies.push({ body: { records: [bad] } });
      await assert.rejects(service().readForMCP(input()), AppError);
      assert.equal(requests.length, before + 1);
    }
    for (const reply of [
      { status: 403, body: {} },
      { status: 429, headers: { "retry-after": "9" }, body: {} },
      { status: 503, body: {} },
      { body: { records: [{}] } },
    ]) {
      replies.push(reply);
      await assert.rejects(service().readForMCP(input()), AppError);
    }
    replies.push(
      { body: { records: [list] } },
      { body: { records: [reminder("Reminder/OTHER", 0, "List/OTHER")] } },
    );
    await assert.rejects(
      service().readForMCP(input()),
      (e: unknown) => e instanceof AppError && e.code === "PROTOCOL_CHANGED",
    );
    replies.push(
      { body: { records: [list] } },
      {
        body: { records: [] },
        after: async () => {
          Date.now = () => session.login.expiresAt;
        },
      },
    );
    await assert.rejects(
      service().readForMCP(input()),
      (e: unknown) => e instanceof AppError && e.code === "AUTH_EXPIRED",
    );
    Date.now = originalNow;
    assert.equal((await repository.status()).state, "DISCONNECTED");
    assert.equal(replies.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    db.sqlite.close();
  }
});

test("direct all-open resumes its original list selection without rediscovery after a refresh", async () => {
  const originalFetch = globalThis.fetch,
    originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const db = new SQLiteD1(),
    repository = appleRepo(db),
    session = appleSession();
  session.connection.remindersZoneOwner = "__defaultOwner__";
  const setup = await repository.begin(0);
  await repository.commit(setup, session, "READY");
  const env = {
    ...db.env(),
    ENCRYPTION_KEYS_JSON: JSON.stringify(repository.envelopes.keys),
    APPLE_SESSION_RENEWAL_ENABLED: "false",
    APPLE_LOGIN_ENABLED: "true",
    LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
    APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
  };
  const service = () => new AppleConnectionService(env, owner);
  const list = (id: string, extra = {}) => ({
    recordName: id,
    recordType: "List",
    fields: { Name: { type: "STRING", value: id.slice(5) }, ...extra },
  });
  const reminder = (id: string, listId: string) => ({
    recordName: id,
    recordType: "Reminder",
    fields: {
      List: {
        type: "REFERENCE",
        value: { recordName: listId, action: "VALIDATE" },
      },
      Completed: { type: "INT64", value: 0 },
    },
  });
  const requests: Record<string, unknown>[] = [];
  const replies: { body: unknown; after?: () => void }[] = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const next = replies.shift();
    assert.ok(next, "Unexpected direct all-open request");
    next.after?.();
    return new Response(JSON.stringify(next.body));
  };
  try {
    replies.push(
      {
        body: {
          records: [
            list("List/A"),
            list("List/EMPTY"),
            list("List/GROUP", { IsGroup: { type: "INT64", value: 1 } }),
            list("List/DELETED", { Deleted: { type: "INT64", value: 1 } }),
          ],
        },
      },
      {
        body: {
          records: [reminder("Reminder/A1", "List/A")],
          continuationMarker: "a-next",
        },
        after: () => {
          now += 20_000;
        },
      },
    );
    const first = await service().readAllOpenForMCP(setup.generation);
    assert.equal(first.result.complete, false);
    assert.equal(first.result.pendingReason, "deadline");
    assert.equal(first.result.progress.listsTotal, 2);
    assert.equal(first.result.source, "direct-cloudkit-query");
    assert.deepEqual(
      first.result.records.map((item) => item.id),
      ["Reminder/A1"],
    );
    const token = first.result.continuation!;
    // Another complete retrieval removes A from the dashboard snapshot, but
    // cannot skip its outstanding all-open page or change this operation's lists.
    replies.push({ body: { records: [list("List/NEW")] } });
    await service().getCurrentLists(setup.generation);
    assert.equal(
      (await repository.load()).session.savedLists?.[0].id,
      "List/NEW",
    );
    const beforeResume = requests.length;
    replies.push(
      { body: { records: [reminder("Reminder/A2", "List/A")] } },
      { body: { records: [] } },
    );
    const resumed = await service().readAllOpenForMCP(setup.generation, token);
    assert.equal(resumed.result.complete, true);
    assert.deepEqual(
      resumed.result.records.map((item) => item.id),
      ["Reminder/A2"],
    );
    assert.deepEqual(
      resumed.result.lists.map((item) => item.id),
      ["List/A", "List/EMPTY"],
    );
    assert.equal(requests[beforeResume].continuationMarker, "a-next");
    assert.ok(
      requests
        .slice(beforeResume)
        .every(
          (body) =>
            (body.query as { recordType: string }).recordType ===
            "reminderList",
        ),
    );
    const beforeReplay = requests.length;
    await assert.rejects(
      service().readAllOpenForMCP(setup.generation, token),
      (e: unknown) => e instanceof AppError && e.code === "CONFLICT",
    );
    assert.equal(requests.length, beforeReplay);
    replies.push(
      { body: { records: [list("List/A")] } },
      {
        body: { records: [], continuationMarker: "other-next" },
        after: () => {
          now += 20_000;
        },
      },
    );
    const pending = await service().readAllOpenForMCP(setup.generation);
    await repository.disconnect();
    const nextSetup = await repository.begin(
      (await repository.status()).generation,
    );
    await repository.commit(nextSetup, appleSession(), "READY");
    await assert.rejects(
      service().readAllOpenForMCP(
        nextSetup.generation,
        pending.result.continuation,
      ),
      (e: unknown) => e instanceof AppError && e.code === "CONFLICT",
    );
    assert.equal((await repository.load()).session.allOpenScan, undefined);
    assert.equal(replies.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    db.sqlite.close();
  }
});
