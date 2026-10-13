import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { credentialDocument } from "../src/auth/credential-page.ts";
const goodStatus = {
  generation: 4,
  gates: { enabled: true, loginPolicy: "device-only-v2" },
  message: "",
};
const script = await build({
  entryPoints: ["src/auth/credential-entry.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  plugins: [
    {
      name: "synthetic-proof-client",
      setup(b) {
        b.onLoad({ filter: /apple-auth-client\.ts$/ }, () => ({
          contents:
            "export const beginAppleSignIn=(...args)=>globalThis.syntheticBegin(...args);",
          loader: "js",
        }));
      },
    },
  ],
});
async function setup(send: typeof fetch, begin: any = () => ({ cancel() {} })) {
  const { document, window } = parseHTML(
    await credentialDocument(
      new Request("https://synthetic.test/connect/apple"),
      {
        APPLE_LOGIN_ENABLED: "true",
        APPLE_SESSION_RETENTION_WRITES: "absolute-30d-v1",
      },
    ).text(),
  );
  const timers = new Set<any>();
  const context = {
    document,
    window,
    fetch: send,
    AbortController,
    Date,
    console,
    syntheticBegin: begin,
    setTimeout: (fn: any, ms: number) => {
      const timer = setTimeout(fn, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (id: any) => {
      clearTimeout(id);
      timers.delete(id);
    },
  };
  for (const id of ["credentials", "verification"])
    (document.getElementById(id) as any).reportValidity = () => true;
  runInNewContext(script.outputFiles[0].text, context);
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1));
  };
  const el = (id: string) => document.getElementById(id)! as any;
  return {
    document,
    window,
    el,
    settle,
    destroy() {
      window.dispatchEvent(new window.Event("pagehide"));
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
test("login status failure keeps credentials disabled and a retry restores the form", async () => {
  let failures = true;
  const h = await setup((async () =>
    failures
      ? new Response("", { status: 403 })
      : Response.json(goodStatus)) as typeof fetch);
  try {
    await h.settle();
    assert.equal(h.el("fields").disabled, true);
    assert.equal(h.el("retry-status").hidden, false);
    failures = false;
    h.el("retry-status").click();
    await h.settle();
    assert.equal(h.el("fields").disabled, false);
    assert.equal(h.el("retry-status").hidden, true);
    assert.match(h.el("message").textContent, /主密码/);
    assert.equal(
      h.document.querySelector("html")!.getAttribute("lang"),
      "zh-CN",
    );
  } finally {
    h.destroy();
  }
});
test("login clears secrets, exposes code only at the actual challenge and returns to service PCS setup", async () => {
  let update: any,
    beginCount = 0,
    submitted = "";
  const h = await setup(
    (async () => Response.json(goodStatus)) as typeof fetch,
    (
      account: string,
      password: string,
      consent: any,
      generation: number,
      onUpdate: any,
    ) => {
      beginCount++;
      assert.equal(account, "synthetic@example.invalid");
      assert.equal(password, "synthetic-primary");
      assert.equal(generation, 4);
      update = onUpdate;
      onUpdate({ state: "working", message: "synthetic" });
      return {
        cancel() {},
        async submitCode(code: string) {
          submitted = code;
          onUpdate({ state: "working", message: "synthetic" });
        },
      };
    },
  );
  try {
    await h.settle();
    h.el("account").value = "synthetic@example.invalid";
    h.el("password").value = "synthetic-primary";
    h.el("apple-trust").checked = true;
    h.el("retention").checked = true;
    h.el("credentials").dispatchEvent(
      new h.window.Event("submit", { cancelable: true }),
    );
    await h.settle();
    assert.equal(beginCount, 1);
    assert.equal(h.el("password").value, "");
    assert.equal(h.el("verification-panel").hidden, true);
    update({ state: "code", method: "trusted-device" });
    assert.equal(h.el("verification-panel").hidden, false);
    assert.equal(h.el("verification-fields").disabled, false);
    h.el("code").value = "123456";
    h.el("verification").dispatchEvent(
      new h.window.Event("submit", { cancelable: true }),
    );
    assert.equal(h.el("code").value, "");
    await h.settle();
    assert.equal(submitted, "123456");
    assert.equal(h.el("verification-fields").disabled, true);
    update({
      state: "complete",
      result: {
        state: "DEVICE_APPROVAL_PENDING",
        expiresAt: null,
      },
    });
    assert.equal(h.el("continue").hidden, false);
    assert.equal(h.el("continue").getAttribute("href"), "/admin");
    assert.match(h.el("message").textContent, /网页会话已加密保存/);
    assert.match(h.el("message").textContent, /本地永久保留/);
    assert.match(h.el("message").textContent, /授权/);
    assert.ok(!h.el("message").textContent.includes("123456"));
  } finally {
    h.destroy();
  }
});
test("an unsupported Apple challenge leaves a recoverable form and a visible error code", async () => {
  let update: any;
  const h = await setup(
    (async () => Response.json(goodStatus)) as typeof fetch,
    (_a: any, _p: any, _c: any, _g: any, cb: any) => {
      update = cb;
      return { cancel() {} };
    },
  );
  try {
    await h.settle();
    h.el("account").value = "synthetic@example.invalid";
    h.el("password").value = "synthetic-primary";
    h.el("credentials").dispatchEvent(
      new h.window.Event("submit", { cancelable: true }),
    );
    await h.settle();
    update({ state: "failed", code: "UNSUPPORTED_AUTH", message: "synthetic" });
    assert.equal(h.el("fields").disabled, false);
    assert.equal(h.el("verification-panel").hidden, true);
    assert.match(h.el("message").textContent, /UNSUPPORTED_AUTH.*短信/);
    assert.equal(h.el("password").value, "");
  } finally {
    h.destroy();
  }
});

for (const detail of [
  "Apple browser-trust: redirect response has no Location header (HTTP 302, redirects 0/8).",
  "Apple device-verification: redirect loop without session progress (HTTP 302, redirects 2/3).",
  "Apple browser-trust: redirect limit exceeded (HTTP 302, redirects 8/8).",
]) test(`login preserves actionable redirect detail: ${detail}`, async () => {
  let update: any;
  const h = await setup(
    (async () => Response.json(goodStatus)) as typeof fetch,
    (_a: any, _p: any, _c: any, _g: any, cb: any) => {
      update = cb;
      return { cancel() {} };
    },
  );
  try {
    await h.settle();
    h.el("account").value = "synthetic@example.invalid";
    h.el("password").value = "synthetic-primary";
    h.el("credentials").dispatchEvent(new h.window.Event("submit", { cancelable: true }));
    await h.settle();
    update({ state: "failed", code: "APPLE_REDIRECT_ERROR", message: detail });
    assert.ok(h.el("message").textContent.includes(detail));
    assert.equal(h.el("fields").disabled, false);
    assert.equal(h.el("password").value, "");
  } finally { h.destroy(); }
});
