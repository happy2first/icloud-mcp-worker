type Service = {
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
    REAUTH_REQUIRED: "Apple 拒绝了凭证，请重新登录或更换 App 专用密码。",
    DEVICE_APPROVAL_PENDING:
      "请点击“授权访问”，在 iPhone 或 iPad 上批准，再回来继续授权。",
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
    busy = false;
  const checks = new Map<string, string>();
  function announce(text: string, error = false) {
    el("notice").textContent = text;
    el("notice").dataset.error = String(error);
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
        "请求超时或网络中断。操作结果未确认，请刷新状态检查后再决定是否重试。",
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
      throw new Error(
        (e.code ?? "REQUEST_FAILED") +
          "：" +
          (e.code === "CONFIGURATION_REQUIRED"
            ? (configurationHints[e.message] ?? hints.CONFIGURATION_REQUIRED)
            : e.code === "UPSTREAM_UNAVAILABLE" && path === "/api/admin/status"
              ? "管理状态读取失败；此接口不请求 Apple，请记录请求编号并检查 Worker 数据库。"
              : (hints[e.code] ?? e.message ?? "操作未完成。")) +
          (typeof e.message === "string" &&
          (["PROTOCOL_CHANGED", "DEVICE_APPROVAL_PENDING"].includes(e.code) ||
            e.message.startsWith("DAV "))
            ? "\n详情：" + e.message
            : "") +
          (typeof e.requestId === "string" &&
          /^[a-f0-9-]{36}$/.test(e.requestId)
            ? " 请求编号：" + e.requestId + "。"
            : "") +
          (typeof e.retryAfterSeconds === "number"
            ? ` 至少等待 ${Math.ceil(e.retryAfterSeconds)} 秒。`
            : ""),
      );
    }
    return data;
  }
  function controls() {
    el<HTMLFieldSetElement>("dav-fields").disabled = busy || !current;
    el<HTMLButtonElement>("refresh").disabled = busy;
    el<HTMLButtonElement>("remove").disabled = busy || !current?.dav.configured;
    el<HTMLButtonElement>("disconnect").disabled =
      busy || !current || current.web.state === "DISCONNECTED";
    const connect = el<HTMLAnchorElement>("connect");
    connect.setAttribute(
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
      "#services button",
    )) {
      const s = current?.services.find(
        (s) => s.service === button.dataset.service,
      );
      const p = current?.pcsProgress?.[pcs[button.dataset.service!]];
      const until = p?.exhausted ? p.expiresAt : (p?.nextAttemptAt ?? 0);
      const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      button.disabled =
        busy ||
        !s ||
        (button.dataset.kind === "pcs"
          ? !current?.webSessionAvailable || seconds > 0
          : !s.enabled ||
            !s.credentialAvailable ||
            (!!pcs[s.service] && !s.pcsReady));
      if (button.dataset.kind === "pcs")
        button.textContent =
          seconds > 0
            ? `等待 ${seconds} 秒`
            : s?.pcsReady
              ? "更新授权"
              : p
                ? "继续授权"
                : "授权访问";
    }
  }
  function render() {
    if (!current) return;
    el("web-state").textContent = current.webSessionAvailable
      ? "已登录 Apple 账户"
      : current.web.state === "DISCONNECTED"
        ? "尚未登录"
        : "网页会话尚不可用：" + current.web.state;
    el("expiry").textContent = current.web.expiresAt
      ? "本地会话最晚到期：" +
        new Date(current.web.expiresAt).toLocaleString("zh-CN") +
        "；Apple 可能提前要求验证。"
      : current.webSessionAvailable
        ? "本地会话永久保留；Apple 仍可能要求重新验证。"
        : "";
    el("dav-state").textContent = current.dav.configured
      ? "专用密码已保存"
      : "尚未设置专用密码";
    el("status").textContent = JSON.stringify(current, null, 2);
    el("services").replaceChildren();
    el("services").setAttribute("aria-busy", "false");
    for (const s of current.services) {
      const card = doc.createElement("article");
      card.className = "card";
      card.dataset.service = s.service;
      const title = doc.createElement("h3");
      title.textContent = names[s.service];
      card.appendChild(title);
      const status = doc.createElement("p");
      status.className = "service-state";
      status.textContent =
        (s.enabled ? "已启用" : "未启用") +
        " · " +
        (!s.credentialAvailable
          ? "缺少可用凭证"
          : pcs[s.service]
            ? s.pcsReady
              ? "已授权"
              : "待授权：先点击“授权访问”"
            : s.service === "findmy"
              ? "共用 Apple 登录，无需单独授权"
              : "专用密码已保存");
      card.appendChild(status);
      for (const key of (s.service === "findmy"
        ? []
        : ["enabled", "writable"]) as ("enabled" | "writable")[]) {
        if (key === "writable" && pcs[s.service] && s.service !== "reminders")
          continue;
        const label = doc.createElement("label");
        label.className = "toggle";
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
          doc.createTextNode(key === "enabled" ? "启用服务" : "允许新增与修改"),
        );
        card.appendChild(label);
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
            return names[s.service] + "权限已保存。";
          });
        });
      }
      if (["notes", "photos", "drive", "findmy"].includes(s.service)) {
        const badge = doc.createElement("span");
        badge.className = "badge";
        badge.textContent =
          s.service === "findmy" ? "本人及家庭设备 · 播放声音需确认" : "只读";
        card.appendChild(badge);
      }
      const actions = doc.createElement("div");
      actions.className = "actions";
      if (pcs[s.service]) {
        const b = doc.createElement("button");
        b.className = "secondary";
        b.dataset.service = s.service;
        b.dataset.kind = "pcs";
        b.textContent = "授权访问";
        b.onclick = () =>
          void action(async () => {
            const r = await api(
              s.service === "reminders" ? "/api/auth/resume" : "/api/admin/pcs",
              s.service === "reminders"
                ? {
                    expectedGeneration: current!.web.generation,
                    restartApproval: true,
                  }
                : { service: pcs[s.service] },
            );
            return r.state === "READY"
              ? names[s.service] + "已授权，可以检查连接。"
              : names[s.service] +
                  (r.action === "wait-for-reminders-keys"
                    ? "正在准备数据访问，倒计时结束后点击“继续授权”。"
                    : "请在 iPhone 或 iPad 上批准访问，倒计时结束后点击“继续授权”。");
          });
        actions.appendChild(b);
      }
      const check = doc.createElement("button");
      check.textContent = "检查连接";
      check.dataset.service = s.service;
      check.dataset.kind = "check";
      check.onclick = () =>
        void action(async () => {
          const r = await api("/api/admin/check", { service: s.service });
          checks.set(
            s.service,
            "连接正常 · " + new Date(r.checkedAt).toLocaleTimeString("zh-CN"),
          );
          return names[s.service] + "连接正常。";
        });
      actions.appendChild(check);
      card.appendChild(actions);
      if (checks.has(s.service)) {
        const p = doc.createElement("p");
        p.className = "service-state";
        p.textContent = checks.get(s.service)!;
        card.appendChild(p);
      }
      el("services").appendChild(card);
    }
    controls();
  }
  async function refresh() {
    current = await api("/api/admin/status");
    render();
  }
  async function action(run: () => Promise<string>) {
    if (busy) return;
    busy = true;
    controls();
    announce("正在处理…");
    try {
      const message = await run();
      try {
        await refresh();
        announce(message);
      } catch (error) {
        current = null;
        announce(
          message +
            " 但状态刷新失败：" +
            (error instanceof Error ? error.message : "请刷新页面确认。"),
          true,
        );
      }
    } catch (e) {
      try {
        await refresh();
      } catch {
        current = null;
      }
      announce(e instanceof Error ? e.message : "操作失败，请刷新状态。", true);
    } finally {
      busy = false;
      if (!current) {
        el("web-state").textContent =
          "状态读取失败，登录暂不可用。修复上方配置错误后点击“刷新状态”。";
        el("dav-state").textContent = "状态读取失败，暂不能保存凭证。";
        el("expiry").textContent = "";
        el("services").replaceChildren();
        el("status").textContent = "状态不可用，请查看上方错误。";
      }
      controls();
    }
  }
  el("connect").addEventListener("click", (e) => {
    if (busy || !current?.web.gates.enabled) e.preventDefault();
    else if (
      current.webSessionAvailable &&
      !confirmAction("重新登录会替换已有网页会话和各服务授权。确定继续？")
    )
      e.preventDefault();
  });
  el<HTMLFormElement>("dav").onsubmit = (e) => {
    e.preventDefault();
    if (busy || !current) return;
    const account = el<HTMLInputElement>("account").value.trim();
    const raw = el<HTMLInputElement>("password").value;
    const compact = raw.replace(/[\s-]/g, "");
    if (!/^[a-z]{16}$/.test(compact)) {
      announce(
        "App 专用密码应为 Apple 生成的 16 位小写字母；请勿输入账户主密码。",
        true,
      );
      return;
    }
    const version = current.dav.version;
    el<HTMLInputElement>("password").value = "";
    void action(async () => {
      await api("/api/admin/credentials", {
        account,
        password: compact,
        expectedVersion: version,
      });
      checks.delete("calendar");
      checks.delete("contacts");
      return "专用密码已加密保存，请分别检查日历与通讯录。";
    });
  };
  el("remove").onclick = () => {
    if (
      busy ||
      !current?.dav.configured ||
      !confirmAction(
        "移除 Worker 中的日历和通讯录凭证？不会删除 Apple 数据，也不会撤销 Apple 网站上的密码。",
      )
    )
      return;
    const version = current.dav.version;
    void action(async () => {
      await api("/api/admin/remove-credentials", { expectedVersion: version });
      checks.delete("calendar");
      checks.delete("contacts");
      return "本地专用密码已移除。";
    });
  };
  el("disconnect").onclick = () => {
    if (
      busy ||
      !current ||
      !confirmAction(
        "断开四项网页服务并撤销下载引用？日历和通讯录的专用密码将保留。",
      )
    )
      return;
    void action(async () => {
      await api("/api/auth/disconnect", {});
      for (const s of Object.keys(pcs)) checks.delete(s);
      return "网页会话已断开；Apple 数据未删除。";
    });
  };
  el("refresh").onclick = () =>
    void action(async () => "配置状态已刷新；未请求 Apple 服务。");
  el<HTMLInputElement>("mcp-url").value = doc.location?.origin + "/mcp";
  controls();
  void action(async () => "先配置两类凭证，再逐项启用并检查。");
  const timer = setInterval(controls, 1000);
  return {
    destroy() {
      clearInterval(timer);
    },
    get busy() {
      return busy;
    },
  };
}
