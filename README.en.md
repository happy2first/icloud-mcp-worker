# iCloud MCP Worker

[简体中文](README.md)

One Cloudflare Worker, TypeScript, D1, and Cloudflare Access with Managed OAuth. No Mac, VPS, R2, browser extension, bulk photo sync, or backup service.

**Initial implementation using unofficial Apple protocols. No real Apple account or Cloudflare production deployment has been validated. Passing synthetic tests does not demonstrate live service availability.**

## Capabilities

| Service | Implemented | Initial limitations |
|---|---|---|
| Calendar | CalDAV discovery, query, get, create, update; internal delete | UTC timed events; recurring/multiple-event edits refused; unknown fields and alarms retained |
| Contacts | CardDAV discovery, query, get, create, update; internal delete | Name/email/phone; supplied EMAIL/TEL replaces all values for that property; untouched properties retained |
| Reminders | Lists, paginated reads, exact lookup, create, update, complete, reopen; internal soft delete | Xzese CloudKit/CRDT implementation; version tags and deterministic creation IDs; shared discovery and complex linked writes unsupported |
| Notes | Folder pages, recents, title/snippet search, Protobuf body decoding | Read-only; continue pages for exhaustive title/snippet search; body search, locked notes and rich attachment/table rendering unsupported |
| Photos | Personal albums, indexed queries, metadata, thumbnails, selected downloads | Read-only; CPLAsset/CPLMaster pairing; shared libraries and legacy shared albums unsupported |
| Drive | DriveWS directory browsing/directory search and DocWS download | Read-only; no recursive search, shared-owner namespace, uploads, or backups |

No delete, authentication, credential-entry, or PCS tools are exposed through MCP. Services and write permissions start disabled and are independently managed in `/admin`.

## Authentication

The management flow uses `/admin` and its isolated `/connect/apple` credential document. The primary password is used for SRP proofs in the browser only; the Worker receives authentication proofs. Modern trusted-device SPAKE2 verification is reused from Xzese; SMS/phone/legacy code and hardware security keys are unsupported, without fallback.

The web session is shared by Reminders, Notes, Photos, and Drive. Separate PCS state is stored for `reminders`, `notes3`, `photos`, and `iclouddrive`. Each approval check makes at most two requests and returns pending state without sleeping. Saved cookies/tokens are validated and may be recovered through one bounded token exchange. The absolute local retention window is 30 days; Apple may revoke access earlier. Primary passwords are never saved or used for background login.

Calendar and Contacts use an app-specific password entered in the management page. Both credential classes are AES-256-GCM encrypted in D1 with owner/account/generation/record-bound AAD, random IVs and a Secret-only key ring. Session leases/version fences prevent stale writes; DAV uses ETag/If-Match and deterministic UUID/If-None-Match creation. Service-specific endpoint allowlists reject arbitrary Apple APIs and non-Apple hosts.

## Deploy

The checked-in D1 ID is a placeholder. No production infrastructure exists in this checkout.

```bash
npm ci
npm run check
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

Edit the ignored local config: replace the database ID, add a custom-domain route, and configure:

| Variable | Value |
|---|---|
| `APP_ORIGIN` | Exact HTTPS application origin, no trailing slash |
| `TEAM_DOMAIN` | Full `https://your-team.cloudflareaccess.com` |
| `POLICY_AUD` | Access application audience protecting the entire hostname |
| `REMINDERS_OWNER_ID` | Allowed Access JWT `sub`; upstream name retained, applies to all services |
| `APPLE_LOGIN_ENABLED` | `true` enables new browser sign-ins |
| `APPLE_SESSION_RENEWAL_ENABLED` | `saved-tokens-v1` |
| `APPLE_SESSION_RETENTION_WRITES` | `absolute-30d-v1` |
| `ENCRYPTION_KEY_ID` | Active key identifier, e.g. `v1` |

Generate a 32-byte key locally and enter the JSON key ring through Workers Secrets. Never send passwords, codes, keys, cookies, or tokens in chat.

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
# Enter {"v1":"your-local-base64-key"}
npx wrangler d1 execute DB --remote --config wrangler.local.toml --file schema.sql
npx wrangler deploy --config wrangler.local.toml
```

Protect the entire custom hostname with one Cloudflare Access application and an owner-only policy. Enable **Managed OAuth** in its advanced settings; do not deploy a second OAuth server. The Worker verifies the forwarded Access JWT signature, issuer, audience, expiry and owner, stripping spoofed identity headers. See [official Cloudflare instructions](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

To obtain the owner ID, deploy initially without `REMINDERS_OWNER_ID`, sign into Access and visit `/api/bootstrap/identity`. Configure its `authenticatedUserId` and redeploy. All other application/MCP routes stay blocked until an owner is explicitly configured. `workers_dev` and preview URLs remain disabled. Keep old keys in the Secret key ring during rotation until credentials and sessions have been rewritten.

## Connect and validate

1. Open `/admin` through Access.
2. Sign into Apple and complete trusted-device verification. Request/check PCS for each web service.
3. Enter an app-specific password, enable desired services, and keep writes disabled initially.
4. Use each service's check button. A successful check proves only that specific read at that time.
5. Add `https://your-host/mcp` to a ChatGPT client supporting remote MCP, and authenticate through Managed OAuth.
6. Call `icloud_status`, then service tools. Enable writes only for the desired services and validate with dedicated test resources.

After `WRITE_OUTCOME_UNKNOWN`, reconcile the exact UUID/resource/version before retrying. See [protocol and acceptance guide](docs/PROTOCOL-AND-ACCEPTANCE.md).

## Operational bounds

60 MCP/management operations per owner per minute. Typical Apple HTTP timeout 8–10 seconds; web operation deadline 25 seconds. CloudKit continuation and photo offsets expose completion explicitly. Photo offsets reflect a changing live index. DAV and Drive paginate bounded responses rather than claiming unlimited enumeration: DAV response 2 MiB, other Apple JSON 1 MiB, Notes decompressed body 256 KiB.

Signed Apple asset URLs never appear in MCP results. Encrypted download tickets expire after five minutes and belong to the owner. Authenticated HTTP streaming supports up to 100 MiB/60 seconds; MCP `resources/read` supports up to 5 MiB, thumbnails up to 1 MiB. Larger files require the Access-authenticated HTTP URL. Disconnect revokes outstanding download tickets.

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
