type Connection = {
  state: "ok" | "error" | "pending" | "stale";
  checkedAt: number;
  error?: { code: string; message: string; requestId: string };
  action?: string;
  nextAttemptAt?: number;
};
type Service = {
  connection?: Connection | null;
  requiresVerification?: boolean;
  service: string;
  enabled: boolean;
  writable: boolean;
  credentialAvailable: boolean;
  pcsReady: boolean | null;
};
type Status = {
  web: {
    generation: number;
    state: string;
    expiresAt?: number;
    gates: { enabled: boolean };
  };
  webSessionAvailable: boolean;
  webCredentialSaved?: boolean;
  dav: { configured: boolean; version: number };
  services: Service[];
  pcsProgress?: Record<
    string,
    { nextAttemptAt: number; expiresAt: number; exhausted: boolean }
  >;
};
export function mountAdmin(
  doc: Document,
  send: typeof fetch = fetch,
  confirmAction: (message: string) => boolean = (message) =>
    window.confirm(message),
  copyText: (text: string) => Promise<void> = async (text) => {
    const nav = doc.defaultView?.navigator as unknown as {
      clipboard?: { writeText(text: string): Promise<void> };
    };
    if (!nav?.clipboard) throw new Error("clipboard-unavailable");
    await nav.clipboard.writeText(text);
  },
) {
  const el = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  const names: Record<string, string> = {
    calendar: "日历",
    contacts: "通讯录",
    reminders: "提醒事项",
    notes: "备忘录",
    photos: "照片",
    drive: "iCloud 云盘",
    findmy: "查找",
  };
  const pcs: Record<string, string> = {
    reminders: "reminders",
    notes: "notes3",
    photos: "photos",
    drive: "iclouddrive",
  };
  const hints: Record<string, string> = {
    NOT_CONNECTED: "请先配置对应凭证。",
    REAUTH_REQUIRED: "Apple 拒绝了当前服务的凭证，请查看错误详情。",
    DEVICE_APPROVAL_PENDING: "在 iPhone 或 iPad 上批准访问，再点击“继续验证”。",
    VERIFICATION_REQUIRED: "请重新登录并完成可信设备验证。",
    CONFLICT: "配置已变化，请刷新状态后再操作。",
    RATE_LIMITED: "请等待倒计时或稍后再试，勿连续点击。",
    SESSION_EXPIRED: "Access 登录可能已过期，请重新打开此管理页登录。",
    FORBIDDEN: "此操作未授权，请检查服务与写权限或 Apple 网页访问设置。",
    UNSUPPORTED_FEATURE: "当前协议不支持此服务或资源，请查看项目支持范围。",
    PROTOCOL_CHANGED:
      "Apple 接口返回未支持的协议，请记录错误代码并检查项目更新。",
    CONFIGURATION_REQUIRED:
      "Worker 配置尚未就绪，请检查 D1 绑定与加密 Secret，并部署最新代码。",
    STORAGE_UNAVAILABLE:
      "Worker 数据库访问或初始化失败，请检查 DB 绑定及 Cloudflare D1 状态；这不是 Apple 连接错误，已有数据无需删除。",
    STORAGE_SCHEMA_MISMATCH:
      "当前绑定的 D1 表结构不兼容，请核对数据库并执行对应迁移；不要删除已有数据或重新生成密钥。",
    OWNER_NOT_CONFIGURED: "管理员尚未配置 Access 身份与应用域名。",
    UNSUPPORTED_AUTH:
      "Apple 登录未启用或返回了未支持的验证方式，请检查配置与官方账户状态。",
    UPSTREAM_UNAVAILABLE: "无法连接 Apple 服务或请求超时，请稍后再试。",
    AUTH_EXPIRED: "会话已过期，请重新登录。",
    RESTART_REQUIRED: "本次授权需重试，请刷新状态后操作。",
  };
  const configurationHints: Record<string, string> = {
    "Bind a D1 database as DB with session support.":
      "请将 Cloudflare D1 数据库绑定为 DB。若已有绑定，请核对类型确为 D1，并部署最新 Worker。",
    "The database initialization schema is missing. Rebuild the Worker.":
      "构建产物缺少数据库初始化结构，请使用 npm run build 重新构建并部署。",
    "The runtime Secret ENCRYPTION_KEYS_JSON is missing.":
      "Worker 未读取到运行时 Secret ENCRYPTION_KEYS_JSON。请核对它是否配置在当前 Worker 的“变量和机密”，而不是仅配置在构建环境中，并重新部署；不要更换已有密钥。",
    "ENCRYPTION_KEYS_JSON must contain a 32-byte key encoded as Base64, without JSON or quotes.":
      "加密 Secret ENCRYPTION_KEYS_JSON 未配置或格式错误。请在 Worker 的运行时 Secret 中填写 32 字节密钥的标准 Base64 字符串（44 个字符、末尾为 =），不要填写 32 个普通字符或引号；已有凭证时不要更换密钥。",
    "Each encryption key must contain exactly 32 bytes.":
      "ENCRYPTION_KEYS_JSON 中的密钥解码后不是 32 字节，请核对同一密钥的完整 Base64 值。",
    "ENCRYPTION_KEYS_JSON must be valid JSON.":
      "加密 Secret 格式不正确。最新代码支持直接填写 Base64；若尚未部署最新提交，请先更新代码。",
    "ENCRYPTION_KEYS_JSON must contain exactly one 32-byte encryption key.":
      "加密 Secret 无效。请直接填写 32 字节密钥的 Base64 字符串；旧 JSON 配置只能包含一把密钥。",
    "Configure encryption Secrets.":
      "加密 Secret ENCRYPTION_KEYS_JSON 未正确配置，请检查运行时 Secret 的名称和 Base64 值。",
    "The server-only encryption secret must be configured before Apple sessions can be stored.":
      "加密 Secret 尚未就绪，或当前仍是旧版代码。请部署最新提交，并检查运行时 ENCRYPTION_KEYS_JSON。",
    "Persistent storage has not been provisioned.":
      "Worker 未绑定 D1。请检查名为 DB 的数据库绑定，再重新部署。",
    "Bind the D1 database.":
      "Worker 未绑定 D1。请检查名为 DB 的数据库绑定，再重新部署。",
  };
  let current: Status | null = null,
    busy = false,
    davEditing = false;
  let workingService: string | null = null;
  const copyIcon =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/></svg>';
  const errorHint = (code: string, service?: string) =>
    code === "REAUTH_REQUIRED" &&
    service &&
    !["calendar", "contacts"].includes(service)
      ? "该服务拒绝了 Apple 网页会话，请查看错误详情。"
      : (hints[code] ?? "操作未完成。");
  const errorText = (e: any, service?: string) =>
    (e.code ?? "REQUEST_FAILED") +
    "：" +
    (e.code === "CONFIGURATION_REQUIRED"
      ? (configurationHints[e.message] ?? hints.CONFIGURATION_REQUIRED)
      : errorHint(e.code, service)) +
    (typeof e.message === "string" ? "\n详情：" + e.message : "") +
    (typeof e.requestId === "string" ? "\n请求编号：" + e.requestId : "") +
    (typeof e.retryAfterSeconds === "number"
      ? `\n至少等待 ${Math.ceil(e.retryAfterSeconds)} 秒。`
      : "");
  const results = new Map<string, { text: string; error: boolean }>();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function dismissNotice() {
    clearTimeout(noticeTimer);
    el("result-toast").hidden = true;
  }
  function renderResult(
    target: HTMLElement,
    result?: { text: string; error: boolean },
  ) {
    target.replaceChildren();
    target.hidden = !result;
    if (!result) return;
    target.dataset.error = String(result.error);
    const text = doc.createElement("p");
    text.textContent = result.text;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.innerHTML = copyIcon;
    button.setAttribute(
      "aria-label",
      result.error ? "复制错误信息" : "复制操作结果",
    );
    button.onclick = () => void copy(result.text, button);
    target.appendChild(text);
    target.appendChild(button);
  }
  function renderResults() {
    for (const scope of ["web", "dav", "page"])
      renderResult(el(scope + "-result"), results.get(scope));
    for (const card of doc.querySelectorAll<HTMLElement>(".service-card")) {
      const target = card.querySelector<HTMLElement>(".operation-result");
      const service = card.dataset.service!;
      const result = results.get(service);
      const savedError = current?.services.find((s) => s.service === service)
        ?.connection?.error;
      // A persisted connection error already has details and its own copy
      // button. Keep local feedback only when it adds a different result.
      if (target)
        renderResult(
          target,
          result?.error &&
            savedError &&
            result.text === errorText(savedError, service)
            ? undefined
            : result,
        );
    }
  }
  async function copy(text: string, button: HTMLButtonElement) {
    try {
      await copyText(text);
      button.title = "已复制";
      announce("已复制");
    } catch {
      button.title = "复制失败，请手动选择文字复制";
      announce("复制失败，请在卡片内手动选择文字复制。", true);
    }
  }
  function announce(text: string, error = false, scope?: string) {
    if (scope) {
      results.set(scope, { text, error });
      renderResults();
    }
    clearTimeout(noticeTimer);
    el("result-toast").hidden = false;
    noticeTimer = setTimeout(dismissNotice, error ? 8000 : 4000);
    el("notice").textContent = text;
    el("notice").dataset.error = String(error);
    el("copy-result").setAttribute(
      "aria-label",
      error ? "复制错误信息" : "复制操作结果",
    );
  }
  async function api(path: string, value?: unknown) {
    let r: Response;
    try {
      r = await send(path, {
        cache: "no-store",
        signal: AbortSignal.timeout(45000),
        ...(value === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(value),
            }),
      });
    } catch {
      throw new Error(
        "请求超时或网络中断。操作结果未确认，请刷新页面状态后重试。",
      );
    }
    if (
      r.redirected ||
      !(r.headers.get("content-type") ?? "").includes("application/json")
    )
      throw new Error("SESSION_EXPIRED：" + hints.SESSION_EXPIRED);
    const data: any = await r.json();
    if (!r.ok) {
      const e = data.error ?? {};
      if (e.code === "UPSTREAM_UNAVAILABLE" && path === "/api/admin/status")
        e.message =
          "管理状态读取失败；此接口不请求 Apple，请检查 Worker 数据库。";
      throw new Error(
        errorText(e, (value as { service?: string } | undefined)?.service),
      );
    }
    return data;
  }
  function controls() {
    el<HTMLFieldSetElement>("dav-fields").disabled = busy || !current;
    el<HTMLButtonElement>("refresh").disabled = busy;
    el<HTMLButtonElement>("remove").disabled = busy || !current?.dav.configured;
    el<HTMLButtonElement>("edit-dav").disabled = busy || !current;
    el<HTMLButtonElement>("disconnect").disabled =
      busy ||
      !current ||
      !(current.webCredentialSaved ?? current.webSessionAvailable);
    el("connect").setAttribute(
      "aria-disabled",
      String(busy || !current || !current.web.gates.enabled),
    );
    for (const input of doc.querySelectorAll<HTMLInputElement>(
      "#services input",
    )) {
      const s = current?.services.find(
        (s) => s.service === input.dataset.service,
      );
      input.disabled =
        busy || !s || (input.dataset.kind === "writable" && !s.enabled);
    }
    for (const button of doc.querySelectorAll<HTMLButtonElement>(
      'button[data-kind="check"]',
    )) {
      const s = current?.services.find(
        (s) => s.service === button.dataset.service,
      );
      const p = current?.pcsProgress?.[pcs[button.dataset.service!]];
      const until =
        s?.connection?.state === "pending"
          ? (s.connection.nextAttemptAt ??
            (p?.exhausted ? p.expiresAt : p?.nextAttemptAt) ??
            0)
          : 0;
      const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      button.disabled =
        busy || !s?.enabled || !s.credentialAvailable || seconds > 0;
      button.textContent = seconds
        ? `等待 ${seconds} 秒`
        : s?.connection?.state === "pending"
          ? "继续验证"
          : "检查连接";
    }
  }
  function render() {
    if (!current) return;
    const webSaved = current.webCredentialSaved ?? current.webSessionAvailable;
    el("web-state").textContent = webSaved ? "已保存" : "未保存";
    el("web-state").dataset.saved = String(webSaved);
    el("dav-state").textContent = current.dav.configured ? "已保存" : "未保存";
    el("dav-state").dataset.saved = String(current.dav.configured);
    el("connect").textContent = webSaved ? "重新登录" : "登录 Apple";
    el("disconnect").hidden = !webSaved;
    el("expiry").textContent =
      webSaved && !current.webSessionAvailable
        ? "凭证已保留，连接需要重新验证"
        : "";
    el("dav-saved-actions").hidden = !current.dav.configured;
    el("dav-entry").hidden = current.dav.configured && !davEditing;
    el("cancel-dav").hidden = !current.dav.configured;
    el("status").textContent = JSON.stringify(current, null, 2);
    el("services").replaceChildren();
    el("services").setAttribute("aria-busy", "false");
    for (const s of current.services) {
      const card = doc.createElement("article");
      card.className = "card service-card";
      card.dataset.service = s.service;
      card.dataset.enabled = String(s.enabled);
      const header = doc.createElement("div");
      header.className = "service-heading";
      const title = doc.createElement("h3");
      title.textContent = names[s.service];
      header.appendChild(title);
      card.appendChild(header);
      const toggle = (key: "enabled" | "writable") => {
        const label = doc.createElement("label");
        label.className =
          key === "enabled" ? "switch toggle" : "toggle write-toggle";
        const input = doc.createElement("input");
        input.type = "checkbox";
        input.checked = s[key];
        input.dataset.service = s.service;
        input.dataset.kind = key;
        input.setAttribute(
          "aria-label",
          names[s.service] + (key === "enabled" ? "启用服务" : "允许写入"),
        );
        label.appendChild(input);
        label.appendChild(
          doc.createTextNode(key === "enabled" ? "启用" : "允许新增与修改"),
        );
        (key === "enabled" ? header : card).appendChild(label);
        input.addEventListener("change", () => {
          const checked = input.checked;
          if (busy) {
            input.checked = s[key];
            return;
          }
          void action(async () => {
            await api("/api/admin/service", {
              service: s.service,
              enabled: key === "enabled" ? checked : s.enabled,
              writable:
                key === "enabled" ? (checked ? s.writable : false) : checked,
            });
            return names[s.service] + "设置已保存。";
          }, s.service);
        });
      };
      if (s.service !== "findmy") toggle("enabled");
      const c = s.connection;
      const state = doc.createElement("p");
      state.className = "connection-state";
      const kind =
        workingService === s.service
          ? "checking"
          : !s.credentialAvailable
            ? "missing"
            : s.requiresVerification
              ? "verification"
              : (c?.state ?? "unchecked");
      state.dataset.state = kind;
      state.textContent = {
        checking: "正在检查…",
        missing: "请先配置凭证",
        unchecked: "尚未检查",
        stale: "待重新检查",
        verification: "需要重新验证",
        ok: "连接正常",
        error: "连接失败",
        pending:
          c?.action === "wait-for-reminders-keys"
            ? "正在准备数据访问"
            : c?.error?.code === "RATE_LIMITED"
              ? "请稍后继续"
              : "需要设备批准",
      }[kind]!;
      card.appendChild(state);
      if (c?.checkedAt) {
        const time = doc.createElement("p");
        time.className = "check-time";
        time.textContent =
          "上次检查：" + new Date(c.checkedAt).toLocaleString("zh-CN");
        card.appendChild(time);
      }
      if (s.requiresVerification) {
        const p = doc.createElement("p");
        p.textContent = "请在凭证管理中重新登录 Apple。已保存的凭证会保留。";
        card.appendChild(p);
      }
      if (c?.state === "pending") {
        const p = doc.createElement("p");
        p.textContent =
          c.action === "wait-for-reminders-keys"
            ? "准备完成后点击“继续验证”。"
            : "在 iPhone 或 iPad 上批准访问，然后点击“继续验证”。";
        card.appendChild(p);
      }
      if (c?.error) {
        const help = doc.createElement("p");
        help.textContent = errorHint(c.error.code, s.service);
        card.appendChild(help);
        const details = doc.createElement("details");
        const summary = doc.createElement("summary");
        summary.textContent = "错误详情";
        details.appendChild(summary);
        const pre = doc.createElement("pre");
        pre.textContent = errorText(c.error, s.service);
        details.appendChild(pre);
        const button = doc.createElement("button");
        button.className = "icon-button";
        button.innerHTML = copyIcon;
        button.type = "button";
        button.setAttribute(
          "aria-label",
          "复制" + names[s.service] + "错误信息",
        );
        button.title = "复制错误信息";
        button.onclick = () => void copy(pre.textContent ?? "", button);
        details.appendChild(button);
        card.appendChild(details);
      }
      if (["calendar", "contacts", "reminders"].includes(s.service))
        toggle("writable");
      if (s.service === "findmy") {
        const p = doc.createElement("small");
        p.textContent =
          "本人及家庭设备；支持通过 MCP 播放声音，执行前需你确认目标设备";
        card.appendChild(p);
      }
      const actions = doc.createElement("div");
      actions.className = "actions";
      const check = doc.createElement("button");
      check.dataset.kind = "check";
      check.dataset.service = s.service;
      check.textContent = "检查连接";
      check.onclick = () => {
        if (busy) return;
        workingService = s.service;
        render();
        void action(async () => {
          const r = await api("/api/admin/check", { service: s.service });
          return r.liveReadPassed
            ? names[s.service] + "连接正常。"
            : names[s.service] +
                (r.action === "wait-for-reminders-keys"
                  ? "正在准备数据访问，请稍后继续验证。"
                  : "需要在 iPhone 或 iPad 上批准访问，然后继续验证。");
        }, s.service);
      };
      const result = doc.createElement("div");
      result.className = "operation-result";
      result.hidden = true;
      card.appendChild(result);
      actions.appendChild(check);
      if (s.service === "findmy" && s.credentialAvailable) {
        const verify = doc.createElement("a");
        verify.className = "button secondary";
        verify.href = "/connect/apple?service=findmy";
        verify.textContent = "验证查找";
        verify.title =
          "再次验证 Apple 主密码，并实际读取设备列表；失败时保留现有凭证";
        actions.appendChild(verify);
      }
      card.appendChild(actions);
      el("services").appendChild(card);
    }
    renderResults();
    controls();
  }
  async function refresh() {
    current = await api("/api/admin/status");
    render();
  }
  async function action(run: () => Promise<string>, scope = "page") {
    if (busy) return;
    busy = true;
    controls();
    announce("正在处理…");
    try {
      const message = await run();
      try {
        workingService = null;
        await refresh();
        if (scope === "page") results.delete("page");
        announce(message, false, scope === "page" ? undefined : scope);
      } catch (error) {
        current = null;
        announce(
          message +
            "\n状态刷新失败：" +
            (error instanceof Error ? error.message : "请重试。"),
          true,
          current ? scope : "page",
        );
      }
    } catch (error) {
      workingService = null;
      try {
        await refresh();
      } catch {
        current = null;
      }
      announce(
        error instanceof Error ? error.message : "操作失败，请重试。",
        true,
        current ? scope : "page",
      );
    } finally {
      busy = false;
      if (!current) {
        el("web-state").textContent = "读取失败";
        el("dav-state").textContent = "读取失败";
        el("services").replaceChildren();
        el("status").textContent = "状态不可用";
        el("dav-entry").hidden = true;
      }
      renderResults();
      controls();
    }
  }
  el("connect").addEventListener("click", (event) => {
    if (busy || !current?.web.gates.enabled) event.preventDefault();
    else if (
      (current.webCredentialSaved ?? current.webSessionAvailable) &&
      !confirmAction("重新登录会替换已保存的网页凭证，是否继续？")
    )
      event.preventDefault();
  });
  el("edit-dav").onclick = () => {
    if (busy) return;
    davEditing = true;
    render();
    el<HTMLInputElement>("account").focus();
  };
  el("cancel-dav").onclick = () => {
    if (busy) return;
    davEditing = false;
    el<HTMLInputElement>("password").value = "";
    render();
  };
  el<HTMLFormElement>("dav").onsubmit = (event) => {
    event.preventDefault();
    if (busy || !current) return;
    const account = el<HTMLInputElement>("account").value.trim();
    const compact = el<HTMLInputElement>("password").value.replace(
      /[\s-]/g,
      "",
    );
    if (!/^[a-z]{16}$/.test(compact)) {
      announce("App 专用密码应为 Apple 生成的 16 位小写字母。", true, "dav");
      return;
    }
    const expectedVersion = current.dav.version;
    el<HTMLInputElement>("password").value = "";
    void action(async () => {
      await api("/api/admin/credentials", {
        account,
        password: compact,
        expectedVersion,
      });
      davEditing = false;
      return "专用密码已保存。请检查相关服务连接。";
    }, "dav");
  };
  el("remove").onclick = () => {
    if (
      busy ||
      !current?.dav.configured ||
      !confirmAction("移除已保存的 App 专用密码？")
    )
      return;
    const expectedVersion = current.dav.version;
    void action(async () => {
      await api("/api/admin/remove-credentials", { expectedVersion });
      davEditing = false;
      return "专用密码已移除。";
    }, "dav");
  };
  el("disconnect").onclick = () => {
    if (
      busy ||
      !current ||
      !confirmAction("移除网页凭证并断开相关服务？App 专用密码会保留。")
    )
      return;
    void action(async () => {
      await api("/api/auth/disconnect", {});
      return "网页凭证已移除。";
    }, "web");
  };
  el("refresh").onclick = () =>
    void action(async () => "页面状态已刷新，未请求 Apple 服务。");
  el<HTMLInputElement>("mcp-url").value = new URL(
    "/mcp",
    doc.location.origin,
  ).href;
  el("copy-mcp").onclick = () =>
    void copy(
      el<HTMLInputElement>("mcp-url").value,
      el<HTMLButtonElement>("copy-mcp"),
    );
  el("copy-result").onclick = () =>
    void copy(
      el("notice").textContent ?? "",
      el<HTMLButtonElement>("copy-result"),
    );
  el("dismiss-result").onclick = dismissNotice;
  el("copy-status").onclick = () =>
    void copy(
      el("status").textContent ?? "",
      el<HTMLButtonElement>("copy-status"),
    );
  controls();
  void action(async () => "页面状态已更新。");
  const timer = setInterval(controls, 1000);
  return {
    destroy() {
      clearInterval(timer);
      clearTimeout(noticeTimer);
    },
    get busy() {
      return busy;
    },
  };
}
