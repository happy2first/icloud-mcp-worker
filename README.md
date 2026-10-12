# iCloud MCP Worker

[English](README.en.md)

一个 Cloudflare Worker、TypeScript、D1、Cloudflare Access + Managed OAuth。让 MCP 客户端访问 Apple 日历、通讯录、提醒事项、备忘录、照片及 iCloud 云盘；不依赖 Mac、VPS、R2 或浏览器扩展。

**这是基于 Apple 非官方网页协议的初始实现，尚未用真实 Apple 账户或 Cloudflare 生产环境验收。不要将自动化测试通过理解成六项服务已经在线可用。**

## 实现范围

| 服务 | 代码能力 | 首期边界 |
|---|---|---|
| 日历 | CalDAV 集合发现、查询、读取、新增、修改；内部删除方法 | UTC 定时日程；修改拒绝重复、邀请日程和多 VEVENT 资源；保留未知字段及 VALARM |
| 通讯录 | CardDAV 集合发现、查询、读取、新增、修改；内部删除方法 | 姓名、邮箱、电话；修改仅替换指定属性，其余保留；指定 EMAIL/TEL 会替换该属性全部值 |
| 提醒事项 | 列表、分页查询、单项查询、创建、修改、完成、重新打开；内部软删除 | 复用 Xzese 的 CloudKit/CRDT、版本标签和确定性创建 ID；共享列表、复杂重复/子任务写入不支持 |
| 备忘录 | 文件夹分页、最近列表、标题/摘要搜索、正文 Protobuf 解码 | 只读；搜索范围为当前页标题/摘要，须继续分页；不支持全文搜索、锁定笔记和附件/复杂表格渲染 |
| 照片 | 个人图库相册分页、照片索引查询、元数据、缩略图、指定照片下载 | 只读；CPLAsset/CPLMaster 配对；共享图库及旧共享相册不支持；不做全量同步 |
| 云盘 | DriveWS 目录浏览/目录内搜索、DocWS 下载 | 只读；不支持递归搜索、共享所有者命名空间、上传或备份 |

**MCP 不注册任何删除、凭证录入、登录或 PCS 授权工具。** 六项服务默认关闭；写入权限默认关闭，需在 `/admin` 分别开启。

## 认证及管理

- `/admin` 为统一管理页；`/connect/apple` 为该管理流程的独立凭证页面。
- Apple 主密码只在管理页浏览器中用于 SRP 计算，Worker 接收证明而非主密码。现代可信设备 2FA/SPAKE2 验证后，将 Cookie、会话 Token 加密存入 D1。SMS、电话、旧六位验证码协议及硬件安全密钥不支持；缺少兼容挑战时明确返回 `UNSUPPORTED_AUTH`，不会降级。
- 日历、通讯录使用管理页录入的 Apple **App 专用密码**，同样加密保存；不将其放在普通环境变量。
- 会话复用并执行有界的 `/validate`、必要时一次 `/accountLogin` Token 恢复。固定本地保留期为 30 天；Apple 可更早撤销会话。重连前不会用主密码后台登录。
- PCS 授权分别记录 `reminders`、`notes3`、`photos`、`iclouddrive`，通过管理按钮申请/继续检查。每次最多两个请求，不在 Worker 内等待轮询。
- AES-256-GCM 使用随机 IV、owner/account/generation/record 绑定的 AAD。密钥环只配置到 Workers Secrets。D1 版本与租约保护网页会话并发更新；DAV 用 ETag/If-Match，创建用稳定 UUID 和 If-None-Match。
- 服务主机及路径分别白名单验证。资源下载不附带 Apple Cookie/Authorization，Apple 签名 URL 留在加密 D1 中，不在 MCP 结果公开。

## 部署

需要自行提供 Cloudflare 账户授权和专用域名。仓库的 D1 ID 是占位符，当前没有生产资源。

```bash
npm ci
npm run check
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

在 **本地被忽略的** `wrangler.local.toml` 中填写返回的 `database_id`，添加同一域名的自定义路由，并设置以下 `[vars]`：

| 配置 | 内容 |
|---|---|
| `APP_ORIGIN` | 例如 `https://icloud.mcp.example.com`，无尾斜杠 |
| `TEAM_DOMAIN` | 完整 `https://your-team.cloudflareaccess.com` |
| `POLICY_AUD` | 保护整个 Worker 域名的 Access 应用 Audience |
| `REMINDERS_OWNER_ID` | 允许的 Access JWT `sub`；沿用上游变量名，但绑定整个 iCloud MCP |
| `APPLE_LOGIN_ENABLED` | `true` 开启管理页登录；`false` 禁止发起新的登录 |
| `APPLE_SESSION_RENEWAL_ENABLED` | `saved-tokens-v1` |
| `APPLE_SESSION_RETENTION_WRITES` | `absolute-30d-v1` |
| `ENCRYPTION_KEY_ID` | `v1`，应与密钥环匹配 |

密钥在本机生成，通过 Dashboard Secrets 或以下交互命令录入，**不要在聊天发送**：

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
# 输入 {"v1":"本机生成的32字节base64密钥"}
npx wrangler d1 execute DB --remote --config wrangler.local.toml --file schema.sql
npx wrangler deploy --config wrangler.local.toml
```

为自定义域名创建 Cloudflare Access 应用，保护**整个 hostname**，仅允许你的身份。在该应用 Advanced settings 开启 **Managed OAuth**，不要另建 Worker OAuth 服务器。本 Worker 验证 `Cf-Access-Jwt-Assertion` 的签名、issuer、audience、sub 和有效期，并移除伪造身份头。参考 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。

首次获取 `sub`：暂不填写 `REMINDERS_OWNER_ID`，通过 Access 登录后访问 `/api/bootstrap/identity`，读取 `authenticatedUserId`，配置该值并再次部署。未配置 owner 时其他页面及 MCP 均拒绝访问，不自动认领。

`workers_dev=false`、`preview_urls=false`；不要以开发域名绕过 Access。密钥轮换时保留旧 key ID 的 Secret，直到旧会话/专用密码重存；删除旧密钥会使对应密文不可恢复。

## 连接 ChatGPT 与联调

1. 访问部署域名 `/admin`，通过 Access 登录。
2. 登录 Apple 账户，在自己的可信设备完成验证。申请各项 PCS 授权；如处于等待状态，按提示时间再点击检查。
3. 录入日历/通讯录 App 专用密码，开启需要的服务。先保留写入关闭。
4. 每项点击“检查”；成功只证明该次只读请求成功，不证明该服务所有功能通过。
5. 在支持远程 MCP 的 ChatGPT 连接器设置中填写 `https://你的域名/mcp`，走 Cloudflare Managed OAuth 登录。
6. 调用 `icloud_status`，再逐项查询；需要写入时在管理页开启相应权限，用专门测试日历/联系人/提醒事项验证新增及修改。

遇到 `WRITE_OUTCOME_UNKNOWN`，先读取确定性创建 ID/当前版本，避免盲目重试。详细工具与错误见 [协议与验收](docs/PROTOCOL-AND-ACCEPTANCE.md)。

## 分页、限流和下载

CloudKit 读操作返回 continuation 或 nextOffset，显式标记 complete；照片 offset 是实时索引，期间图库变更可能导致重复/跳项。DAV 及云盘在有界响应内分页，不声称能枚举超大集合。DAV 最大 2 MiB、一般 Apple JSON 最大 1 MiB、Notes 解压最大 256 KiB；超出返回明确错误，不悄悄截断。

每 owner 每分钟最多 60 次 MCP/管理操作。Apple HTTP 请求通常 8–10 秒超时，单次通用服务尝试最多 25 秒，包含会话恢复的总网络预算为 40 秒。下载凭证最多 5 分钟且不超过会话有效期，绑定 owner、来源服务与 Apple 会话代次；每次读取重新检查服务权限与会话。HTTP 流式下载最多 100 MiB/60 秒；MCP `resources/read` 最多 5 MiB、缩略图最多 1 MiB（返回 MCP 图片内容）。HTTP 下载需要 Access，MCP 客户端可使用返回的 `icloud-file://` 资源；大文件请在已登录的管理域名下载。停用服务阻止后续下载，断开或重新登录使旧凭证失效；已开始的传输不保证即时中止。

2026-10-12 复审修复及测试范围见 [代码审查记录](docs/CODE-REVIEW.md)。这是源码和模拟环境验证，不代表真实 Apple 或 Cloudflare 生产认证。

## 来源、测试和当前验收

直接复用了 Xzese 的认证、密码学、Cookie、会话/D1、Access、CloudKit、提醒事项及测试代码，保留 MIT 许可；移植 pyicloud 的 Notes/Photos/Drive 协议。源码阅读记录和固定版本见 [研究记录](docs/RESEARCH.md)。

```bash
npm run typecheck
npm test
npm run build
npm run test:worker
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

当前验收结果见 [验收记录](docs/VALIDATION.md)。真实 Apple 和生产 Cloudflare 验收尚未通过。对中国区 `.icloud.com.cn` 服务、地域/风控差异、Apple 私有协议变化及真实设备 2FA/WebSocket 兼容性，当前均没有实测证据。现有白名单只支持 `.icloud.com`，发现其他地域服务会明确拒绝，不应直接扩大到任意域名。
