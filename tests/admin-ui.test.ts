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
  "findmy",
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
    connection: null as any,
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
    requests: any[] = [],
    copied: string[] = [];
  const backend = async (path: any, init: any) => {
    requests.push({ path, init });
    if (path === "/api/admin/status") return Response.json(state);
    const value = JSON.parse(init.body);
    if (path === "/api/admin/credentials") {
      state.dav.configured = true;
      state.dav.version++;
    }
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
    async (text) => {
      copied.push(text);
    },
  );
  const settle = async () => {
    for (let i = 0; i < 100 && ui.busy; i++)
      await new Promise((r) => setTimeout(r, 1));
    assert.equal(ui.busy, false);
  };
  const el = (id: string) => document.getElementById(id)! as any;
  return { document, window, ui, state, requests, copied, el, settle };
}
test("management locks actions until status is loaded and uses seven accessible service cards", async () => {
  let resolve!: (r: Response) => void;
  const h = await setup(
    (async () => new Promise((r) => (resolve = r))) as typeof fetch,
  );
  try {
    assert.equal(h.el("dav-fields").disabled, true);
    assert.equal(h.el("connect").getAttribute("aria-disabled"), "true");
    resolve(Response.json(h.state));
    await h.settle();
    assert.equal(h.document.querySelectorAll("article.card").length, 7);
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
test("configuration failure identifies the Secret, clears loading text and recovers without an Apple request", async () => {
  let broken = true;
  const paths: string[] = [];
  const h = await setup((async (path) => {
    paths.push(String(path));
    return broken
      ? Response.json(
          {
            error: {
              code: "CONFIGURATION_REQUIRED",
              message:
                "ENCRYPTION_KEYS_JSON must contain a 32-byte key encoded as Base64, without JSON or quotes.",
              requestId: "edcaa17a-5ee4-4c7e-8436-cabceaf16a79",
            },
          },
          { status: 503 },
        )
      : Response.json(base());
  }) as typeof fetch);
  try {
    await h.settle();
    assert.match(h.el("notice").textContent, /ENCRYPTION_KEYS_JSON.*44/);
    assert.match(h.el("notice").textContent, /edcaa17a/);
    assert.match(h.el("web-state").textContent, /读取失败/);
    assert.ok(!h.el("web-state").textContent.includes("正在读取"));
    assert.equal(h.el("connect").getAttribute("aria-disabled"), "true");
    assert.equal(h.el("refresh").disabled, false);
    assert.equal(h.el("dav-fields").disabled, true);
    broken = false;
    h.el("refresh").click();
    await h.settle();
    assert.equal(h.el("connect").getAttribute("aria-disabled"), "false");
    assert.equal(h.el("dav-fields").disabled, false);
    assert.ok(paths.every((path) => path === "/api/admin/status"));
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
test("pending connection cooldown uses one continuation button and never polls Apple", async () => {
  const h = await setup();
  try {
    await h.settle();
    const photo = h.state.services.find((s) => s.service === "photos")!;
    photo.enabled = true;
    photo.connection = {
      state: "pending",
      checkedAt: Date.now(),
      nextAttemptAt: Date.now() + 60000,
      action: "wait-for-reminders-keys",
    };
    h.el("refresh").click();
    await h.settle();
    const button = h.document.querySelector(
      'button[data-service="photos"][data-kind="check"]',
    ) as any;
    assert.equal(button.disabled, true);
    assert.match(button.textContent, /等待.*秒/);
    assert.equal(h.document.querySelectorAll('[data-kind="pcs"]').length, 0);
    photo.connection.nextAttemptAt = 0;
    h.el("refresh").click();
    await h.settle();
    const ready = h.document.querySelector(
      'button[data-service="photos"][data-kind="check"]',
    ) as any;
    assert.equal(ready.disabled, false);
    assert.equal(ready.textContent, "继续验证");
    ready.click();
    await h.settle();
    assert.equal(
      h.requests.filter((r) => r.path === "/api/admin/check").length,
      1,
    );
    assert.equal(
      h.requests.filter((r) => r.path === "/api/admin/pcs").length,
      0,
    );
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

test("homepage explains authorization plainly, includes Find My and keeps unapproved checks disabled", async () => {
  const h = await setup();
  try {
    await h.settle();
    const page = h.document.body.textContent;
    assert.ok(page.includes("查找"));
    assert.ok(!page.includes("PCS"));
    assert.ok(!page.includes("请勿在聊天中提供"));
    const check = h.document.querySelector(
      'button[data-service="notes"][data-kind="check"]',
    ) as any;
    assert.equal(check.disabled, true);
    assert.equal(
      h.document.querySelectorAll('input[data-service="findmy"]').length,
      0,
    );
    h.state.services.find((s) => s.service === "notes")!.pcsReady = true;
    h.el("refresh").click();
    await h.settle();
    // Enabling remains a separate explicit user choice.
    assert.equal(
      (
        h.document.querySelector(
          'button[data-service="notes"][data-kind="check"]',
        ) as any
      ).disabled,
      true,
    );
    h.state.services.find((s) => s.service === "notes")!.enabled = true;
    h.el("refresh").click();
    await h.settle();
    assert.equal(
      (
        h.document.querySelector(
          'button[data-service="notes"][data-kind="check"]',
        ) as any
      ).disabled,
      false,
    );
  } finally {
    h.ui.destroy();
  }
});

test("saved credentials collapse until editing, while missing credentials show their form", async () => {
  const h = await setup();
  try {
    await h.settle();
    assert.equal(h.el("web-state").textContent, "已保存");
    assert.equal(h.el("dav-state").textContent, "已保存");
    assert.equal(h.el("dav-entry").hidden, true);
    h.el("edit-dav").click();
    assert.equal(h.el("dav-entry").hidden, false);
    h.el("password").value = "synthetic";
    h.el("cancel-dav").click();
    assert.equal(h.el("dav-entry").hidden, true);
    assert.equal(h.el("password").value, "");
    h.state.dav.configured = false;
    h.el("refresh").click();
    await h.settle();
    assert.equal(h.el("dav-entry").hidden, false);
    assert.equal(h.el("dav-state").textContent, "未保存");
    assert.ok(h.el("credentials-card").contains(h.el("web-state")));
    assert.ok(h.el("credentials-card").contains(h.el("dav-state")));
  } finally {
    h.ui.destroy();
  }
});
test("enabled web services can check without a manual authorization prerequisite", async () => {
  const h = await setup();
  try {
    await h.settle();
    const s = h.state.services.find((s) => s.service === "notes")!;
    s.enabled = true;
    s.pcsReady = false;
    h.el("refresh").click();
    await h.settle();
    assert.equal(
      (
        h.document.querySelector(
          'button[data-service="notes"][data-kind="check"]',
        ) as any
      ).disabled,
      false,
    );
    assert.equal(h.document.querySelectorAll('[data-kind="pcs"]').length, 0);
    assert.ok(!h.document.body.textContent.includes("ChatGPT"));
  } finally {
    h.ui.destroy();
  }
});
test("copy buttons preserve dynamic endpoint and complete result text", async () => {
  const h = await setup();
  try {
    await h.settle();
    h.el("copy-mcp").click();
    await Promise.resolve();
    assert.equal(h.copied[0], "https://synthetic.test/mcp");
    const result = h.el("notice").textContent;
    h.el("copy-result").click();
    await Promise.resolve();
    assert.equal(h.copied[1], result);
    assert.equal(h.el("notice").textContent, "已复制");
    const detail = h.el("status").textContent;
    h.el("copy-status").click();
    await Promise.resolve();
    assert.equal(h.copied[2], detail);
    assert.deepEqual(JSON.parse(h.copied[2]), h.state);
  } finally {
    h.ui.destroy();
  }
});
test("service results survive status reload with timestamps and no repeated credential labels", async () => {
  const h = await setup();
  try {
    await h.settle();
    h.state.services[0].enabled = true;
    h.state.services[0].connection = { state: "ok", checkedAt: Date.now() };
    h.el("refresh").click();
    await h.settle();
    const card = h.document.querySelector('article[data-service="calendar"]')!;
    assert.ok(card.textContent.includes("连接正常"));
    assert.ok(card.textContent.includes("上次检查"));
    assert.ok(!card.textContent.includes("专用密码已保存"));
    h.state.services[0].connection = null;
    h.el("refresh").click();
    await h.settle();
    assert.ok(
      h.document
        .querySelector('article[data-service="calendar"]')!
        .textContent.includes("尚未检查"),
    );
  } finally {
    h.ui.destroy();
  }
});
for (const code of ["VERIFICATION_REQUIRED", "UNSUPPORTED_FEATURE"])
  test(`detailed ${code} can be copied intact`, async () => {
    const state = base();
    state.services.find((s) => s.service === "photos")!.enabled = true;
    const error = {
      code,
      message:
        "Apple requestWebAccessState: HTTP 412; hsaChallengeRequired=true",
      requestId: "6bfd26a2-d301-4e38-ada4-57125c1c448a",
    };
    const h = await setup((async (path: any) =>
      path === "/api/admin/status"
        ? Response.json(state)
        : Response.json({ error }, { status: 409 })) as typeof fetch);
    try {
      await h.settle();
      (
        h.document.querySelector(
          'button[data-service="photos"][data-kind="check"]',
        ) as any
      ).click();
      await h.settle();
      assert.ok(h.el("notice").textContent.includes(error.message));
      h.el("copy-result").click();
      await Promise.resolve();
      assert.ok(h.copied[0].includes(error.requestId));
      assert.ok(h.copied[0].includes(error.message));
    } finally {
      h.ui.destroy();
    }
  });

test("mobile feedback can be dismissed without losing card error details or copy access", async () => {
  const state = base();
  state.services[0].enabled = true;
  const h = await setup((async (path: any) =>
    path === "/api/admin/status"
      ? Response.json(state)
      : Response.json(
          {
            error: {
              code: "UPSTREAM_UNAVAILABLE",
              message: "calendar HTTP 503",
              requestId: "mobile-request",
            },
          },
          { status: 503 },
        )) as typeof fetch);
  try {
    await h.settle();
    (
      h.document.querySelector(
        'button[data-service="calendar"][data-kind="check"]',
      ) as any
    ).click();
    await h.settle();
    assert.equal(h.el("result-toast").hidden, false);
    h.el("dismiss-result").click();
    assert.equal(h.el("result-toast").hidden, true);
    const result = h.document.querySelector(
      'article[data-service="calendar"] .operation-result',
    )!;
    assert.ok(result.textContent.includes("calendar HTTP 503"));
    h.el("refresh").click();
    await h.settle();
    (
      h.document.querySelector(
        'article[data-service="calendar"] .operation-result button',
      ) as any
    ).click();
    await Promise.resolve();
    assert.ok(h.copied[0].includes("mobile-request"));
  } finally {
    h.ui.destroy();
  }
});
test("credential validation stays next to the form after closing the toast", async () => {
  const h = await setup();
  try {
    await h.settle();
    h.el("edit-dav").click();
    h.el("password").value = "invalid";
    h.el("dav").dispatchEvent(
      new h.window.Event("submit", { cancelable: true }),
    );
    h.el("dismiss-result").click();
    assert.equal(h.el("dav-result").hidden, false);
    assert.ok(h.el("dav-result").textContent.includes("16 位"));
    assert.equal(h.el("page-result").hidden, true);
  } finally {
    h.ui.destroy();
  }
});
test("success toast expires automatically", async (t) => {
  const h = await setup();
  try {
    await h.settle();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    h.el("copy-mcp").click();
    await Promise.resolve();
    assert.equal(h.el("result-toast").hidden, false);
    t.mock.timers.tick(4000);
    assert.equal(h.el("result-toast").hidden, true);
  } finally {
    h.ui.destroy();
    t.mock.timers.reset();
  }
});

test("Find My errors distinguish web credentials from App passwords and explain sound confirmation", async () => {
  const h = await setup();
  try {
    await h.settle();
    h.state.services.find((s) => s.service === "findmy")!.connection = {
      state: "error",
      checkedAt: Date.now(),
      error: {
        code: "REAUTH_REQUIRED",
        message: "Apple fmip initClient: HTTP 421",
        requestId: "findmy-request",
      },
    };
    h.el("refresh").click();
    await h.settle();
    const card = h.document.querySelector('article[data-service="findmy"]')!;
    assert.ok(!card.textContent.includes("专用密码"));
    assert.ok(card.textContent.includes("Apple 网页会话"));
    assert.ok(card.textContent.includes("通过 MCP 播放声音"));
    assert.ok(card.textContent.includes("HTTP 421"));
  } finally {
    h.ui.destroy();
  }
});

test("persisted service errors keep one detailed copy instead of a duplicate inline box", async () => {
  const state = base();
  const error = {
    code: "REAUTH_REQUIRED",
    message: "Apple fmip initClient (cn): HTTP 421",
    requestId: "deduplicated-request",
  };
  state.services.find((s) => s.service === "findmy")!.connection = {
    state: "error",
    checkedAt: Date.now(),
    error,
  };
  const h = await setup((async (path: any) =>
    path === "/api/admin/status"
      ? Response.json(state)
      : Response.json({ error }, { status: 409 })) as typeof fetch);
  try {
    await h.settle();
    (
      h.document.querySelector(
        'button[data-service="findmy"][data-kind="check"]',
      ) as any
    ).click();
    await h.settle();
    const card = h.document.querySelector('article[data-service="findmy"]')!;
    assert.equal((card.querySelector(".operation-result") as any).hidden, true);
    h.el("dismiss-result").click();
    (card.querySelector("details button") as any).click();
    await Promise.resolve();
    assert.ok(h.copied[0].includes("deduplicated-request"));
    assert.ok(h.copied[0].includes("HTTP 421"));
  } finally {
    h.ui.destroy();
  }
});
