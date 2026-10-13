# 通讯录 HTTP 530 路由恢复（2026-10-13）

日历服务检查已由用户确认成功。通讯录仍返回 HTTP 530；现有日志仅有方法和状态码，不能确认失败的主机或阶段。Cloudflare 官方将 530 描述为上游域名解析问题，进一步判定需要响应中的 1xxx 错误。此实现不读取或公开上游响应体，不把 530 当作密码错误。

来源：<https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-530/>；CardDAV 中国区固定入口的维护者说明：<https://github.com/bitfireAT/davx5-ose/discussions/225>。

## 调整

- 分区 `pNNN-contacts.icloud.com[.cn]` 返回 530 时，PROPFIND / REPORT / GET 最多经同地区固定 `contacts.icloud.com[.cn]` 入口请求一次，保留完整原始资源路径、方法、请求体和 Depth。不会猜测分区、改变地区、转发给非白名单主机或重试写入。
- 入口再次重定向到已失败地址时停止，不循环。仍使用原请求的 10 秒预算和原有最多四次请求预算；服务发现全部阶段共用 40 秒预算。
- 错误包含白名单主机、发现阶段、HTTP 状态；入口区域回退失败时保留第一次失败信息，防止后一个错误掩盖真实原因。不会显示账号、资源路径、密码或响应体。
- 阶段标注保留原错误对象，包括限流等待秒数。

模拟回归覆盖国际/中国区分区 530 后入口成功、路径和请求保留、重定向循环停止、写入不重试、两入口错误同时呈现及限流元数据保留。真实 Cloudflare DNS 与 Apple 账户仍须部署后验收；入口路由不保证能恢复每个分区故障。

此次不改数据库、凭证或服务开关。若仍失败，管理页详情会指出 `principal-entry`、`regional-principal-entry`、`home-set` 或 `collections` 及具体主机。
