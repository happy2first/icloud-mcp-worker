# Find My implementation and validation / 实现及验收

> Historical review/checklist. For current live evidence and limits, see [VALIDATION.md](VALIDATION.md). 本文件保留当时的审查/验收计划，当前状态以验证记录为准。

Reviewed 2026-10-13 against timlaing/pyicloud main commit `fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d`:

- [findmyiphone.py](https://github.com/timlaing/pyicloud/blob/fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d/pyicloud/services/findmyiphone.py), blob `15273aaca30c8cd2205190c98dcdae4294ef83f0`.
- [authentication.md](https://github.com/timlaing/pyicloud/blob/fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d/docs/guides/authentication.md), blob `7be857ffe068b914f0caf9fe8c0339b07eb42a0a`.
- [Find My fixtures](https://github.com/timlaing/pyicloud/blob/fb56ed6652f2d99ca8dc3cf515f7db0b319fcf1d/tests/const/const_findmyiphone.py), blob `1f816588bd795a84e024815a5d45ad437c42b694`.

Ports initClient/refreshClient/playSound requests, app/api/deviceList versions, fmly=true, serverContext handling (theftLoss=null), ID-based device merge, prsId-to-membersInfo ownership, features.LOC/SND capabilities, and bounded family LOADING/no-progress handling. Existing MIT attribution is retained in provenance/licenses/pyicloud-current-MIT.txt.

Worker adaptations: no Python/monitor thread; location refresh targets selectedDevice instead of all devices; no isUpdatingAllLocations for a single-device request. Family loading is at most five refreshes with 500 ms delays and stops on no progress. Locate is at most three refreshes under an 18-second local scheduling budget and the shared request/transport deadlines. Sound has no automatic replay. No new schema table, credential input or environment variable. Find My uses existing Access ownership, encrypted session and generation/version lease; skips PCS because FMIP is a separate service. Session discovery adds only the validated fmip root, and transport allowlists only three supported paths.

Tests cover own/family merging, ownership, stalled loading, old/new fixes, explicit permission denial, offline devices, unknown IDs, last-reported reads, confirmation/capability enforcement, uncertain sound outcomes, malformed envelopes, expired sessions, saved cookies, and host/path discovery. Local workerd verifies MCP discovery, rejection of missing confirmation before network access, and read operations using an encrypted stored session while Reminders PCS remains pending. Existing functionality is covered by the full npm run check suite.

Real validation limitation: this execution has neither a connected iCloud MCP tool nor authenticated production deployment access. No existing production Apple session was read or used; synthetic cookies/accounts are used in tests. Live family access, actual fresh fixes, Apple-specific 2FA challenges and actual sound playback remain unverified. Do not interpret test success as production acceptance.

部署后实际验收：先通过现有管理页面确认 Apple 连接，再调用 findmy_list_devices；检查本人/家庭成员及 familyComplete。使用列表 ID 调用 findmy_get_location，分别检查 refreshAccepted 和 newLocationObtained，并测试 offline/权限设置后的状态。播放声音必须先得到对指定设备的明确确认。不要把接口请求成功当作已取得新定位或设备已响铃。
