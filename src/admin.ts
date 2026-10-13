import { pageStyles, adminStyles } from "./ui/styles.ts";
const copyIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/></svg>`;
export function adminPage(adminScript = "") {
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  );
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>iCloud MCP 管理</title><style nonce="${nonce}">${pageStyles}${adminStyles}</style></head><body class="admin-page"><main>
<header class="page-header"><div><h1>iCloud MCP</h1><p>凭证与服务管理</p></div><button id="refresh" class="secondary" title="重新读取保存状态，不检查 Apple 连接">刷新页面状态</button></header>
<div class="mcp-bar"><label for="mcp-url">MCP 地址</label><input id="mcp-url" readonly aria-label="MCP 地址"><button id="copy-mcp" class="icon-button" aria-label="复制 MCP 地址" title="复制 MCP 地址">${copyIcon}</button><span id="copy-feedback" role="status"></span></div>
<div class="result-box"><div id="notice" role="status" aria-live="polite" tabindex="-1">正在读取状态…</div><button id="copy-result" class="icon-button" aria-label="复制操作结果" title="复制操作结果">${copyIcon}</button></div>
<section id="credentials-card"><div class="section-heading"><h2>凭证管理</h2><small>保存状态与服务连接结果分别显示</small></div><div class="credential-grid">
<article class="credential-card"><div class="credential-heading"><h3>Apple 网页登录</h3><span id="web-state" class="credential-status">正在读取…</span></div><p>提醒事项、备忘录、照片、云盘、查找</p><p id="expiry" class="muted"></p><div class="actions"><a class="button" id="connect" href="/connect/apple">登录 Apple</a><button id="disconnect" class="danger" disabled>移除</button></div></article>
<article class="credential-card"><div class="credential-heading"><h3>App 专用密码</h3><span id="dav-state" class="credential-status">正在读取…</span></div><p>日历、通讯录</p><div id="dav-saved-actions" class="actions" hidden><button id="edit-dav" class="secondary">更新凭证</button><button id="remove" class="danger" disabled>移除</button></div><div id="dav-entry" hidden><form id="dav"><fieldset id="dav-fields" disabled><label for="account">Apple 账户邮箱</label><input id="account" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="320" required><label for="password">App 专用密码</label><input id="password" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="100" placeholder="xxxx-xxxx-xxxx-xxxx" required><div class="actions"><button id="save" type="submit">保存</button><button id="cancel-dav" type="button" class="secondary" hidden>取消</button></div></fieldset></form><a class="help-link" href="https://account.apple.com/" target="_blank" rel="noopener noreferrer">获取 App 专用密码</a></div></article>
</div></section>
<section><div class="section-heading"><h2>服务连接</h2><small>显示上次检查结果，不是实时监测</small></div><div id="services" aria-busy="true"></div></section>
<details class="technical"><summary>技术详情</summary><pre id="status"></pre></details>
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
