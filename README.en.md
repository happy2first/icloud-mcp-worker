# iCloud MCP Worker

[简体中文](README.md) · [Deployment guide (Chinese)](docs/USER-GUIDE.md) · [Security](SECURITY.md)

A self-hosted iCloud MCP server on Cloudflare Workers. Connect any agent supporting remote MCP to Calendar, Contacts, Reminders, Notes, Photos, iCloud Drive and Find My. Management stores credentials, checks connections, controls writes and generates the MCP URL from the actual deployment origin.

**TypeScript + Workers + D1 + Cloudflare Access Managed OAuth.** No Mac, VPS, R2 or browser extension required.

> Unofficial project using private Apple web protocols and CalDAV/CardDAV. Select mainland China (GCBD) or international endpoints at sign-in. A real mainland account has completed deployment, authentication and service integration checks; this does not establish compatibility for every account, region or edge case, nor constitute an independent security audit.

## Features

| Service      | Supported                                                                       | Main limits                                                                                   |
| ------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Calendar     | Collection discovery, query, get, create, update                                | UTC timed events; no recurring, invitation or multi-event edits                               |
| Contacts     | Collection discovery, query, get, create, update                                | Name/email/phone; supplied EMAIL/TEL replaces all values of that property                     |
| Reminders    | Lists, paginated/exact reads, all open items, create, update, complete, reopen  | Version-guarded writes; complex recurrence, subtasks and shared-list discovery unsupported    |
| Notes        | Folders, lists, title/snippet search, body reads                                | Read-only; no body search, locked notes or complete attachment/complex-table rendering        |
| Photos       | Personal albums, queries, metadata, thumbnails, selected downloads              | Read-only; no shared libraries, legacy shared albums, people recognition queries or bulk sync |
| iCloud Drive | Directory browsing/filtering, resource reads, downloads                         | Read-only; no recursive search, uploads, backups or shared-owner namespace                    |
| Find My      | Own/accessible family devices, last reported location, requested refresh, sound | Explicit confirmation for sound; no friends, AirTags, lost mode or erase                      |

No delete, sign-in, credential-entry or service-authorization tools are exposed through MCP. Calendar, Contacts and Reminders have separate write switches; the six data services start disabled. Find My uses the saved Apple web session rather than an app-specific password.

**Recurring completion completes only the current occurrence.** Supported roots have interval-one timed daily/weekly recurrence, one absolute date alarm, and no end date, complex patterns, subtasks, attachments, tags or assignments. One atomic operation creates completed history and keeps the original root open with its next date/alarm. It does not skip multiple overdue periods. The returned record is the completed occurrence; `nextOccurrence` is the still-open original root. Other shapes are refused rather than completing the whole series.

## Credentials

| Credential                  | Services                                 | Entry                                                        |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| Apple web session           | Reminders, Notes, Photos, Drive, Find My | Management sign-in and requested trusted-device verification |
| Apple app-specific password | Calendar, Contacts                       | Generate on Apple's account page, then enter in management   |

The primary password participates in SRP calculations only in the management browser; the Worker receives proofs. It is neither saved nor used for background sign-in. Web cookies/tokens and app-specific passwords are AES-256-GCM encrypted separately in D1 and bound to the verified Access identity.

Saved credentials do not prove a working connection. Check each service. Additional device/data-access approval (PCS) runs **only when Apple requires it**. Find My similarly follows Apple's verification requirements; app-specific passwords cannot replace its web sign-in. Page refresh reads stored credential/connection state without calling Apple again.

New web sessions have no local retention deadline until disconnected, but Apple can revoke them or require sign-in. Live validation used Advanced Data Protection off; enabled ADP remains unverified. SMS, phone and hardware security-key sign-in flows are unsupported.

## Deployment

Requirements: Node.js 24+, Cloudflare Workers/D1 permissions and a custom Cloudflare hostname. Protect the entire hostname with Access, allow only your intended identity and enable [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

### Local deployment

```bash
git clone https://github.com/happy2first/icloud-mcp-worker.git
cd icloud-mcp-worker
npm ci
npm run check
npx wrangler login
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

Set the real D1 `database_id` in the ignored `wrangler.local.toml`, retaining binding DB. Add your route at the top level, before any [section]:

```toml
routes = [{ pattern = "icloud.example.com", custom_domain = true }]
```

Configure two ordinary variables and one Secret:

| Name                   | Type          | Value                                                              |
| ---------------------- | ------------- | ------------------------------------------------------------------ |
| `TEAM_DOMAIN`          | Variable      | Full Access team URL, e.g. https://your-team.cloudflareaccess.com  |
| `POLICY_AUD`           | Variable      | AUD of the Access application protecting the hostname              |
| `ENCRYPTION_KEYS_JSON` | Worker Secret | Standard Base64 of 32 random bytes; raw value, without JSON/quotes |

Set variables in the Dashboard or your local [vars]. `keep_vars=true` preserves Dashboard variables. The encryption Secret's name retains backward compatibility; legacy JSON key configuration remains readable.

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
# Enter the generated value at the interactive prompt
npx wrangler d1 execute DB --remote --file schema.sql --config wrangler.local.toml
npx wrangler deploy --config wrangler.local.toml
```

These are first-deployment steps. Existing deployments must reuse their database and encryption key. Generating a replacement key for an ordinary update makes saved credentials unreadable. Apple passwords, cookies and tokens do not belong in Wrangler configuration.

### GitHub → Cloudflare Workers Builds

Connect the repository; use npm run build for building and npm run deploy:cloud for deployment. Configure the same variables, Secret and custom hostname in Cloudflare; cloud builds cannot read your local `wrangler.local.toml`. The default configuration reuses/provisions D1 by name and the deploy script applies the initial schema. Explicitly bind an existing database with a different name rather than accidentally creating a replacement.

Tracked configuration disables `workers.dev` and preview URLs; use an Access-protected custom hostname. Apple login/renewal default on. Set `APPLE_LOGIN_ENABLED`=false or `APPLE_SESSION_RENEWAL_ENABLED`=false only to pause them deliberately. Origin and owner identity come from actual requests and verified Access JWTs, not required configuration variables.

## Connect any MCP client

1. Visit /admin on your deployment and authenticate through Access.
2. Save the web session and/or app-specific password you need, selecting the correct Apple region.
3. Enable services and check them individually. Verify only when Apple requests it.
4. Copy the generated MCP URL into a client supporting remote MCP and OAuth. It resembles https://icloud.example.com/mcp; use management's actual value.
5. Call `icloud_status`, then read tools. Enable individual write permissions only when needed.

Clients are not limited to ChatGPT. OAuth grants access to your MCP server; Apple credentials are entered separately in management. Refresh the client's tool list after server tool changes if needed.

| Service             | Common read tools                                                                    |
| ------------------- | ------------------------------------------------------------------------------------ |
| Calendar / Contacts | `calendar_collections` / `contacts_collections`, then query/get                      |
| Reminders           | `get_reminder_lists`, `get_reminders`, `get_reminder`, `get_all_open_reminders`      |
| Notes               | `notes_folders`, `notes_list`, `notes_search`, `notes_get`                           |
| Photos              | `photos_albums`, `photos_query`, `photos_get`, `photos_thumbnail`, `photos_download` |
| Drive               | `drive_browse`, `drive_download`                                                     |
| Find My             | `findmy_list_devices`, `findmy_get_location`                                         |

Find My exposes authorized family devices, not friends' shared locations. `refresh=false` reads the last reported location. Accepted refresh is not proof of a new location: inspect `newLocationObtained`, timestamps and `isOld`. Call `findmy_play_sound` with `confirmed=true` only after the user confirms the specific device; acceptance does not prove a device actually sounded.

Thumbnails return MCP image content; inline display depends on the client. Downloads return temporary Access-protected URLs and icloud-file:// resources, never Apple signed URLs. Resource reads are limited to 5 MiB; HTTP downloads to 100 MiB/60 seconds. Tickets last at most five minutes and become unusable when their service is disabled or session changes.

## Errors and safe writes

Errors include code, message, `retryable` and `requestId`. Management provides copy controls for results, error details and technical state.

| Code                                                | Action                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `NOT_CONNECTED` / `REAUTH_REQUIRED`                 | Inspect service/credential type; verify web sign-in or replace the DAV app-specific password                      |
| `DEVICE_APPROVAL_PENDING` / `VERIFICATION_REQUIRED` | Follow management instructions for trusted-device approval/verification; avoid repeated attempts                  |
| `CONFLICT`                                          | Read current versions/state before considering another write                                                      |
| `UPSTREAM_UNAVAILABLE` / `RATE_LIMITED`             | Inspect details and wait for network recovery or the stated retry time                                            |
| `UNSUPPORTED_FEATURE` / `PROTOCOL_CHANGED`          | Check scope or project updates; do not bypass validation                                                          |
| `WRITE_OUTCOME_UNKNOWN`                             | Apple may have saved the action; reconcile the original item and occurrence ID from details before further writes |

Reuse the same `idempotencyKey` for a create. Updates/completion require a freshly read `recordChangeTag`; DAV uses ETags. After recurring completion the original ID represents the next occurrence: do not fetch its new version and complete it again to retry the previous one. No automatic replay, new-ID retry or forced overwrite. Permission, pagination, response-size, version and time budgets are bounded; arbitrary large collections are not guaranteed to be fully enumerable.

## Development and validation

```bash
npm ci
npm run check
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

check runs type checking, Node tests, bundling and local workerd checks. Fixtures are synthetic and require no Apple credentials. On 2026-10-14, 223 Node tests passed. Mainland service connections and several reads were exercised live; a simple weekly completion was reconciled as current-occurrence-only. Real sound playback, every write shape, all regions and long-term reliability remain unverified. See [validation evidence](docs/VALIDATION.md).

For issues, provide the tool, redacted arguments, error code, request ID and time. Do not upload passwords, cookies, tokens, personal screenshots or unredacted logs. See [Security](SECURITY.md) and the [pre-publication review](docs/OPEN-SOURCE-REVIEW.md).

## Attribution and license

[MIT License](LICENSE). Authentication, cryptography, sessions, CloudKit/CRDT and Reminders derive from [Xzese's Worker](https://github.com/Xzese/icloud-mcp-for-cloudflare-workers). Notes, Photos, Drive and Find My protocols reference [timlaing/pyicloud](https://github.com/timlaing/pyicloud). Upstream notices are retained in [provenance/NOTICE.md](provenance/NOTICE.md); see [research notes](docs/RESEARCH.md). No Python runtime is deployed.
