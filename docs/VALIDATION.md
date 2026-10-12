# Validation evidence / 验收记录

Initial development date: 2026-10-12.

| Layer | Status | Evidence / limits |
|---|---|---|
| Source implementation / 代码实现 | Implemented within documented scope | Pure Worker entry, static management flow, D1 schema, six service adapters, MCP tools/resources; deletes internal only |
| TypeScript check / 类型检查 | Passed | `npm run typecheck`; fresh checkout resolves generated browser bundle declaration |
| Synthetic unit/protocol tests / 模拟测试 | Passed | 96 Node tests: SRP/SPAKE2 transcripts, auth phases, Cookie scope, AES-GCM/AAD, D1 fences/renewal, reminder writes, DAV/XML/conditional requests, Notes compression/Protobuf, photo pairing, Drive paths, PCS app names and allowlists |
| Bundle / 构建 | Passed | esbuild browser proof bundle and plain Worker ESM; no Node compatibility flags, Next.js, React, R2 or server runtime dependency |
| Local Worker compatibility / 本地 Worker | Passed | Built artifact in Miniflare/workerd; real local D1; synthetic signed Access JWT/JWKS; owner isolation, CSRF, management/client routes, six service gates, MCP tool discovery, permission-gated conditional DAV write, encrypted download tickets/resources/streams and disconnect revocation |
| Wrangler upload validation / 上传预检 | Passed | `wrangler deploy --dry-run`; placeholder D1 binding and no deployment |
| Live Apple authentication/services / 真实 Apple | **Not run** | No Apple credentials/account operation available; all network protocol tests use synthetic responses |
| Cloudflare production / Cloudflare 生产 | **Not deployed** | `wrangler whoami`: not authenticated; no Cloudflare API Token/account configured; D1 ID remains placeholder |
| ChatGPT Managed OAuth end-to-end / ChatGPT 联调 | **Not run** | Requires deployed Access application with Managed OAuth |

Compatibility date is pinned to `2026-07-30`, supported by the installed workerd binary. An initial October date failed local startup because that binary supported only dates through August; config and local tests now use the same supported date. Actual production still requires the live checklist in PROTOCOL-AND-ACCEPTANCE.md.

A local workerd test caught an unbound `fetch` receiver in the new DAV client, which Node mocks did not detect. Corrected using the global receiver and verified in workerd. No real credentials were used or logged.

Test adaptations retain applicable upstream assertions. Upstream-only CLI test was removed because that CLI is not shipped; rollout tests now use the explicit login opt-in. Upstream fixtures remain synthetic. This evidence distinguishes implemented/tested code from real Apple and production behavior.
