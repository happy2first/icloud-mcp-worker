# iCloud MCP Worker

[简体中文](README.md)

One Cloudflare Worker, TypeScript, D1, and Cloudflare Access with Managed OAuth. No Mac, VPS, R2, browser extension, bulk photo sync, or backup service.

**Initial implementation using unofficial Apple protocols. No real Apple account or Cloudflare production deployment has been validated. Passing synthetic tests does not demonstrate live service availability.**

## Capabilities

| Service | Implemented | Initial limitations |
|---|---|---|
| Calendar | CalDAV discovery, query, get, create, update; internal delete | UTC timed events; recurring/invitation/multiple-event edits refused; unknown fields and alarms retained |
| Contacts | CardDAV discovery, query, get, create, update; internal delete | Name/email/phone; supplied EMAIL/TEL replaces all values for that property; untouched properties retained |
| Reminders | Lists, paginated reads, exact lookup, create, update, complete, reopen; internal soft delete | Xzese CloudKit/CRDT implementation; version tags and deterministic creation IDs; shared discovery and complex linked writes unsupported |
| Notes | Folder pages, recents, title/snippet search, Protobuf body decoding | Read-only; continue pages for exhaustive title/snippet search; body search, locked notes and rich attachment/table rendering unsupported |
| Photos | Personal albums, indexed queries, metadata, thumbnails, selected downloads | Read-only; CPLAsset/CPLMaster pairing; shared libraries and legacy shared albums unsupported |
| Drive | DriveWS directory browsing/directory search and DocWS download | Read-only; no recursive search, shared-owner namespace, uploads, or backups |

No delete, authentication, credential-entry, or PCS tools are exposed through MCP. Services and write permissions start disabled and are independently managed in `/admin`.

## Authentication

The Chinese management UI now uses mobile-first service cards and matching login styles. See the [detailed deployment/credential guide](docs/USER-GUIDE.md) and [latest authentication/UI review](docs/AUTH-AND-UI-REVIEW.md). DOM interaction tests pass; iPhone Safari and screenshot/layout verification remain pending.

The management flow uses `/admin` and its isolated `/connect/apple` credential document. The primary password is used for SRP proofs in the browser only; the Worker receives authentication proofs. Modern trusted-device SPAKE2 verification is reused from Xzese; SMS/phone/legacy code and hardware security keys are unsupported, without fallback.

The web session is shared by Reminders, Notes, Photos, and Drive. Separate PCS state is stored for `reminders`, `notes3`, `photos`, and `iclouddrive`. Each approval check makes at most two requests and returns pending state without sleeping. Login and saved-token recovery default on. New sessions have no local retention deadline; Apple may still revoke access or require sign-in. Primary passwords are never saved or used for background login.

Verified account credentials are persisted before service PCS requests. Authorize each service from its card after returning from login; Reminders approval failure does not discard a verified account login. Actions are serialized and show persisted PCS cooldowns. Disabling a service clears its write permission. App-specific password paste supports spaces/hyphens or 16 lowercase letters; stored credentials must still pass separate live DAV checks.

Calendar and Contacts use an app-specific password entered in the management page. Both credential classes are AES-256-GCM encrypted in D1 with owner/account/generation/record-bound AAD, random IVs and one Secret-only key. Session leases/version fences prevent stale writes; DAV uses ETag/If-Match and deterministic UUID/If-None-Match creation. Service-specific endpoint allowlists reject arbitrary Apple APIs and non-Apple hosts.

## Deploy

The first Access-authenticated API request initializes missing D1 tables using the same schema.sql embedded at build time. Reinitialization preserves existing credentials/sessions; incompatible existing columns require an explicit migration. Management status does not call Apple, and database errors are reported separately from Apple connection failures.

Production deployment remains unverified. For Git-connected Cloudflare Workers Builds, use `npm run build` as the build command and `npm run deploy:cloud` as the deploy command. Wrangler reuses or provisions the named D1 database; the deploy script then applies the non-destructive initial schema. The tracked configuration no longer contains a placeholder database ID. The ignored local configuration below is not available to cloud builds. Set up a custom hostname and the two Access variables in the Dashboard, and store `ENCRYPTION_KEYS_JSON` as a runtime Worker Secret. The build token needs Worker deployment and D1 read/write permissions. See the [cloud deployment checklist](docs/USER-GUIDE.md#11-cloudflare-workers-builds从-github-部署).

```bash
npm ci
npm run check
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

Edit the ignored local config: replace the database ID, add a custom-domain route, and configure:

| Variable | Value |
|---|---|
| `TEAM_DOMAIN` | Full `https://your-team.cloudflareaccess.com` |
| `POLICY_AUD` | Access application audience protecting the entire hostname |

Only TEAM_DOMAIN and POLICY_AUD are required ordinary variables; configure them in the Dashboard (`keep_vars=true`). Set the runtime Secret ENCRYPTION_KEYS_JSON to the standard Base64 string of one random 32-byte key, without JSON, quotes or a version label. The variable name and legacy single-key JSON support remain for compatibility. When converting an existing Secret, extract the same key value; do not generate a replacement or existing records will become unreadable. APPLE_LOGIN_ENABLED=false and APPLE_SESSION_RENEWAL_ENABLED=false are optional emergency switches; the retention variable is unused.

Generate a 32-byte key locally and paste its Base64 output directly into Workers Secrets. Never send passwords, codes, keys, cookies, or tokens in chat.

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
# Paste the Base64 output directly, without JSON or quotes
npx wrangler d1 execute DB --remote --config wrangler.local.toml --file schema.sql
npx wrangler deploy --config wrangler.local.toml
```

Protect the entire custom hostname with one Cloudflare Access application and an owner-only policy. Enable **Managed OAuth** in its advanced settings; do not deploy a second OAuth server. The Worker verifies the forwarded Access JWT signature, issuer, audience, expiry and owner, stripping spoofed identity headers. See [official Cloudflare instructions](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

The HTTPS request origin is derived automatically and browser actions remain same-origin checked. Credentials, sessions, service permissions and tickets use the verified Access JWT sub as their namespace. Keep the Access policy restricted to yourself; another admitted identity gets independent data. APP_ORIGIN and REMINDERS_OWNER_ID are optional legacy restrictions and can be removed. workers.dev and preview URLs remain disabled. Old 1/30-day login records remain compatible; sign in once to adopt unlimited retention. Apple-issued cookies/tokens, PCS checkpoints, login leases and download tickets keep their own validity limits.

## Connect and validate

1. Open `/admin` through Access.
2. Sign into Apple and complete trusted-device verification. Request/check PCS for each web service.
3. Enter an app-specific password, enable desired services, and keep writes disabled initially.
4. Use each service's check button. A successful check proves only that specific read at that time.
5. Add `https://your-host/mcp` to a ChatGPT client supporting remote MCP, and authenticate through Managed OAuth.
6. Call `icloud_status`, then service tools. Enable writes only for the desired services and validate with dedicated test resources.

After `WRITE_OUTCOME_UNKNOWN`, reconcile the exact UUID/resource/version before retrying. See [protocol and acceptance guide](docs/PROTOCOL-AND-ACCEPTANCE.md).

## Operational bounds

60 MCP/management operations per owner per minute. Typical Apple HTTP timeout 8–10 seconds; each generic web attempt is limited to 25 seconds, with a 40-second total network budget including session recovery. CloudKit continuation and photo offsets expose completion explicitly. Photo offsets reflect a changing live index. DAV and Drive paginate bounded responses rather than claiming unlimited enumeration: DAV response 2 MiB, other Apple JSON 1 MiB, Notes decompressed body 256 KiB.

Signed Apple asset URLs never appear in MCP results. Encrypted download tickets expire within five minutes or the session's earlier expiry. Each redemption checks the owner, source service permission and Apple session generation. Authenticated HTTP streaming supports up to 100 MiB/60 seconds; MCP `resources/read` supports up to 5 MiB, thumbnails up to 1 MiB as MCP image content. Larger files require the Access-authenticated HTTP URL. Disabling a service blocks later redemptions; disconnect/reconnect invalidates old tickets. Already-started streams are not guaranteed to stop immediately.

See the [2026-10-12 code review](docs/CODE-REVIEW.md) for fixes and regression coverage. This review does not certify live Apple or production behavior.

## Sources and validation

Xzese authentication/crypto/session/Access/Reminders modules and tests are directly reused under MIT. Notes, Photos and Drive protocols are ported from pyicloud. See [pinned source review](docs/RESEARCH.md) and retained licenses.

```bash
npm run typecheck
npm test
npm run build
npm run test:worker
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

See [validation evidence](docs/VALIDATION.md). Real Apple and production Cloudflare verification are pending. China-region `.icloud.com.cn` endpoints, account-specific risk controls and real-device WebSocket authentication have not been tested; the current allowlists support `.icloud.com` only and reject unrecognized regional services.


## Apple Find My

Three new MCP tools reuse the current Access owner's encrypted **Apple Web session**, session renewal, and HTTP transport. No new environment variables, database, service, or management page. Find My does not require Reminders PCS approval or the existing six service switches: it follows Apple login availability (`APPLE_LOGIN_ENABLED=false` disables it). `icloud_status.findmy` reports local session availability, not live Apple validation. Older sessions missing the `fmip` root receive one existing session-validation attempt; unsupported/missing roots fail explicitly rather than being guessed.

| Tool | Usage |
|---|---|
| `findmy_list_devices` | No arguments. Lists accessible own and Family Sharing devices with name, type, owner, online state, battery and family-loading metadata. |
| `findmy_get_location` | `{ "deviceId": "ID from listing", "refresh": true }`. Default requests a fix; `false` reads last-reported data without `shouldLocate`. |
| `findmy_play_sound` | After explicit user confirmation for the **specific device**, send `{ "deviceId": "ID", "confirmed": true }`. Never automatically retry. |

Members must belong to the same Apple Family Sharing group and permit the current account to access the relevant devices/locations through Apple's Find My and sharing settings. Family membership alone does not guarantee location access. Requests always set `fmly=true`. `membersInfo.deviceFetchStatus=LOADING` triggers bounded refreshes, stopping when no progress occurs; device IDs are merged without duplicates. `familyComplete=false` means incomplete/unknown family availability. LOADING alone is not evidence of permission denial.

Locations include coordinates, accuracy in metres, millisecond timestamp, ISO time, `isOld`, and age; unknown values are null. `refreshAccepted` means only that Apple accepted a refresh. `newLocationObtained` requires a timestamp newer than the baseline and at least the request start, plus Apple's `isOld=false`. `LOCATION_TIMEOUT` can include historical data and does not claim a new fix. `DEVICE_OFFLINE`, `NO_LOCATION_PERMISSION`, and `LOCATION_UNAVAILABLE` describe offline devices, explicit denial, and unavailable locations respectively.

Sound acceptance does not prove playback; offline devices may play later. Ambiguous failures return `WRITE_OUTCOME_UNKNOWN`: check the device and obtain fresh confirmation before another attempt. Existing bounded session recovery and 2FA are retained; no untrusted-session downgrade or authentication bypass. Missing services, auth challenges, permission denial, protocol changes and rate limits produce actionable errors.

Friends' shared locations, AirTags, lost mode and erase are unsupported. Context and locations exist only within the request, with no location persistence or background polling. Apple's private protocol may change.

**Validation: synthetic tests, existing regressions, and the local workerd Access → MCP → encrypted session → mocked Apple HTTP flow pass. No real Apple account or production deployment has been verified, and no real device sound has been triggered.** See [Find My validation](docs/FINDMY-VALIDATION.md). After deploying, list devices and query a returned ID first; playing sound requires separate explicit confirmation.
