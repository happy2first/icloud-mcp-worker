import { appleGates } from "./gates.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { pageStyles } from "../ui/styles.ts";

export function credentialDocument(request: Request, env: RuntimeEnv) {
  const gates = appleGates(env);
  const findMy = new URL(request.url).searchParams.get("service") === "findmy";
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  );
  const socket = new URL(request.url);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  const retentionTerms =
    "本地永久保留，直到你主动断开或移除；Apple 仍可能撤销会话、要求重新验证或数据授权。";
  const form = gates.enabled
    ? `<section id="login">${findMy ? "<p>重新输入同一 Apple 账户的主密码以验证查找。只有设备列表实际读取成功才保存结果；失败或取消时保留现有服务凭证。</p>" : ""}<p>此页面由你部署的 Worker 提供，不是 Apple 官方登录页。主密码仅在浏览器中计算 SRP 证明，Worker 接收证明，并由 Apple 验证。</p><p>仅支持现代可信设备验证；如果 Apple 要求短信、电话或硬件安全密钥，本版本会明确停止。请保持此页打开，并在三分钟内完成本次验证。</p><form id="credentials" method="post" action="/api/auth/unsupported"><fieldset id="fields" disabled><label for="region">iCloud 服务区域</label><select id="region"><option value="cn" selected>中国大陆（云上贵州）</option><option value="international">国际区</option></select><label for="account">Apple 账户</label><input id="account" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="320" required><label for="password">Apple 账户主密码</label><input id="password" type="password" autocomplete="current-password" maxlength="4096" required><label class="toggle"><input id="apple-trust" type="checkbox" required><span>同意申请 Apple 浏览器信任。Apple 决定是否授予及其期限。</span></label><label class="toggle"><input id="retention" type="checkbox" required><span>同意将 Cookie 与 Token 加密保存在 Worker 的 D1 中。${retentionTerms}断开后清除本地会话。</span></label><div class="actions"><button id="start" type="submit">${findMy ? "验证密码并检查查找" : "登录并验证设备"}</button></div></fieldset></form></section><section id="verification-panel" hidden><form id="verification" method="post" action="/api/auth/unsupported" hidden><p>只有 Apple 提供本次可信设备挑战后，才可输入验证码。</p><fieldset id="verification-fields" disabled><label id="code-label" for="code">本次可信设备六位验证码</label><div class="code-digits" role="group" aria-labelledby="code-label">${Array.from({ length: 6 }, (_, i) => `<input id="${i === 0 ? "code" : "code-" + (i + 1)}" data-code-digit type="text" aria-label="验证码第 ${i + 1} 位" aria-describedby="code-help" autocomplete="${i === 0 ? "one-time-code" : "off"}" inputmode="numeric" pattern="[0-9]" maxlength="${i === 0 ? 6 : 1}" autocapitalize="none" spellcheck="false" required>`).join("")}</div><p id="code-help">在设备上允许本次登录，将显示的验证码填在此处。支持直接粘贴六位验证码。请勿把密码或验证码发到聊天中。</p><div class="actions"><button type="submit">验证设备</button></div></fieldset></form></section><div class="actions"><button id="cancel" class="secondary" type="button" hidden>取消登录</button><a id="continue" class="button" href="/admin" target="_top" hidden>返回管理页</a><button id="retry-status" class="secondary" type="button" hidden>重新检查登录状态</button></div><noscript><p>需启用 JavaScript 计算本地证明。未启用时无法提交凭证。</p></noscript>`
    : `<p>管理员尚未启用 Apple 登录，请配置 APPLE_LOGIN_ENABLED=true。刷新此页不会联系 Apple。</p>`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接 Apple · iCloud MCP</title><style nonce="${nonce}">${pageStyles}</style>${gates.enabled ? `<script nonce="${nonce}" src="/api/auth/client.js" defer></script>` : ""}</head><body><main${findMy ? ' data-findmy-verification="true"' : ""}><a href="/admin" target="_top">返回 iCloud 管理页</a><h1>${gates.enabled ? (findMy ? "验证查找" : "连接 Apple 网页会话") : "Apple 登录未启用"}</h1><p id="message" class="message" role="status" aria-live="polite">正在读取登录状态…</p>${form}</main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' ${socket.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    },
  });
}
export function credentialScript(script: string) {
  return new Response(script, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
