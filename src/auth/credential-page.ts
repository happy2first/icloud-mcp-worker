import { appleGates, appleDisabledMessage } from "./gates.ts";
import type { RuntimeEnv } from "../platform/sites.ts";

const styles = `*{box-sizing:border-box}body{margin:0;background:#f3f5fa;color:#1b2233;font:17px/1.55 system-ui,sans-serif}main{max-width:620px;margin:48px auto;padding:32px;background:white;border:1px solid #dbe0ea;border-radius:20px}h1{font-size:30px;line-height:1.2}p{color:#525e73}label{display:block;margin-top:18px}input:not([type=checkbox]){display:block;width:100%;padding:12px;font:inherit;border:1px solid #8b96aa;border-radius:8px;margin-top:6px}input[type=checkbox]{width:19px;height:19px;vertical-align:middle;margin-right:8px}button,.button{display:inline-block;padding:12px 18px;margin:20px 8px 0 0;border:0;border-radius:9px;background:#1762d9;color:white;font:inherit;text-decoration:none;cursor:pointer}button:disabled{opacity:.45;cursor:default}a{color:#1762d9}#cancel{background:#edf1f8;color:#1b2233}#message{white-space:pre-line}#message[data-error=true]{color:#9b2637}[hidden]{display:none!important}:focus-visible{outline:3px solid #91b9fa;outline-offset:3px}@media(max-width:650px){main{margin:16px;padding:24px}}`;
export function credentialDocument(request: Request, env: RuntimeEnv) {
  const gates = appleGates(env);
  const nonce = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
  );
  const socket = new URL(request.url);
  socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
  const retentionTerms = `They are usable here for at most ${gates.retentionDays} days from device verification. Bounded saved-token renewal does not extend this fixed window. Apple may require verification or data approval earlier.`;
  const form = gates.enabled
    ? `<div id="login"><p>This is our unofficial iCloud connection page. Our code processes your password in this browser and sends authentication proofs to our Worker. Apple checks those proofs and your trusted device. This is not an Apple-hosted login.</p><p>You must trust this Site and its code with your password input. We do not offer a phone, SMS or legacy-code fallback.</p><form id="credentials" method="post" action="/api/auth/unsupported"><fieldset id="fields" disabled><label for="account">Apple Account</label><input id="account" type="text" autocomplete="username" maxlength="320" required><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" maxlength="4096" required><label><input id="apple-trust" type="checkbox" required>I agree to this protocol requesting Apple's remembered browser trust and extended login. Apple decides whether to grant that trust; it may outlast our local session.</label><label><input id="retention" type="checkbox" required>I allow this Worker to store my Apple session cookies and tokens encrypted. ${retentionTerms} Disconnect clears the stored record; expired records are cleared on next access.</label><button id="start" type="submit">Connect and verify device</button></fieldset></form></div><form id="verification" method="post" action="/api/auth/unsupported" hidden><p>The code field becomes available when Apple opens this attempt’s trusted-device challenge.</p><fieldset id="verification-fields" disabled><label for="code">Six-digit trusted-device code</label><input id="code" type="password" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" required><p>Enter Apple's device code here. Do not put passwords or codes in chat.</p><button type="submit">Verify device</button></fieldset></form><button id="cancel" type="button" hidden>Cancel sign-in</button><a id="continue" class="button" href="/" target="_top" hidden>Return to connection</a><noscript><p>JavaScript is required for local password proofs. Credentials cannot be submitted while it is disabled.</p></noscript>`
    : `<p>${appleDisabledMessage(gates)}</p><p>Apple sign-in is disabled by operator configuration. Refreshing this page does not contact Apple.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect iCloud · iCloud MCP</title><style nonce="${nonce}">${styles}</style>${gates.enabled ? `<script nonce="${nonce}" src="/api/auth/client.js" defer></script>` : ""}</head><body><main><a href="/" target="_top">← Back to private connection</a><h1>${gates.enabled ? "Connect your iCloud account" : "Apple sign-in paused"}</h1>${form}<p id="message" role="status" aria-live="polite"></p></main></body></html>`;
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
