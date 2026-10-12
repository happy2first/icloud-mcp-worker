# Source review and reuse

Reviewed on 2026-10-12. These are source observations, not independent confirmation of live Apple behavior.

## Xzese

Repository: https://github.com/Xzese/icloud-reminders-mcp-for-cloudflare-workers
Pinned revision: `f4da3d8ef41b5bc16415a75abc0043d16e3fcba2` (MIT).

Read implementation and tests for:

- `src/auth/apple/flow.ts`, `bridge.ts`, `boot-context.ts`, `protocol.ts`, `http.ts`, `pcs.ts`, `session-renewal.ts`: browser SRP proof exchange, modern device bridge/WebSocket, trust/account login, PCS checkpoints and token renewal.
- `src/crypto/*`, `auth/browser-proof.ts`, `auth/credential-entry.ts`, `app/apple-auth-client.ts`: browser-only password/KDF/SPAKE inputs, bounded codecs, challenge binding and crypto test vectors.
- `transport/apple-http.ts`, `cookie-jar.ts`, `apple-websocket.ts`, `apple-push.ts`: manual validated redirects, distinct Set-Cookie handling and bounded interactive push channels.
- `persistence/apple-sessions.ts`: encrypted sessions, absolute expiry, D1 compare-and-swap generation/version leases, disconnect/renewal fencing.
- `platform/cloudflare-access.ts`, `mcp/handler.ts`, `mcp/schemas.ts`, `icloud/cloudkit.ts`, `reminders/writes.ts`, `reminders/crdt.ts`: JWT verification, stateless MCP transport, direct current list discovery, exact versioned writes and deterministic create IDs.
- `tests/auth-flow.test.ts`, `protocol.test.ts`, `security.test.ts`, `persistence.test.ts`, `session-renewal.test.ts`, `reminder-write.test.ts`, `icloud-read.test.ts`, `cloudflare-access.test.ts` plus synthetic Python-derived protocol fixtures.

Directly copied these protocol modules and applicable tests, preserving their MIT license and provenance. Removed Next.js/vinext/React/Sites and R2 binding dependencies; created a plain Worker entry and static management document. Added service endpoints and PCS maps while retaining the reminder session schema and environment naming for compatibility. Replaced upstream approval-marker rollout gates with explicit `APPLE_LOGIN_ENABLED`; `cryptographyReviewed` and `liveConnectionApproved` remain false rather than inventing approval evidence. Tests were adapted for the new opt-in and removed upstream-only local CLI test.

## pyicloud

Repository: https://github.com/timlaing/pyicloud
Pinned revision: `d0a0d3747fa145f9b89a130af17a364f5252af2b` (MIT).

Inspected `base.py` authentication/session reuse/PCS and service construction; `services/drive.py` directory/document protocol; `services/calendar.py` and `contacts.py` facades; Reminders CloudKit/protocol/mapping code; `common/cloudkit/client.py`; Notes constants/client/service/decoding/`protobuf/notes.proto`; modern Photos constants/queries/client/service/mappers.

Protocol decisions reflected in implementation:

- `notes3`, not `notes`, is the PCS app name. Notes container is `com.apple.notes`, custom `Notes` zone; recents uses `SearchIndexes` and `indexName=recents`. Folder enumeration uses `changes/zone`; search/filter applies to each bounded recents page.
- Notes compression may be gzip, zlib or raw deflate. Plain text path is `NoteStoreProto.document[2].note[3].note_text[2]`. PasswordProtectedNote is not decoded. Rich attachments/tables are explicitly excluded.
- Photos container is **`com.apple.photos.cloud`**, not `com.apple.photos`; zone `PrimarySync`. Album index `CPLAlbumByPositionLive`; personal photo index `CPLAssetAndMasterByAssetDateWithoutHiddenOrDeleted`; compound queries request two records per requested photo. Join CPLAsset.masterRef to CPLMaster, retaining multiple assets sharing a master. Asset tokens come from resOriginalRes/resJPEGThumbRes and remain private.
- Drive directory reads POST `/retrieveItemDetailsInFolders` to advertised `drivews`. Downloads GET `/ws/com.apple.CloudDocs/download/by_id?document_id=…` from advertised `docws`, then stream data_token/package_token URL. This is not a generic CloudKit operation. Shared-owner namespace is not implemented.
- pyicloud's Calendar/Contacts facades use web APIs, not CalDAV/CardDAV. Those endpoints were **not** transplanted as DAV protocols. DAV uses standard discovery/REPORT/conditional PUT with a separately entered app-specific password. Actual Apple DAV compatibility still requires live verification.

## Existing user repository and platform

Inspected `happy2first/personal-mail-mcp` source tree and `src/entry.js` Access JWT verification, MCP error shape and credential separation. Used the stricter Xzese Access verifier, rather than importing mail/Node socket dependencies.

Managed OAuth is provided at the Cloudflare Access layer, with standard forwarding of `Cf-Access-Jwt-Assertion`; no custom OAuth credentials or Token endpoints are added. Official guide: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/

## Remaining compatibility questions

Real modern Apple device bridge operation from Workers, Cloudflare egress/account risk controls, live PCS cookie distribution per service, nested/personal photo album query behavior, Apple DAV field quirks and regional service hosts remain unverified. Tests use synthetic responses and enforce fail-closed protocol changes; they do not answer those account-specific questions.
