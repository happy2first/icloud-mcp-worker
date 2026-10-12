import { pageStyles } from "./ui/styles.ts";
export function adminPage(adminScript = "") {
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  );
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iCloud MCP 管理</title><style nonce="${nonce}">${pageStyles}</style></head><body><main>
<h1>iCloud MCP 管理</h1><p>先配置凭证，再开启服务并逐项检查。Apple 主密码与 App 专用密码用途不同，请勿在聊天中提供。</p>
<div id="notice" class="message" role="status" aria-live="polite" tabindex="-1">正在读取配置…</div>
<section><h2>1. 网页会话</h2><p>供提醒事项、备忘录、照片和云盘共用。</p><p id="web-state">正在读取…</p><p id="expiry" class="muted"></p><div class="actions"><a class="button" id="connect" href="/connect/apple">登录 Apple 账户</a><button id="disconnect" class="danger" disabled>断开网页会话</button></div><p><small>登录成功后仍需在下方逐项申请 PCS 数据授权。会话保存不代表 Apple 接口已验证。</small></p></section>
<section><h2>2. 日历 / 通讯录凭证</h2><p>使用 Apple 生成的 App 专用密码，不是账户主密码。</p><p id="dav-state">正在读取…</p><form id="dav"><fieldset id="dav-fields" disabled><label for="account">Apple 账户邮箱</label><input id="account" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="320" required><label for="password">App 专用密码</label><input id="password" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100" placeholder="xxxx-xxxx-xxxx-xxxx" aria-describedby="password-help" required><p id="password-help"><small>支持粘贴 16 位字母，自动整理空格和连字符。保存后输入框清空，不回显密码。</small></p><div class="actions"><button id="save" type="submit">加密保存</button></div></fieldset></form><div class="actions"><a class="button secondary" href="https://account.apple.com/" target="_blank" rel="noopener noreferrer">前往 Apple 生成专用密码</a><button id="remove" class="danger" disabled>移除本地专用密码</button></div><p><small>在 Apple 账户 → 登录与安全 → App 专用密码中生成。此处移除只清除 Worker 保存的凭证；撤销需在 Apple 网站操作。</small></p></section>
<section><h2>3. 服务权限与检查</h2><p>逐项启用。写入默认关闭；所有删除工具均未公开。每次只进行一项操作，避免授权请求冲突。</p><div id="services" aria-busy="true"></div></section>
<section><h2>4. 连接 ChatGPT</h2><label for="mcp-url">MCP 地址</label><input id="mcp-url" readonly aria-label="MCP 地址"><p>将此地址加入支持远程 MCP 的 ChatGPT 客户端，通过 Cloudflare Access 授权。先调用 icloud_status，再逐项读取。</p></section>
<section><h2>配置状态</h2><button id="refresh" class="secondary">刷新状态</button><details><summary>查看技术状态（不含凭证）</summary><pre id="status"></pre></details></section>
<noscript><p>请启用 JavaScript 后再配置。未启用时不会提交密码。</p></noscript></main><script nonce="${nonce}">${adminScript}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}
