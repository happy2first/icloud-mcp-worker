# Protocol and acceptance guide

> Historical review/checklist. For current live evidence and limits, see [VALIDATION.md](VALIDATION.md). 本文件保留当时的审查/验收计划，当前状态以验证记录为准。

MCP uses stateless Streamable HTTP POST `/mcp`, with SDK JSON-RPC negotiation and MCP resource reads. GET/SSE sessions are not required. Apple data is untrusted content; tool results are data, never instructions or authorization to invoke management APIs.

## Tools

| Service   | Tools                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status    | `icloud_status`, `connection_status` (reminder compatibility)                                                                                                 |
| Calendar  | `calendar_collections`, `calendar_query`, `calendar_get`, `calendar_create`, `calendar_update`                                                                |
| Contacts  | `contacts_collections`, `contacts_query`, `contacts_get`, `contacts_create`, `contacts_update`                                                                |
| Reminders | `get_reminder_lists`, `get_reminders`, `get_reminder`, `get_all_open_reminders`, `create_reminder`, `update_reminder`, `complete_reminder`, `reopen_reminder` |
| Notes     | `notes_folders`, `notes_list`, `notes_search`, `notes_get`                                                                                                    |
| Photos    | `photos_albums`, `photos_query`, `photos_get`, `photos_thumbnail`, `photos_download`                                                                          |
| Drive     | `drive_browse`, `drive_download`                                                                                                                              |

Download tools return an owner-bound `icloud-file://UUID` resource and an Access-protected HTTP URL. No raw Apple download Token appears in either. MCP clients can call resources/read (5 MiB ceiling). Large transfers use the authenticated HTTP stream rather than loading the file into the MCP tool response.

## Errors

| Code                               | User action                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_CONNECTED`                    | Enter app-specific credentials or connect the Apple web session in `/admin`                                                            |
| `REAUTH_REQUIRED` / `AUTH_EXPIRED` | Refresh credentials or repeat web login/device verification; expired download references require a new reference                       |
| `VERIFICATION_REQUIRED`            | Complete fresh trusted-device verification in the management flow                                                                      |
| `DEVICE_APPROVAL_PENDING`          | Request/check service PCS in `/admin`; approve Apple's web-access prompt and respect nextAttemptAt                                     |
| `UNSUPPORTED_AUTH`                 | New login disabled or Apple challenge unsupported; inspect settings/use official Apple interface, without weakening account protection |
| `FORBIDDEN`                        | Enable the service/write permission or resolve Apple resource/account permissions                                                      |
| `RATE_LIMITED`                     | Wait retryAfterSeconds when available, otherwise retry later; local owner limit resets each minute                                     |
| `TERMS_ACTION_REQUIRED`            | Review terms in Apple's official interface                                                                                             |
| `CONFLICT`                         | Refresh current generation/version/ETag or resource ID; never force overwrite                                                          |
| `WRITE_OUTCOME_UNKNOWN`            | Read the exact target before retrying; retain creation UUID/idempotencyKey                                                             |
| `PROTOCOL_CHANGED`                 | Unexpected private API/schema response; inspect updates and rerun controlled read                                                      |
| `UNSUPPORTED_FEATURE`              | Unsupported resource or bounded size exceeded; use Apple's application for that operation                                              |
| `UPSTREAM_UNAVAILABLE`             | Network/timeout/service interruption; preserve credentials, retry later                                                                |
| `CONFIGURATION_REQUIRED`           | Configure D1 and encryption Secrets; do not paste credentials into chat                                                                |

## Live acceptance (pending)

Use an operator's controlled Apple account. Do not store actual note/contact/calendar content, signed URLs, cookies or Tokens in committed test fixtures/logs.

1. Configure custom domain, D1, encryption Secret, Access audience/owner and Managed OAuth. Confirm missing/forged Access headers and a second identity cannot reach pages or MCP.
2. From `/admin`, complete modern-device SRP/2FA; verify D1 contains encrypted session state only. Reload management page and query from another Worker instance without another password login.
3. Exercise saved-session validation and one token recovery; check revoked/expired sessions return actionable errors, without password retry or automatic terms acceptance.
4. Authorize all four PCS app names independently; deliberately leave one pending and confirm other ready services remain available.
5. DAV: discover calendars/address books; query test resources; create one with a stable UUID, retry the same UUID, then edit with a current ETag. Stale ETag must conflict. Confirm unknown properties/alarms survive edits. Do not exercise deletion via MCP (not exposed).
6. Reminders: inspect a test list, paginate completed/open items; create with a stable idempotencyKey, edit/complete/reopen with current tags. Verify replay and version conflicts against Apple's application.
7. Notes: enumerate folders through continuation; inspect recent-page title/snippet search and a Unicode body; locked/rich unsupported content must fail explicitly rather than claim complete rendering.
8. Photos: paginate personal metadata; compare one CPLAsset/CPLMaster pair to Apple UI; inspect thumbnail and one original download. Confirm HTTP stream and MCP resource-read limits, owner isolation, ticket expiry and disconnect revocation.
9. Drive: browse a small test folder, search within it and download one document. Confirm the request reaches DriveWS/DocWS, not CloudKit records.
10. Connect ChatGPT through Managed OAuth; discover tools and make one read per service. With write permissions off, all write tools must reject requests. Record each service/operation/time as passed or failed; a successful management “check” alone does not certify every operation.
11. On actual iPhone Safari, verify 320/390/430px reflow, zoom, tap labels/buttons, error/status visibility, password-manager behavior and numeric OTP entry. Finish one trusted-device login from that phone; test network/background interruption, recovery and the separate PCS buttons. DOM tests alone do not satisfy this step.

No real Apple account or production environment was available during initial development. The checklist remains pending and is not an assertion of success.
