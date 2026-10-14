# Security / 安全说明

This is a self-hosted, unofficial Apple integration. Upstream cryptographic code and automated tests are not an independent security audit. Follow [README.md](README.md) / [README.en.md](README.en.md) for deployment and documented limits.

## Protect your deployment

- Protect the entire custom hostname with Cloudflare Access, including management, MCP and download routes. Use narrow identity policies and exact OAuth callback URLs.
- Keep Apple passwords, cookies, tokens and the encryption key out of Git, public issues and logs. Enter Apple credentials only through your own trusted management deployment.
- Store ENCRYPTION_KEYS_JSON as a Worker Secret. Existing encrypted D1 data requires the original key; ordinary deployment must not regenerate it.
- Retain owner/session/version checks. Enable only necessary service write permissions. Sound playback requires explicit confirmation for the specified device.
- If a write returns WRITE_OUTCOME_UNKNOWN, read and reconcile first. The original recurring ID may now represent the next occurrence; do not complete it again as a retry.

## Report a vulnerability

Do not disclose a working exploit with credentials or personal data in a public issue. Use GitHub private vulnerability reporting if it is enabled for this repository, or arrange a private channel with the maintainer before sharing sensitive material. No project-specific reporting email is currently published.

For ordinary bugs, share the tool name, redacted parameters, error code, request ID, time and relevant version. Remove Apple account addresses, personal item/device IDs, locations, signed URLs, cookies, authorization headers, verification codes and secret values from attachments. Review copied technical status before posting it publicly.

If a real secret has been committed, removing it from the latest revision is insufficient: revoke/rotate it first and assess reachable history, releases, artifacts and copies. History rewriting needs a separate coordinated decision. A source-only review does not inspect deployed D1, Worker Secrets or Cloudflare/GitHub logs.

## 中文说明

本项目使用非官方 Apple 协议，尚无独立安全审计。整个部署域名应受 Access 保护，写权限按需开启。Apple 凭证只在自己的管理页面录入，加密密钥放在 Worker Secret；普通更新保留原数据库和密钥。

安全漏洞优先使用仓库已启用的 GitHub 私密漏洞报告，或先与维护者建立私密沟通渠道，不在公开 Issue 中披露凭证或带个人资料的复现材料。普通问题可提供工具名、脱敏参数、错误码、请求编号、时间及版本，分享前检查技术状态和日志附件。

真实密钥若曾提交，应先撤销/轮换，再评估历史及副本；删除最新文件不能消除历史泄露。本次代码检查不等于检查生产数据库、Secrets 或各平台日志。
