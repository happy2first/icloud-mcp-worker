import {
  beginAppleSignIn,
  type BrowserSignInUpdate,
} from "../app/apple-auth-client.ts";
import { APPLE_LOGIN_POLICY } from "./apple/policy.ts";

type Status = {
  generation: number;
  gates: { enabled: boolean; loginPolicy: string };
  message: string;
};
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const form = element<HTMLFormElement>("credentials"),
  fields = element<HTMLFieldSetElement>("fields"),
  verification = element<HTMLFormElement>("verification");
const account = element<HTMLInputElement>("account"),
  password = element<HTMLInputElement>("password"),
  code = element<HTMLInputElement>("code");
const verificationFields = element<HTMLFieldSetElement>("verification-fields");
const panel = element<HTMLElement>("verification-panel"),
  retry = element<HTMLButtonElement>("retry-status");
const trust = element<HTMLInputElement>("apple-trust"),
  retention = element<HTMLInputElement>("retention");
const message = element<HTMLParagraphElement>("message"),
  cancel = element<HTMLButtonElement>("cancel"),
  back = element<HTMLAnchorElement>("continue");
let attempt: ReturnType<typeof beginAppleSignIn> | null = null,
  controller: AbortController | null = null,
  revision = 0,
  busy = false;
function announce(text: string, error = false) {
  message.textContent = text;
  message.dataset.error = String(error);
}
function clear() {
  password.value = "";
  code.value = "";
}
function stop() {
  revision++;
  controller?.abort();
  controller = null;
  attempt?.cancel();
  attempt = null;
  clear();
  busy = false;
  cancel.hidden = true;
  verification.hidden = true;
  panel.hidden = true;
  verificationFields.disabled = true;
}
function paused(status: Status) {
  stop();
  form.hidden = true;
  fields.disabled = true;
  back.hidden = false;
  announce("Apple 登录尚未启用，请联系管理员检查配置。");
}
async function freshStatus(signal: AbortSignal) {
  const response = await fetch("/api/connection", {
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw new Error(
      "无法确认登录状态。请检查网络与 Access 登录，然后重新检查状态。",
    );
  const value = (await response.json()) as Status;
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    value.gates?.loginPolicy !== APPLE_LOGIN_POLICY ||
    typeof value.gates.enabled !== "boolean"
  )
    throw new Error("登录策略发生变化，请重新打开此页面。");
  return value;
}
function update(value: BrowserSignInUpdate) {
  clear();
  if (value.state === "working") {
    verificationFields.disabled = true;
    announce(
      panel.hidden
        ? "正在建立 Apple 登录并在本机计算证明，请保持此页打开…"
        : "正在验证可信设备，请勿重复提交…",
    );
  }
  if (value.state === "code") {
    verification.hidden = false;
    panel.hidden = false;
    verificationFields.disabled = false;
    announce(
      "请在可信设备上允许本次 Apple 登录，并在下方输入这次显示的六位验证码。",
    );
    code.focus();
  }
  if (value.state === "failed") {
    stop();
    fields.disabled = false;
    form.hidden = false;
    const hints: Record<string, string> = {
      REAUTH_REQUIRED: "Apple 拒绝本次登录，请核对账户与主密码后重新发起。",
      VERIFICATION_REQUIRED: "Apple 要求重新验证设备，请重新发起登录。",
      UNSUPPORTED_AUTH:
        "Apple 返回了当前未支持的验证方式，或账户被锁定。请先在 Apple 官方界面处理；本版本不支持短信、电话和硬件安全密钥。",
      RATE_LIMITED: "Apple 暂时限制请求，请等待后重试。",
      PROTOCOL_CHANGED:
        "Apple 接口返回了未支持的协议，请保留错误代码并检查项目更新。",
      RESTART_REQUIRED: "本次登录已失效或连接中断，请重新发起。",
      UPSTREAM_UNAVAILABLE: "无法连接 Apple，请检查网络后重试。",
      TERMS_ACTION_REQUIRED:
        "请先在 Apple 官方网站阅读并处理更新的条款，再返回重新登录。",
    };
    announce(
      (value.code ? value.code + "：" : "") +
        (hints[value.code ?? ""] ??
          "登录未完成，请重新发起。详情：" + value.message),
      true,
    );
  }
  if (value.state === "complete") {
    stop();
    form.hidden = true;
    back.hidden = false;
    announce(
      `账户与设备验证完成，网页会话已加密保存，最晚于 ${new Date(value.result.expiresAt).toLocaleString("zh-CN")} 到期。返回管理页逐项申请提醒事项、备忘录、照片和云盘的数据授权。`,
    );
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || !form.reportValidity()) return;
  busy = true;
  fields.disabled = true;
  cancel.hidden = false;
  retry.hidden = true;
  announce("正在确认登录策略，请稍候…");
  const current = ++revision,
    request = new AbortController();
  controller = request;
  const timer = setTimeout(() => request.abort(), 10_000);
  void (async () => {
    // Confirm the current policy before taking the password out of its field.
    const status = await freshStatus(request.signal);
    if (current !== revision) return;
    if (!status.gates.enabled) {
      paused(status);
      return;
    }
    let secret = password.value;
    password.value = "";
    try {
      attempt = beginAppleSignIn(
        account.value.trim(),
        secret,
        { appleTrust: trust.checked, persistentSession: retention.checked },
        status.generation,
        (value) => {
          if (current === revision) update(value);
        },
      );
    } finally {
      secret = "";
    }
  })()
    .catch((error) => {
      if (current === revision) {
        stop();
        fields.disabled = false;
        announce(
          error instanceof Error
            ? error.message
            : "未能开始登录，请重新检查状态。",
          true,
        );
      }
    })
    .finally(() => {
      clearTimeout(timer);
      if (controller === request) controller = null;
    });
});
verification.addEventListener("submit", (event) => {
  event.preventDefault();
  if (verificationFields.disabled || !verification.reportValidity()) return;
  let value = code.value;
  code.value = "";
  void attempt
    ?.submitCode(value)
    .catch((error) =>
      announce(
        error instanceof Error ? error.message : "请重新发起设备验证。",
        true,
      ),
    );
  value = "";
});
cancel.addEventListener("click", () => {
  stop();
  fields.disabled = false;
  form.hidden = false;
  announce(
    "登录已取消。可以重新输入凭证发起登录。若取消发生在保存完成前后，请返回管理页确认当前状态。",
  );
});
window.addEventListener("pagehide", stop);
function initializeStatus() {
  if (busy) return;
  const initial = new AbortController();
  const initialTimer = setTimeout(() => initial.abort(), 10_000);
  controller = initial;
  retry.hidden = true;
  retry.disabled = true;
  fields.disabled = true;
  announce("正在读取登录状态…");
  void freshStatus(initial.signal)
    .then((status) => {
      if (initial.signal.aborted) return;
      if (!status.gates.enabled) paused(status);
      else {
        fields.disabled = false;
        announce(
          "请输入 Apple 账户主密码并确认会话授权。重新登录会替换现有网页会话及服务授权。",
        );
      }
    })
    .catch(() => {
      clear();
      announce(
        "无法读取登录状态。请确认 Access 登录有效，再点击重新检查。",
        true,
      );
      retry.hidden = false;
    })
    .finally(() => {
      clearTimeout(initialTimer);
      if (controller === initial) controller = null;
      retry.disabled = false;
    });
}
retry.addEventListener("click", initializeStatus);
initializeStatus();
