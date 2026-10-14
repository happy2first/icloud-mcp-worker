import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import fixtures from "./fixtures/protocol.json" with { type: "json" };
import { b64, unhex } from "../src/crypto/bytes.ts";
import { AUTH_LIFETIME_MS } from "../src/auth/apple/protocol.ts";

// Keep the real browser state machine and event sequence/schema validation.
// Only the cryptographic computation is stubbed; its transcripts are tested separately.
const bundle = await build({
  entryPoints: ["src/app/apple-auth-client.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "SignIn",
  platform: "browser",
  target: "es2022",
  plugins: [
    {
      name: "proof-stub",
      setup(b) {
        b.onLoad({ filter: /browser-proof\.ts$/ }, () => ({
          loader: "js",
          contents: `export class BrowserSrpProof { publicA(){return "synthetic-A"} async prove(){return {m1:"synthetic-m1",m2:"synthetic-m2"}} clear(){} } export class BrowserBridgeProof { async first(){return "share"} async share(){return "share"} async confirm(){return "confirmation"} async decrypt(){return "123456"} clear(){} }`,
        }));
      },
    },
  ],
});
const binding = {
  direction: "server",
  transactionId: "11111111-2222-4333-8444-555555555555",
  nonce: "a".repeat(64),
};
const srp = fixtures.srp[0];
function harness(findMy: boolean) {
  let instance: any;
  const updates: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    listeners = new Map<string, Array<(e: any) => void>>();
    constructor(readonly url: URL) {
      instance = this;
    }
    addEventListener(name: string, fn: (e: any) => void) {
      const list = this.listeners.get(name) ?? [];
      list.push(fn);
      this.listeners.set(name, list);
    }
    send(value: string) {
      this.sent.push(JSON.parse(value));
    }
    close() {
      this.readyState = 3;
      for (const fn of this.listeners.get("close") ?? []) fn({});
    }
    emit(event: any) {
      for (const fn of this.listeners.get("message") ?? [])
        fn({ data: JSON.stringify({ ...binding, ...event }) });
    }
  }
  const ctx = {
    atob,
    btoa,
    TextEncoder,
    TextDecoder,
    URL,
    WebSocket: Socket,
    location: {
      protocol: "https:",
      hostname: "synthetic.test",
      origin: "https://synthetic.test",
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
  };
  runInNewContext(bundle.outputFiles[0].text, ctx);
  const handle = (ctx as any).SignIn.beginAppleSignIn(
    "account@example.invalid",
    "synthetic-password",
    {
      appleTrust: true,
      persistentSession: true,
      ...(findMy ? { service: "findmy" } : {}),
    },
    12,
    (u: any) => updates.push(u),
  );
  const flush = () => new Promise((r) => setImmediate(r));
  const hello = async () => {
    instance.emit({
      type: "hello",
      sequence: 0,
      generation: 13,
      expiresAt: Date.now() + AUTH_LIFETIME_MS,
      lifetimeMs: AUTH_LIFETIME_MS,
    });
    await flush();
  };
  const challenge = async () => {
    instance.emit({
      type: "srp-challenge",
      sequence: 1,
      challenge: {
        salt: b64(unhex(srp.salt)),
        b: b64(unhex(srp.B)),
        c: "synthetic-c",
        iteration: srp.iterations,
        keyLength: 32,
        protocol: srp.protocol,
      },
    });
    await flush();
  };
  return { socket: instance, updates, flush, hello, challenge, handle };
}
test("Find My browser accepts READY immediately after a successful password proof without requesting a code", async () => {
  const h = harness(true);
  await h.hello();
  await h.challenge();
  assert.deepEqual(
    h.socket.sent.map((x: any) => x.type),
    ["start", "srp-proof"],
  );
  h.socket.emit({
    type: "complete",
    sequence: 2,
    state: "READY",
    nextAttemptAt: 0,
    expiresAt: null,
  });
  await h.flush();
  assert.equal(h.updates.at(-1).state, "complete");
  assert.equal(
    h.updates.some((x) => x.state === "failed" || x.state === "code"),
    false,
  );
  assert.equal(
    JSON.stringify(h.socket.sent).includes("synthetic-password"),
    false,
  );
});
test("initial browser sign-in still rejects completion without device verification", async () => {
  const h = harness(false);
  await h.hello();
  await h.challenge();
  h.socket.emit({
    type: "complete",
    sequence: 2,
    state: "READY",
    nextAttemptAt: 0,
    expiresAt: null,
  });
  await h.flush();
  assert.equal(h.updates.at(-1).state, "failed");
});
test("Find My completion before the password proof is rejected", async () => {
  const h = harness(true);
  await h.hello();
  h.socket.emit({
    type: "complete",
    sequence: 1,
    state: "READY",
    nextAttemptAt: 0,
    expiresAt: null,
  });
  await h.flush();
  assert.equal(h.updates.at(-1).state, "failed");
});
test("Apple-requested device verification still completes through the entire bridge in both modes", async () => {
  for (const findMy of [false, true]) {
    const h = harness(findMy);
    await h.hello();
    await h.challenge();
    h.socket.emit({
      type: "bridge-challenge",
      sequence: 2,
      salt: "synthetic-salt",
    });
    await h.flush();
    assert.equal(h.updates.at(-1).state, "code");
    await h.handle.submitCode("123456");
    h.socket.emit({
      type: "bridge-response",
      sequence: 3,
      serverShare: "synthetic-share",
      serverConfirmation: "synthetic-confirmation",
    });
    await h.flush();
    h.socket.emit({
      type: "bridge-encrypted",
      sequence: 4,
      encryptedCode: "synthetic-encrypted",
    });
    await h.flush();
    assert.equal(
      h.updates.some((x) => x.state === "complete"),
      false,
    );
    assert.deepEqual(
      h.socket.sent.map((x: any) => x.type),
      [
        "start",
        "srp-proof",
        "bridge-share",
        "bridge-confirmation",
        "bridge-validation",
      ],
    );
    h.socket.emit({
      type: "complete",
      sequence: 5,
      state: "READY",
      nextAttemptAt: 0,
      expiresAt: null,
    });
    await h.flush();
    assert.equal(h.updates.at(-1).state, "complete");
  }
});
test("Find My direct completion still rejects another transaction's nonce", async () => {
  const h = harness(true);
  await h.hello();
  await h.challenge();
  h.socket.emit({
    type: "complete",
    sequence: 2,
    nonce: "b".repeat(64),
    state: "READY",
    nextAttemptAt: 0,
    expiresAt: null,
  });
  await h.flush();
  assert.equal(h.updates.at(-1).state, "failed");
});
