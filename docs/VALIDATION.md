# Validation evidence / 验证记录

Updated: 2026-10-14. This page describes current evidence; older review/fix documents record the state at the time they were written.

## Current evidence

| Layer                             | Evidence                                                                                                                                                                                                   | Limits                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| TypeScript / 类型                 | npm run typecheck passed                                                                                                                                                                                   | Static checks are not live protocol verification                                                                         |
| Tests / 模拟测试                  | 223 Node tests passed                                                                                                                                                                                      | Synthetic credentials and Apple responses only                                                                           |
| Build / 构建                      | Browser proof bundle and Worker ESM built                                                                                                                                                                  | No Python runtime or Node compatibility flag required                                                                    |
| Local Worker / 本地运行           | npm run test:worker passed with local D1, signed synthetic Access JWTs and simulated Apple requests                                                                                                        | Covers routing, permission gates, encrypted storage/downloads and representative service paths; not every live operation |
| Production integration / 实际部署 | Operator's mainland (GCBD) deployment established Apple sign-in and the MCP client connection                                                                                                              | Cloudflare account settings and production database have not been independently inspected                                |
| Service connectivity / 服务连接   | Operator reports all seven management connections and functions working                                                                                                                                    | A connection check proves its particular request, not all operations                                                     |
| Find My / 查找                    | Live own/family device enumeration and last reported locations were read through MCP                                                                                                                       | No actual sound test, friends, AirTags, lost mode or erase                                                               |
| Recurring completion / 循环完成   | One timed weekly reminder was completed; subsequent exact reads confirmed one completed history item and the original root still open one week later, with its recurrence and a replacement alarm retained | No personal IDs/content are published; other recurrence shapes were not exhaustively exercised                           |
| Mobile UI / 手机界面              | Operator supplied mobile screenshots/feedback; DOM interaction tests passed                                                                                                                                | No complete Safari/device, visual or accessibility matrix                                                                |

## Recurring completion reconciliation

The live action initially returned WRITE_OUTCOME_UNKNOWN. Exact subsequent reads confirmed the atomic write had succeeded. Apple regenerated creation/modification timestamps while linking alarms, so byte-for-byte metadata comparisons incorrectly rejected confirmation.

The verifier now accepts bounded Apple-managed timestamps while retaining exact completion/date/alarm/recurrence/content checks and version guards. Regression tests cover this behavior. No further completion was sent after confirming the original root had advanced. The final verifier change was tested locally; another real completion was not performed merely to retest it.

The adapter also preserves native lists without an explicit ReminderIDs ordering array instead of inventing/replacing list ordering. Atomic completion uses a bounded 20-second dispatch timeout within a 60-second completion budget and a matching session lease, with time reserved for confirmation. There is no automatic write replay.

## Unverified or unsupported cases

- International-region live behavior and broad account/Apple risk-control compatibility.
- Advanced Data Protection enabled.
- Every calendar/contact/reminder write shape, complex scheduling and every large-library pagination case.
- Physical sound playback, long-term session reliability, independent cryptographic/security review and load testing.

Permissions and version checks remain enabled. Private Apple protocols may change even after a successful test. Historical statements that live testing had not yet occurred in CODE-REVIEW.md, AUTH-AND-UI-REVIEW.md and fix notes should be read as dated records, not current global claims.

## Reproduce local checks

```bash
npm ci
npm run check
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

The CI workflow runs these checks without Apple credentials. For live deployment, validate each required operation on your own account and use dedicated test items for new writes. A saved credential, a healthy connection card and a successful specific operation are different evidence.
