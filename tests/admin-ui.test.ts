import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { adminPage } from "../src/admin.ts";
import { mountAdmin } from "../src/app/admin-client.ts";
import { CredentialInput } from "../src/services/config.ts";
const services = [
  "calendar",
  "contacts",
  "reminders",
  "notes",
  "photos",
  "drive",
];
const base = () => ({
  web: {
    generation: 4,
    state: "DEVICE_APPROVAL_PENDING",
    gates: { enabled: true },
  },
  webSessionAvailable: true,
  dav: { configured: true, version: 7 },
  services: services.map((service) => ({
    service,
    enabled: false,
    writable: false,
    credentialAvailable: true,
    pcsReady: service === "calendar" || service === "contacts" ? null : false,
  })),
  pcsProgress: {},
});
async function setup(send?: typeof fetch, confirm = () => true) {
  const { document, window } = parseHTML(await adminPage().text());
  Object.defineProperty(document, "location", {
    value: { origin: "https://synthetic.test" },
  });
  const state = base(),
    requests: any[] = [];
  const backend = async (path: any, init: any) => {
    requests.push({ path, init });
    if (path === "/api/admin/status") return Response.json(state);
    const value = JSON.parse(init.body);
    if (path === "/api/admin/service")
      Object.assign(
        state.services.find((s) => s.service === value.service)!,
        value,
      );
    return Response.json({ state: "DEVICE_APPROVAL_PENDING" });
  };
  const ui = mountAdmin(
    document as unknown as Document,
    send ?? (backend as any),
    confirm,
  );
  const settle = async () => {
    for (let i = 0; i < 100 && ui.busy; i++)
      await new Promise((r) => setTimeout(r, 1));
    assert.equal(ui.busy, false);
  };
  const el = (id: string) => document.getElementById(id)! as any;
  return { document, window, ui, state, requests, el, settle };
}
test("management locks actions until status is loaded and uses six accessible service cards", async () => {
  let resolve!: (r: Response) => void;
  const h = await setup(
    (async () => new Promise((r) => (resolve = r))) as typeof fetch,
  );
  try {
    assert.equal(h.el("dav-fields").disabled, true);
    assert.equal(h.el("connect").getAttribute("aria-disabled"), "true");
    resolve(Response.json(h.state));
    await h.settle();
    assert.equal(h.document.querySelectorAll("article.card").length, 6);
    assert.equal(
      h.document.querySelectorAll('[data-kind="writable"]').length,
      3,
    );
    assert.equal(h.el("dav-fields").disabled, false);
    assert.equal(h.el("mcp-url").value, "https://synthetic.test/mcp");
    assert.equal(
      h.document.querySelector("html")?.getAttribute("lang"),
      "zh-CN",
    );
    assert.ok(!h.document.querySelector("table"));
  } finally {
    h.ui.destroy();
  }
});
test("disabling a service clears write permission and serializes repeated changes", async () => {
  const h = await setup();
  try {
    await h.settle();
    h.state.services[0].enabled = true;
    h.state.services[0].writable = true;
    h.el("refresh").click();
    await h.settle();
    const input = h.document.querySelector(
      'input[data-service="calendar"][data-kind="enabled"]',
    ) as any;
    input.checked = false;
    input.dispatchEvent(new h.window.Event("change"));
    input.checked = true;
    input.dispatchEvent(new h.window.Event("change"));
    await h.settle();
    const posts = h.requests.filter((r) => r.path === "/api/admin/service");
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].init.body), {
      service: "calendar",
      enabled: false,
      writable: false,
    });
    assert.equal(h.state.services[0].writable, false);
  } finally {
    h.ui.destroy();
  }
});
test("app password paste normalizes groups, clears the input and sends the current version", async () => {
  const h = await setup();
  try {
    await h.settle();
    h.el("account").value = " synthetic@example.invalid ";
    h.el("password").value = "aaaa bbbb-cccc dddd";
    h.el("dav").dispatchEvent(
      new h.window.Event("submit", { cancelable: true }),
    );
    assert.equal(h.el("password").value, "");
    await h.settle();
    const request = h.requests.find((r) => r.path === "/api/admin/credentials");
    assert.deepEqual(JSON.parse(request.init.body), {
      account: "synthetic@example.invalid",
      password: "aaaabbbbccccdddd",
      expectedVersion: 7,
    });
    assert.ok(!h.el("notice").textContent.includes("aaaa"));
    const parsed = CredentialInput.parse({
      account: " synthetic@example.invalid ",
      password: "aaaa bbbb-cccc dddd",
      expectedVersion: 7,
    });
    assert.equal(parsed.password, "aaaa-bbbb-cccc-dddd");
    assert.throws(() =>
      CredentialInput.parse({
        account: "synthetic@example.invalid",
        password: "Primary password!",
        expectedVersion: 7,
      }),
    );
  } finally {
    h.ui.destroy();
  }
});
test("PCS waiting buttons reflect persisted per-service delay without polling Apple", async () => {
  const h = await setup();
  try {
    await h.settle();
    (h.state.pcsProgress as any).photos = {
      nextAttemptAt: Date.now() + 60000,
      expiresAt: Date.now() + 600000,
      exhausted: false,
    };
    h.el("refresh").click();
    await h.settle();
    const button = h.document.querySelector(
      'button[data-service="photos"][data-kind="pcs"]',
    ) as any;
    assert.equal(button.disabled, true);
    assert.match(button.textContent, /等待.*秒/);
    const ready = h.document.querySelector(
      'button[data-service="notes"][data-kind="pcs"]',
    ) as any;
    assert.equal(ready.disabled, false);
    ready.click();
    await h.settle();
    assert.equal(
      h.requests.filter((r) => r.path === "/api/admin/pcs").length,
      1,
    );
    assert.match(h.el("notice").textContent, /可信设备/);
  } finally {
    h.ui.destroy();
  }
});
test("cancelled destructive credential/session actions do not send requests", async () => {
  const h = await setup(undefined, () => false);
  try {
    await h.settle();
    h.el("remove").click();
    h.el("disconnect").click();
    assert.equal(h.requests.filter((r) => r.init.method === "POST").length, 0);
  } finally {
    h.ui.destroy();
  }
});
test("failed permission updates restore saved state and display actionable errors", async () => {
  const state = base();
  const h = await setup((async (path, init) =>
    String(path) === "/api/admin/status"
      ? Response.json(state)
      : Response.json(
          { error: { code: "CONFLICT" } },
          { status: 409 },
        )) as typeof fetch);
  try {
    await h.settle();
    const input = h.document.querySelector(
      'input[data-service="calendar"][data-kind="enabled"]',
    ) as any;
    input.checked = true;
    input.dispatchEvent(new h.window.Event("change"));
    await h.settle();
    assert.equal(
      (
        h.document.querySelector(
          'input[data-service="calendar"][data-kind="enabled"]',
        ) as any
      ).checked,
      false,
    );
    assert.match(h.el("notice").textContent, /CONFLICT.*刷新/);
    assert.equal(h.el("notice").dataset.error, "true");
  } finally {
    h.ui.destroy();
  }
});
test("expired Access HTML disables credential submission and permits status retry", async () => {
  let failed = true;
  const h = await setup((async () =>
    failed
      ? new Response("<html>Access login</html>", {
          headers: { "content-type": "text/html" },
        })
      : Response.json(base())) as typeof fetch);
  try {
    await h.settle();
    assert.equal(h.el("dav-fields").disabled, true);
    assert.match(h.el("notice").textContent, /SESSION_EXPIRED/);
    failed = false;
    h.el("refresh").click();
    await h.settle();
    assert.equal(h.el("dav-fields").disabled, false);
  } finally {
    h.ui.destroy();
  }
});
