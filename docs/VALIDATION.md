# Validation evidence / 验收记录

Initial development date: 2026-10-12.

| Layer | Status | Evidence / limits |
|---|---|---|
| Source implementation / 代码实现 | Implemented within documented scope | Pure Worker entry, static management flow, D1 schema, six service adapters, MCP tools/resources; deletes internal only |
| TypeScript check / 类型检查 | Passed | `npm run typecheck`; fresh checkout resolves generated browser bundle declaration |
| Synthetic unit/protocol tests / 模拟测试 | Passed | 123 Node tests: SRP/SPAKE2 transcripts, auth phases, Cookie scope, AES-GCM/AAD, D1 fences/renewal, reminder writes, DAV/XML/conditional partial updates, Notes compression/Protobuf, photo pairing, Drive paths, PCS app names/allowlists and management/login DOM interaction; includes automatic origin/verified identity, single encryption Secret compatibility and unlimited session retention |
| Bundle / 构建 | Passed | esbuild browser proof bundle and plain Worker ESM; no Node compatibility flags, Next.js, React, R2 or server runtime dependency |
| Local Worker compatibility / 本地 Worker | Passed | Built artifact in Miniflare/workerd; real local D1; synthetic signed Access JWT/JWKS; owner isolation, CSRF, management/client routes, six service gates, MCP tool discovery, permission-gated conditional DAV write, encrypted download tickets/resources/streams and disconnect revocation |
| Wrangler upload validation / 上传预检 | Passed | `wrangler deploy --dry-run`; named D1 binding without placeholder ID; does not verify remote provisioning |
| Live Apple authentication/services / 真实 Apple | **Not run** | No Apple credentials/account operation available; all network protocol tests use synthetic responses |
| Cloudflare production / Cloudflare 生产 | **Not verified** | Operator supplied a failed deployment log (10181) on 2026-10-13; placeholder removed and deploy:cloud added. No successful remote D1/provisioning/Apple evidence available to the agent |
| ChatGPT Managed OAuth end-to-end / ChatGPT 联调 | **Not run** | Requires deployed Access application with Managed OAuth |
| Mobile layout and real iPhone / 手机端 | **Not visually verified** | Mobile-first CSS and DOM logic implemented/tested; Cloud Browser could not reach local preview and disallows file URLs. No screenshot, CSS renderer or iPhone Safari evidence |

Compatibility date is pinned to `2026-07-30`, supported by the installed workerd binary. An initial October date failed local startup because that binary supported only dates through August; config and local tests now use the same supported date. Actual production still requires the live checklist in PROTOCOL-AND-ACCEPTANCE.md.

A local workerd test caught an unbound `fetch` receiver in the new DAV client, which Node mocks did not detect. Corrected using the global receiver and verified in workerd. No real credentials were used or logged.

Test adaptations retain applicable upstream assertions. Upstream-only CLI test was removed because that CLI is not shipped. Login/renewal now default on with optional explicit false switches; new sessions have no local expiry. Legacy bounded assurance schemas remain readable and require one new sign-in to adopt permanent retention. All fixtures remain synthetic. This evidence distinguishes implemented/tested code from real Apple and production behavior.
