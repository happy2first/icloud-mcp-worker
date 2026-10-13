import { pageStyles } from "./ui/styles.ts";
export function adminPage(adminScript = "") {
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  );
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iCloud MCP 管理</title><style nonce="${nonce}">${pageStyles}</style></head><body class="admin-page"><main>
<h1>iCloud 服务</h1><p>登录账户，选择需要连接到 ChatGPT 的服务。</p>
<div id="notice" class="message" role="status" aria-live="polite" tabindex="-1">正在读取配置…</div>
<section><h2>Apple 账户</h2><p>用于提醒事项、备忘录、照片、云盘和查找。</p><p id="web-state">正在读取…</p><p id="expiry" class="muted"></p><div class="actions"><a class="button" id="connect" href="/connect/apple">登录 Apple 账户</a><button id="disconnect" class="danger" disabled>退出登录</button></div><p><small>登录后，在服务卡片中授权访问。</small></p></section>
<section><h2>日历与通讯录</h2><p>这两项服务需要 App 专用密码。</p><p id="dav-state">正在读取…</p><form id="dav"><fieldset id="dav-fields" disabled><label for="account">Apple 账户邮箱</label><input id="account" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="320" required><label for="password">App 专用密码</label><input id="password" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100" placeholder="xxxx-xxxx-xxxx-xxxx" aria-describedby="password-help" required><p id="password-help"><small>支持直接粘贴专用密码。</small></p><div class="actions"><button id="save" type="submit">保存</button></div></fieldset></form><div class="actions"><a class="button secondary" href="https://account.apple.com/" target="_blank" rel="noopener noreferrer">获取专用密码</a><button id="remove" class="danger" disabled>移除密码</button></div><p><small>生成位置：Apple 账户 → 登录与安全 → App 专用密码。</small></p></section>
<section><h2>服务</h2><p>开启服务 → 授权访问 → 检查连接。日历、通讯录和查找无需单独授权。</p><div id="services" aria-busy="true"></div></section>
<section><h2>连接 ChatGPT</h2><label for="mcp-url">MCP 地址</label><input id="mcp-url" readonly aria-label="MCP 地址"><p>添加自定义 MCP 应用，填写此地址并选择 OAuth。</p></section>
<section><h2>状态</h2><button id="refresh" class="secondary">刷新状态</button><details><summary>技术详情</summary><pre id="status"></pre></details></section>
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
