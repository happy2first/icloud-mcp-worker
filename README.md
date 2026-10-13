# iCloud MCP Worker

[English](README.en.md)

一个 Cloudflare Worker、TypeScript、D1、Cloudflare Access + Managed OAuth。让 MCP 客户端访问 Apple 日历、通讯录、提醒事项、备忘录、照片、iCloud 云盘及 Apple 查找；不依赖 Mac、VPS、R2 或浏览器扩展。

**这是基于 Apple 非官方网页协议的初始实现，尚未用真实 Apple 账户或 Cloudflare 生产环境验收。不要将自动化测试通过理解成六项服务已经在线可用。**

## 实现范围

| 服务 | 代码能力 | 首期边界 |
|---|---|---|
| 日历 | CalDAV 集合发现、查询、读取、新增、修改；内部删除方法 | UTC 定时日程；修改拒绝重复、邀请日程和多 VEVENT 资源；保留未知字段及 VALARM |
| 通讯录 | CardDAV 集合发现、查询、读取、新增、修改；内部删除方法 | 姓名、邮箱、电话；修改仅替换指定属性，其余保留；指定 EMAIL/TEL 会替换该属性全部值 |
| 提醒事项 | 列表、分页查询、单项查询、创建、修改、完成、重新打开；内部软删除 | 复用 Xzese 的 CloudKit/CRDT、版本标签和确定性创建 ID；共享列表、复杂重复/子任务写入不支持 |
| 备忘录 | 文件夹分页、最近列表、标题/摘要搜索、正文 Protobuf 解码 | 只读；搜索范围为当前页标题/摘要，须继续分页；不支持全文搜索、锁定笔记和附件/复杂表格渲染 |
| 照片 | 个人图库相册分页、照片索引查询、元数据、缩略图、指定照片下载 | 只读；CPLAsset/CPLMaster 配对；共享图库及旧共享相册不支持；不做全量同步 |
| 查找 | 本人及家庭共享设备列表、按需定位、明确确认后播放声音 | 复用 Apple Web 会话；不支持朋友位置、AirTag、丢失模式或抹除 |
| 云盘 | DriveWS 目录浏览/目录内搜索、DocWS 下载 | 只读；不支持递归搜索、共享所有者命名空间、上传或备份 |

**MCP 不注册任何删除、凭证录入、登录或 PCS 授权工具。** 六项服务默认关闭；写入权限默认关闭，需在 `/admin` 分别开启。

## 认证及管理

手机优先的中文管理流程及凭证获取、导入、逐项验收步骤见 [部署后使用指南](docs/USER-GUIDE.md)；最新上游比对、认证修正和界面测试范围见 [认证与管理页复核](docs/AUTH-AND-UI-REVIEW.md)。响应式结构已实现，DOM交互测试通过；尚未完成 iPhone Safari 实机及浏览器截图验收。

- `/admin` 为统一管理页；`/connect/apple` 为该管理流程的独立凭证页面。
- Apple 主密码只在管理页浏览器中用于 SRP 计算，Worker 接收证明而非主密码。现代可信设备 2FA/SPAKE2 验证后，将 Cookie、会话 Token 加密存入 D1。SMS、电话、旧六位验证码协议及硬件安全密钥不支持；缺少兼容挑战时明确返回 `UNSUPPORTED_AUTH`，不会降级。
- 日历、通讯录使用管理页录入的 Apple **App 专用密码**，同样加密保存；不将其放在普通环境变量。
- 默认启用 Apple 登录和会话复用，执行有界的 `/validate`、必要时一次 `/accountLogin` Token 恢复。新会话本地永久保留，直到主动断开或确认 Apple 撤销；Apple 仍可能要求重新登录。不会用主密码后台登录。
- PCS 授权分别记录 `reminders`、`notes3`、`photos`、`iclouddrive`，通过管理按钮申请/继续检查。每次最多两个请求，不在 Worker 内等待轮询。
- 设备验证后先保存网页会话，再逐项申请 PCS；不以提醒事项 PCS 成功作为保存账户登录的前提。管理页显示等待倒计时，操作中防止重复提交，停用服务同时关闭写权限。
- AES-256-GCM 使用随机 IV、owner/account/generation/record 绑定的 AAD。单一密钥只配置到 Workers Secrets。D1 版本与租约保护网页会话并发更新；DAV 用 ETag/If-Match，创建用稳定 UUID 和 If-None-Match。
- 服务主机及路径分别白名单验证。资源下载不附带 Apple Cookie/Authorization，Apple 签名 URL 留在加密 D1 中，不在 MCP 结果公开。

## 部署

首次经过 Access 验证的 API 请求会自动初始化空 D1 的五张表，使用构建时嵌入的同一份 schema.sql。重复初始化保留已有凭证和会话；不自动改写不兼容的旧表。管理状态错误会区分数据库不可用与结构不兼容，不再误报 Apple 连接失败。

需要自行提供 Cloudflare 账户授权和专用域名；本项目尚未验证生产部署。使用 Cloudflare Workers Builds 从 GitHub 部署时，阅读 [云端构建部署步骤](docs/USER-GUIDE.md#11-cloudflare-workers-builds从-github-部署)，部署命令设为 `npm run deploy:cloud`。Wrangler 按名称复用或创建 D1，随后初始化表结构。仓库已移除无效的全零数据库 ID。本地下述配置不会上传到云端构建环境。

```bash
npm ci
npm run check
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

在 **本地被忽略的** `wrangler.local.toml` 中填写返回的 `database_id`，添加同一域名的自定义路由，并设置以下 `[vars]`：

| 配置 | 内容 |
|---|---|
| `TEAM_DOMAIN` | 完整 `https://your-team.cloudflareaccess.com` |
| `POLICY_AUD` | 保护整个 Worker 域名的 Access 应用 Audience |

普通变量只需 TEAM_DOMAIN、POLICY_AUD，可直接在 Cloudflare Dashboard 配置；`keep_vars=true` 保留它们。密钥另存为 Secret `ENCRYPTION_KEYS_JSON`，值直接填写 **32 字节随机密钥的标准 Base64 字符串**，不加 JSON、引号或版本号。变量名为兼容已有部署保留。旧 JSON 格式仍能读取；改为纯 Base64 时只提取原来的密钥值，不要换一把密钥，否则已有密文不能解密。登录/恢复默认开启，可分别用 APPLE_LOGIN_ENABLED=false / APPLE_SESSION_RENEWAL_ENABLED=false 暂停；不再使用保留期变量。

密钥在本机生成，通过 Dashboard Secrets 或以下交互命令录入，**不要在聊天发送**：

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
# 直接粘贴上一步输出的 Base64 字符串，不加 JSON 或引号
npx wrangler d1 execute DB --remote --config wrangler.local.toml --file schema.sql
npx wrangler deploy --config wrangler.local.toml
```

为自定义域名创建 Cloudflare Access 应用，保护**整个 hostname**，仅允许你的身份。在该应用 Advanced settings 开启 **Managed OAuth**，不要另建 Worker OAuth 服务器。本 Worker 验证 `Cf-Access-Jwt-Assertion` 的签名、issuer、audience、sub 和有效期，并移除伪造身份头。参考 [Cloudflare 官方说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。

无需配置域名或 owner 身份变量。Worker 使用实际 HTTPS 请求域名进行同源校验；用签名验证后的 Access JWT sub 隔离 D1 凭证、会话、服务权限及下载票据。Access 策略负责只允许本人进入；允许另一身份时，其数据独立，不会获得你的会话。旧 APP_ORIGIN / REMINDERS_OWNER_ID 若还保留，会作为额外限制；要使用自动识别可删除它们。

`workers_dev=false`、`preview_urls=false`；部署自定义域名并保护整个 hostname。旧版 1/30 天会话仍可读取，但重新登录一次才采用永久策略；不要改数据库密文伪造认证证据。Apple 会话有效期、PCS 检查窗口、登录交互及临时下载票据期限不受永久保留策略影响。

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

当前验收结果见 [验收记录](docs/VALIDATION.md)。真实 Apple 和生产 Cloudflare 验收尚未通过。对中国区 `.icloud.com.cn` 服务、地域/风控差异、Apple 私有协议变化及真实设备 2FA/WebSocket 兼容性，当前均没有实测证据。网页登录现支持国际区和云上贵州区域选择；大陆区使用 `.icloud.com.cn` 端点并在会话中保存区域。已有无区域字段的会话按国际区恢复，需重新登录并选择大陆区。DAV 日历和通讯录的大陆区兼容性仍需单独验证。


## Apple 查找（Find My）

新增工具使用当前 Access 用户已保存的 **Apple Web 会话**，无需新增环境变量、数据库或管理页面，不依赖提醒事项 PCS 授权。六项原有服务的开关不影响 Find My；Find My 随 Apple 登录启用，`APPLE_LOGIN_ENABLED=false` 可暂停。`icloud_status.findmy` 报告本地会话是否可用，不代表已验证 Apple 接口。旧会话尚未保存 `fmip` 服务地址时，首次调用尝试一次现有会话验证；若 Apple 未返回支持的地址则明确报错，不猜测地址。

| 工具 | 用法 |
|---|---|
| `findmy_list_devices` | 无参数；列出本人及可访问家庭设备，返回名称、类型、所属成员、在线状态、电量及家庭加载情况 |
| `findmy_get_location` | `{ "deviceId": "列表返回的ID", "refresh": true }`；默认按需请求定位，`false` 仅读取最后报告位置 |
| `findmy_play_sound` | 用户明确确认对**指定设备**响铃后，传 `{ "deviceId": "设备ID", "confirmed": true }`；不得自动重试 |

家庭成员必须已加入同一家庭共享，并在 Apple「查找」及家庭共享设置中允许当前账户访问相应设备/位置。家庭共享不保证每台设备可定位；关闭定位、设备离线和 Apple 服务限制都可能影响结果。`fmly=true` 始终启用；`membersInfo.deviceFetchStatus` 为 `LOADING` 时进行有限刷新，连续无进展即停止。结果按设备 ID 合并，`familyComplete=false` 表示家庭设备尚未完整加载或状态未知，请稍后重查。不会把 `LOADING` 单独判定为无权限。

定位返回坐标、精度（米）、毫秒时间戳、ISO 时间、`isOld` 和位置年龄；未知值为 `null`。`refreshAccepted=true` 仅表示刷新请求被接受；只有定位时间晚于基线且不早于本次请求、同时 Apple 标记 `isOld=false`，才返回 `newLocationObtained=true`。`LOCATION_TIMEOUT` 表示本次有限等待未取得可证实的新定位，可能仍返回历史位置；`DEVICE_OFFLINE`、`NO_LOCATION_PERMISSION`、`LOCATION_UNAVAILABLE` 分别说明离线、明确禁止定位及无法取得位置。`refresh=false` 不发送 `shouldLocate`。

播放声音返回请求接受状态，不声称实际声音已播放；离线时可能延后。网络异常返回 `WRITE_OUTCOME_UNKNOWN`，应检查设备并重新取得用户确认，不自动重发。会话过期沿用既有受控续期和重新登录机制，可能返回 `REAUTH_REQUIRED`、`VERIFICATION_REQUIRED`；没有降级到不可信会话或绕过 2FA。缺少服务、权限拒绝、协议变化和限流均返回明确错误。

暂不支持朋友位置、AirTag、丢失模式或抹除。请求内处理 serverContext，不保存位置，不常驻轮询。Apple 非公开协议可能变化。

**验收：新增模拟测试、现有回归测试及本地 workerd 的 Access → MCP → 加密会话 → 模拟 Apple HTTP 链路已通过；尚未用真实 Apple 账户验证，也未触发真实设备响铃。** 上游依据和详细记录见 [Find My 验证记录](docs/FINDMY-VALIDATION.md)。部署后先调用设备列表，再用返回 ID 查询位置；响铃须另行明确确认。
