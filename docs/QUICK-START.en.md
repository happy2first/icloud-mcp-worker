# Cloudflare deployment, step by step (no CLI)

[English README](../README.en.md) · [中文图解](USER-GUIDE.md)

**Fork → Import GitHub repo into Cloudflare Workers → Attach a custom domain → Configure Access / OAuth → Add 2 runtime variables and 1 Secret → Sign into Apple in your own admin page → Connect ChatGPT.**

You need a GitHub account, a Cloudflare account with Workers/D1 access, a domain already managed by Cloudflare, and an Apple account that can approve trusted-device sign-in. **No terminal, Mac, VPS, R2, local Node.js or Wrangler install is required for the recommended setup.** The hostname `icloud.example.com` is an example; replace it everywhere with your own subdomain.

> Unofficial Apple integration using private web protocols. Do not paste Apple passwords or session tokens into GitHub, public issue reports, chat, or Cloudflare Worker environment variables. The illustrations in this guide are based on current project labels, **not actual screenshots of personal accounts or of Cloudflare's UI**.

## 1. Fork the repository

1. Open [happy2first/icloud-mcp-worker](https://github.com/happy2first/icloud-mcp-worker).
2. Click **Fork → Create a new fork** under your GitHub account.
3. Keep the repository name `icloud-mcp-worker`. You do not need to edit or download any files.

The default `wrangler.toml` uses `name = "icloud-mcp-worker"`. Make the Cloudflare Worker name match that value.

## 2. Connect your fork to Cloudflare and deploy

1. Open [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages → Create application → Import a repository**.
2. Authorize GitHub if prompted and select `your-username/icloud-mcp-worker`.
3. Set branch `main` and project root to the repository root.
4. Set the following commands:

   | Field | Value |
   | --- | --- |
   | Worker name | `icloud-mcp-worker` |
   | Build command | `npm run build` |
   | Deploy command | `npm run deploy:cloud` |
   | Production branch | `main` |
   | Root directory | Repository root (default) |

5. Select **Save and Deploy**. Monitor the build log.

The deploy command performs `wrangler deploy` followed by `wrangler d1 execute DB --remote --file schema.sql --yes`. The checked-in configuration declares a D1 binding named `DB` and a database named `icloud-mcp-worker`, using name-based database creation/reuse. If the first build fails with a D1 provisioning/binding error, check the Workers Builds deployment token's D1 permissions or create a same-named D1 database under **Storage & Databases → D1** before retrying. **Never use a fake database_id**. If attaching a repo to an already-created Worker, use **Settings → Builds → Connect** and the same commands instead.

References: [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [Build configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

## 3. Set up a Custom Domain

1. Select the Worker in **Workers & Pages**.
2. Open **Settings → Domains & Routes → Add → Custom Domain** (some Cloudflare versions show a separate **Domains** tab).
3. Add `icloud.example.com` and confirm. Cloudflare manages its DNS and TLS settings; avoid creating a conflicting CNAME.
4. Keep the default disabled `workers.dev` and Preview URLs: you should use the Access-protected custom hostname exclusively.

Your future URLs will be:

- Management: `https://icloud.example.com/admin`
- Remote MCP: `https://icloud.example.com/mcp`

Do **not** enter Apple credentials until Access and the Worker encryption Secret are configured. Reference: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## 4. Protect the entire hostname with Access and enable OAuth

1. Open **Zero Trust → Access controls → Applications**, create a **Self-hosted** app (or compatible MCP server application).
2. Give it a name such as `iCloud MCP` and protect `icloud.example.com` **without a path restriction**. Do not secure only `/admin`; `/mcp`, `/connect/apple` and temporary downloads need protection too.
3. Create an **Allow** policy for your exact email or other explicitly authorized identity. **Do not use Everyone or Bypass**.
4. Open the application's **Advanced settings** and turn on **Managed OAuth**. Keep dynamic client registration enabled when offered.
5. Add **exactly** the following pattern to **Allowed redirect URIs**:

   ```text
   https://chatgpt.com/connector/oauth/*
   ```

6. Save. Copy **Application Audience (AUD) Tag** from the application settings / Additional settings for the Worker variable `POLICY_AUD`.

![Cloudflare Access OAuth illustration](images/access-oauth-setup.svg)

The callback above is a **client callback allowlist entry**, not a Worker endpoint or environment variable. Cloudflare Managed OAuth supports `/*` at the end of HTTPS paths; do not allow arbitrary domains. Access OAuth authorizes **ChatGPT to access your Worker**; Apple verification is separate. No manually registered OAuth client ID/secret is needed for this flow.

Reference: [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

## 5. Set runtime variables and one Secret

Select **Workers & Pages → icloud-mcp-worker → Settings → Variables and Secrets**. Use **runtime** bindings, **not** `Settings → Build → Build variables`.

| Key | Type | Value |
| --- | --- | --- |
| `TEAM_DOMAIN` | Plain text | Your Zero Trust team URL, e.g. `https://my-team.cloudflareaccess.com`. **Not** the iCloud subdomain. |
| `POLICY_AUD` | Plain text | **Application Audience (AUD) Tag** copied in step 4. |
| `ENCRYPTION_KEYS_JSON` | **Secret** | Standard Base64 string encoding **32 cryptographically random bytes**, entered raw without JSON or quotation marks. |

Generate the Secret only once on your own trusted machine:

- macOS/Linux: `openssl rand -base64 32`
- Windows PowerShell:

  ```powershell
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  [Convert]::ToBase64String($bytes)
  ```

**Back up the Secret in a safe place. Reuse the same key and D1 database for all ordinary code upgrades.** Replacing either makes previously encrypted Apple credentials unreadable. Apple passwords, cookies and session tokens are **not** among these Worker variables.

Save settings and, if needed, redeploy to ensure production has the updated bindings.

## 6. Configure Apple credentials in your own management page

Visit `https://icloud.example.com/admin`. Access should challenge you to sign in with your allowed identity first.

![Current admin page annotated illustration](images/admin-overview.svg)

### A. Apple web session: Reminders / Notes / Photos / Drive / Find My

1. In **凭证管理 / Credentials**, click **登录 Apple / Sign in to Apple** in the **Apple 网页登录** card.
2. Select **中国大陆（云上贵州） / mainland China** or **国际区 / international**, matching your Apple account.
3. Enter your Apple account and **primary password**, acknowledge the browser trust and encrypted-session storage notices, and submit.
4. Approve the sign-in on your trusted Apple device when requested. Enter the **six-digit verification code** displayed on the device.
5. Return to `/admin` once the page reports the session was saved. Saving a session is **not** proof that every service is working.

This is **your self-hosted, unofficial login page**, not an Apple-owned login site. The client calculates SRP proofs in the browser; the Worker does not persist the Apple primary password. Encrypted session cookies/tokens are stored in D1. Review and trust your own deployment before entering the credentials.

### B. Apple app-specific password: Calendar / Contacts only

Skip this entirely if you only need web-backed services.

1. At [account.apple.com](https://account.apple.com/), go to **Sign-In and Security → App-Specific Passwords** and generate a password.
2. In the management **App 专用密码** card, enter your Apple account email and that generated password, e.g. `xxxx-xxxx-xxxx-xxxx`.
3. Click **保存 / Save**. This password cannot authenticate Find My. Update it in the same card if you rotate it.

### C. Enable and check services

1. In **服务连接 / Service connections**, turn on only the services you need (off by default).
2. Leave write permissions off initially; click **检查连接 / Check connection** for each enabled service.
3. Complete additional trusted-device or PCS data access verification **only when Apple requests it**. A saved credential and a successful service check are different states.
4. If Find My prompts for **验证查找**, use its separate verification entry and re-enter the **same Apple primary password**. A Find My `REAUTH_REQUIRED` error does **not** mean you should repeatedly wipe and reconnect all credentials.
5. The **刷新页面状态** button only refreshes the locally saved state. It does not perform a new connection test.
6. Grant Calendar / Contacts / Reminders write access separately only when needed. Notes, Photos and Drive are read-only.

## 7. Connect ChatGPT or another remote MCP client

1. Copy the auto-generated MCP URL from the top of `/admin`; typically `https://icloud.example.com/mcp`.
2. Open the ChatGPT settings for adding a custom remote MCP connector and paste the URL. The exact menu label may differ by plan and product version.
3. Complete the **Cloudflare Access OAuth login** when redirected; this is **not** your Apple login.
4. First call `icloud_status`, then test a read-only tool such as `get_reminder_lists`. Refresh the client tool list if you upgrade the server's tools.

If the OAuth redirect is denied, check `https://chatgpt.com/connector/oauth/*` in Access. If the management page works but MCP OAuth fails, ensure the entire hostname is protected and Managed OAuth is enabled. If the Worker returns configuration errors, verify the runtime variable values and that you copied the AUD of the **correct** Access app.

## Completion checklist

- [ ] Forked repo and `main` linked to Workers Builds, build succeeded
- [ ] D1 database exists, `DB` binding works and schema initialization succeeded
- [ ] Custom HTTPS domain routes to the Worker and requires Access sign-in
- [ ] Access permits only trusted identities and Managed OAuth is on
- [ ] Allowed redirect URI includes `https://chatgpt.com/connector/oauth/*`
- [ ] `TEAM_DOMAIN` / `POLICY_AUD` set as runtime text variables; `ENCRYPTION_KEYS_JSON` set as runtime Secret
- [ ] Desired Apple credential type saved in management
- [ ] Desired services enabled and individually checked (write access only when required)
- [ ] ChatGPT connection and `icloud_status` / first read-only tool succeed

## Troubleshooting

| Symptom | First check |
| --- | --- |
| Worker name mismatch in build | Worker name must match `wrangler.toml` |
| D1 or DB not found | Database provisioning permissions; binding `DB`; `npm run deploy:cloud` command |
| Access login never appears | Entire custom hostname in Access app; policy isn't bypassed |
| OAuth callback rejected | Managed OAuth on; exact allowed callback pattern present |
| Management returns `CONFIGURATION_REQUIRED` / 403 | Runtime values of `TEAM_DOMAIN` and `POLICY_AUD`, correct domain/AUD |
| Find My says `REAUTH_REQUIRED` | Follow the separate Find My verification and error details; do not reconnect everything repeatedly |
| Calendar/Contacts fail | Correct app-specific password and region; service enabled and checked |
| Stored credentials suddenly unreadable | Restore original encryption Secret and D1 database |

## Optional: CLI deployment (advanced)

This section is **not** required for the browser-only deployment above. For local development, install Node.js 24+, then:

```bash
git clone https://github.com/happy2first/icloud-mcp-worker.git
cd icloud-mcp-worker
npm ci
npm run check
npx wrangler login
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

Set the **real** D1 `database_id` in the ignored `wrangler.local.toml`, keep the `DB` binding name, and add a top-level `routes = [{ pattern = "icloud.example.com", custom_domain = true }]`. Configure the same Access runtime variables and enter your already generated encryption Secret:

```bash
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
npx wrangler d1 execute DB --remote --file schema.sql --config wrangler.local.toml
npx wrangler deploy --config wrangler.local.toml
```

Never commit local configuration, encrypted credential dumps, Apple credentials or real logs to GitHub. Production updates should preserve the same key and database.

[Security policy](../SECURITY.md) · [Validation evidence](VALIDATION.md) · [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)