# Authentication and management review / 认证与管理页复核

Review completed against current upstream source on 2026-10-13 (Asia/Shanghai). This is source/DOM/local-runtime evidence, not certification of Apple production compatibility.

## Latest references checked

| Source | Latest HEAD inspected | Relevant differences |
|---|---|---|
| Xzese Worker | `15f2d3a335f2fd8f30b47f836d2154ca5cc4f335` | Since the original `f4da3d8`, authentication/crypto/transport/socket core is unchanged. New commits mainly add jobs, list management and complex reminder lifecycle/scheduling. Relevant simple-write token advancement and native all-day guards were ported; broad new feature families were not transplanted. |
| timlaing/pyicloud | `fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d` (`2026.10.0` release) | Since original `d0a0d37`, base authentication and SRP algorithm are unchanged; base.py changes are Find My-related. New generic CloudKit record rejection handling and exception hierarchy were inspected. Worker already classifies per-record failures and uses a common typed AppError hierarchy; Drive protocol is unchanged. |

Both authorize/signin implementations use `authVersion=latest`; the Worker has a regression assertion for that parameter. Client build/mastering identifiers `2534Project66` / `2534B22` still match current Xzese. These are observed private-protocol identifiers, not evidence that Apple has promised long-term support or that a live server used the same protocol today. Latest source was read directly, including relevant tests; this was not a README-only version check.

## Authentication corrections

- Verified web credentials are now persisted after account login, **before any service PCS request**. Initial state explicitly reports data approval pending. A transient or unsupported Reminders PCS operation no longer prevents keeping successfully verified credentials for the other services.
- Each service keeps independent PCS checkpoints and is explicitly authorized in management. Optional unsupported Drive/DocWS roots are discarded only for those services; a valid shared CloudKit login survives. Mandatory CloudKit root remains strictly validated. No unsafe optional root is requested.
- SRP s2k/s2k_fo and modern trusted-device SPAKE2/WebSocket verification remain browser-proof based. Apple password, password-derived secret and user's input code are not persisted. SMS/phone/legacy/security-key login is still unsupported and fails explicitly.
- App-password input trims account whitespace and normalizes 16 lowercase letters with optional spaces/hyphens into Apple's grouped form before encryption. Saved state is separate from actual DAV authentication; the UI explicitly asks the user to check Calendar and Contacts after saving.
- Latest Xzese resolution-token updates preserve existing replica ID, increment safe counters and keep merge timestamps monotonic. Overflow fails before dispatch. Native all-day reminders without a stored TimeZone accept only explicit midnight-UTC date changes. Early-alert date changes remain blocked instead of silently changing a linked schedule.

## Management interaction findings and fixes

| Flow | Original gap | Current behavior |
|---|---|---|
| Load configuration | Inputs could submit before current version existed | Credential fields/actions disabled until status loads; a failed load leaves a refresh path |
| Credential entry | Generic JSON state and mixed-language login | Chinese steps, shared typography/colors/buttons, clear distinction between primary and app-specific passwords |
| Enable/write permission | Rapid independent checkbox changes could restore stale state | One operation at a time; stop/disable clears write permission; backend rejects disabled+writable |
| PCS | Waiting state and per-service timing were unclear | Four independent card buttons, persisted retry/exhaustion countdown, no automatic Apple polling |
| Live check | Success result replaced entire raw status | Local check result is labeled as one read at a time, separate from stored state and full acceptance |
| Errors | Failure and Access HTML login responses were not recoverable | Actionable error codes, read-state retry, password cleared after submission, mutation not automatically replayed |
| Disconnect/remove | Effects on the other credential class were unclear | Confirmation explains affected services and that Apple contents are not deleted; version-checked local credential removal |
| Device code | Entire verification form appeared during proof computation | Code input appears only when the challenge arrives; disabled while verifying; completion returns to service PCS setup |
| Mobile structure | Wide table, small controls and inconsistent spacing | Single-column service cards, wrapping/stacked action rows below 480px, 16px base text, 48px buttons/fields/toggle rows, numeric OTP keyboard and matching styles |

Tests exercise the actual rendered document and client logic in a DOM implementation, including load locks, duplicate requests, credential normalization/clearing, permission rollback, Access-session errors, PCS wait state, disconnect cancellation, code-phase transitions and status recovery. A DOM implementation does not render CSS or emulate WebKit.

**Visual/mobile limit:** Cloud Browser could not reach the isolated local preview; its security policy disallows file:// pages. No workaround was used. Therefore no browser screenshots, CSS layout rendering, VoiceOver certification, actual iPhone Safari keychain/OTP behavior or real-device background WebSocket test is claimed. The Product Design capture portion remained blocked. The deployed site still needs 320/390/430px checks, text zoom, focus/keyboard, overflow, notifications and foreground/background behavior on a real phone.

## Delete exposure

All **six**, not just five, service families were checked. Tools/list contains no delete/auth/PCS tool. Attempts to call calendar_delete, contacts_delete, delete_reminder, notes_delete, photos_delete and drive_delete are rejected in the built Worker before any Apple request.

Calendar/CardDAV's internal version-checked delete method and Reminders internal deletion code remain. Notes/Photos/Drive remain read-only and have no new delete implementation. The hidden ReminderMutation server schema is not an MCP exposure; /api/mutations is not routed.

## Validation and remaining gates

- 118 synthetic Node tests, TypeScript, build and local workerd integration pass (including pending Reminders PCS with independently available shared credentials).
- Wrangler dry-run checks the Worker bundle, not Cloudflare production behavior.
- No database schema migration is needed for this update.
- Production authorization is still unavailable (`wrangler whoami`: not authenticated), D1 ID is a placeholder, and no Apple credentials were supplied. Real authentication, all six actual reads/writes, ChatGPT Managed OAuth and phone browser verification remain pending.

The detailed operator/user procedure is [USER-GUIDE.md](USER-GUIDE.md). Do not promise one-attempt success from private protocol code and synthetic tests alone.
