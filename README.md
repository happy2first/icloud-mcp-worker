# iCloud MCP Worker

[English](README.en.md) · [部署与使用](docs/USER-GUIDE.md) · [安全说明](SECURITY.md)

在自己的 Cloudflare Workers 上运行 iCloud MCP 服务，让支持远程 MCP 的 AI Agent 访问日历、通讯录、提醒事项、备忘录、照片、iCloud 云盘和「查找」。管理页负责保存凭证、检查连接和控制写权限，MCP 地址按实际部署域名生成。

**TypeScript + Workers + D1 + Cloudflare Access Managed OAuth。** 无需 Mac、VPS、R2 或浏览器扩展。

> 非 Apple 官方项目，使用非公开网页协议及 CalDAV/CardDAV。支持选择中国大陆（云上贵州）或国际区。大陆区真实账户已完成部署、登录及服务联调；这不代表所有账户、地区和边界场景均兼容，也不是独立安全审计。

## 功能

| 服务        | 支持能力                                                           | 主要边界                                                 |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------- |
| 日历        | 集合发现、查询、读取、新增、修改                                   | UTC 定时事件；不修改循环、邀请或多事件资源               |
| 通讯录      | 集合发现、查询、读取、新增、修改                                   | 姓名、邮箱、电话；指定 EMAIL/TEL 会替换该属性的全部值    |
| 提醒事项    | 列表、分页读取、单项读取、全部未完成项、创建、修改、完成、重新打开 | 当前版本校验；复杂循环、子任务及共享列表发现不支持       |
| 备忘录      | 文件夹、列表、标题/摘要搜索、正文读取                              | 只读；无全文搜索、锁定笔记或完整附件/复杂表格渲染        |
| 照片        | 个人相册、照片查询、元数据、缩略图、指定照片下载                   | 只读；不支持共享图库、旧共享相册、人物识别查询或全量同步 |
| iCloud 云盘 | 目录浏览、目录内筛选、资源读取、文件下载                           | 只读；无递归搜索、上传、备份或共享所有者命名空间         |
| 查找        | 本人及可访问家庭设备列表、最后报告位置、按需刷新位置、播放声音     | 响铃需明确确认；无朋友位置、AirTag、丢失模式或抹除       |

MCP 不公开删除、登录、凭证录入或服务授权工具。日历、通讯录、提醒事项的写权限单独开启；六项数据服务首次默认停用。查找使用已保存的 Apple 网页会话，无独立 App 专用密码。

**循环提醒只完成当前这次。** 支持间隔为 1 的简单定时日/周循环，需只有一对日期闹钟，且没有结束日期、复杂模式、子任务、附件、标签或分配信息。一次原子操作生成本次完成记录，并让原循环任务保持未完成，推进一期日期和闹钟；不跳过多个逾期周期。返回的 record 为本次完成记录，`nextOccurrence` 为继续开放的原循环任务。其他形态明确拒绝，不把整个循环标为完成。

## 两类凭证

| 凭证               | 用途                               | 提供方式                                 |
| ------------------ | ---------------------------------- | ---------------------------------------- |
| Apple 网页会话     | 提醒事项、备忘录、照片、云盘、查找 | 管理页登录 Apple，按要求完成可信设备验证 |
| Apple App 专用密码 | 日历、通讯录                       | 在 Apple 账户页生成，再到管理页录入      |

主密码只在管理页浏览器中参与 SRP 计算，Worker 接收证明；不保存主密码，也不使用它后台登录。网页 Cookie/Token 和 App 专用密码分别经 AES-256-GCM 加密存入 D1，并绑定已验证的 Access 用户身份。

保存成功说明凭证已存储，不代表每项服务已连接。点对应服务的「检查连接」，**只有 Apple 要求时**才继续设备批准/数据访问验证（PCS）。查找同样按 Apple 的要求验证，App 专用密码不能替代查找网页登录。刷新页面只读取已保存的凭证与服务状态，不重新请求 Apple。

新网页会话默认无本地保留期限，可主动断开；Apple 仍可能撤销或要求重新登录。实测账户关闭高级数据保护，开启后的兼容性尚未验证。短信、电话及硬件安全密钥登录流程不支持。

## 部署

需要 Node.js 24+、Cloudflare Workers/D1 权限和自己的 Cloudflare 域名。保护整个自定义域名的 Access 应用应只允许你的身份，并启用 [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。

### 本地部署

```bash
git clone https://github.com/happy2first/icloud-mcp-worker.git
cd icloud-mcp-worker
npm ci
npm run check
npx wrangler login
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

在已忽略的 `wrangler.local.toml` 中填写 D1 的真实 `database_id`，保留绑定名 DB。在文件顶层添加自己的路由，放在各 [section] 之前：

```toml
routes = [{ pattern = "icloud.example.com", custom_domain = true }]
```

配置两项普通变量和一项 Secret：

| 名称                   | 类型          | 内容                                                              |
| ---------------------- | ------------- | ----------------------------------------------------------------- |
| `TEAM_DOMAIN`          | 普通变量      | 完整 Access 团队地址，例如 https://your-team.cloudflareaccess.com |
| `POLICY_AUD`           | 普通变量      | 保护该域名的 Access 应用 AUD                                      |
| `ENCRYPTION_KEYS_JSON` | Worker Secret | 32 字节随机密钥的标准 Base64 字符串；直接填值，不加 JSON/引号     |

普通变量可在 Dashboard 设置，或写入本地配置的 [vars]。`keep_vars=true` 保留 Dashboard 普通变量。加密 Secret 的名称为兼容旧部署保留，旧 JSON 密钥格式仍可读取。

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
# 在交互提示中录入上一步生成的密钥
npx wrangler d1 execute DB --remote --file schema.sql --config wrangler.local.toml
npx wrangler deploy --config wrangler.local.toml
```

以上为首次部署流程。已有部署应复用原数据库和加密密钥，不能重新生成密钥来做普通更新，否则已有凭证无法解密。不要将 Apple 密码、Cookie 或 Token 写入 Wrangler 配置。

### GitHub → Cloudflare Workers Builds

关联仓库，构建命令为 npm run build，部署命令为 npm run deploy:cloud。在 Cloudflare 配置同样的两项变量、Secret 和自定义域名；构建环境读不到本机的 `wrangler.local.toml`。默认配置按数据库名称复用/创建 D1，部署脚本应用初始 schema；已有数据库名称不同时显式配置正确绑定，避免误建新库。

仓库配置关闭 `workers.dev` 和预览地址，应使用受 Access 保护的自定义域名。Apple 登录和会话恢复默认开启，确需暂停时分别设 `APPLE_LOGIN_ENABLED`=false、`APPLE_SESSION_RENEWAL_ENABLED`=false。无需填写部署域名或用户身份变量，它们来自实际请求及验证后的 Access JWT。

## 连接任意 MCP 客户端

1. 打开部署域名的 /admin，通过 Access 登录。
2. 保存需要的网页会话和/或 App 专用密码，选择正确 Apple 区域。
3. 启用服务，逐项检查连接，按 Apple 实际要求完成验证。
4. 从管理页复制 MCP 地址，添加到支持远程 MCP 和 OAuth 的客户端。示例为 https://icloud.example.com/mcp，以管理页生成值为准。
5. 先调用 `icloud_status`，再执行只读工具；需要写入时单独开启相应权限。

不限于 ChatGPT。OAuth 登录授权的是你的 MCP 服务，Apple 凭证在管理流程中单独录入。服务端工具变化后，客户端可能需要刷新工具列表。

| 服务          | 常用只读工具                                                                         |
| ------------- | ------------------------------------------------------------------------------------ |
| 日历 / 通讯录 | `calendar_collections` / `contacts_collections`，随后查询/读取                       |
| 提醒事项      | `get_reminder_lists`、`get_reminders`、`get_reminder`、`get_all_open_reminders`      |
| 备忘录        | `notes_folders`、`notes_list`、`notes_search`、`notes_get`                           |
| 照片          | `photos_albums`、`photos_query`、`photos_get`、`photos_thumbnail`、`photos_download` |
| 云盘          | `drive_browse`、`drive_download`                                                     |
| 查找          | `findmy_list_devices`、`findmy_get_location`                                         |

查找返回家庭共享设备，不是朋友共享位置。`refresh=false` 读取最后报告位置；刷新请求被接受不代表取得新位置，检查 `newLocationObtained`、定位时间和 `isOld`。用户确认指定设备后，才调用 `findmy_play_sound` 并传 `confirmed=true`；接受状态不保证设备已经实际响铃。

缩略图返回 MCP 图片内容，是否内联显示由客户端决定。下载返回受 Access 保护的临时链接和 icloud-file:// 资源，不公开 Apple 签名 URL。资源读取最多 5 MiB，HTTP 下载最多 100 MiB/60 秒；票据最多 5 分钟，服务停用或会话切换后旧票据失效。

## 错误与安全写入

错误包含 code、message、`retryable`、`requestId`。管理页支持复制操作结果、错误详情和技术状态。

| 代码                                                | 处理                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `NOT_CONNECTED` / `REAUTH_REQUIRED`                 | 查看凭证类型和服务详情；网页服务重新验证，DAV 替换专用密码                        |
| `DEVICE_APPROVAL_PENDING` / `VERIFICATION_REQUIRED` | 按提示在可信设备批准或重新验证，不连续重试                                        |
| `CONFLICT`                                          | 先读取当前版本和状态，避免强制覆盖                                                |
| `UPSTREAM_UNAVAILABLE` / `RATE_LIMITED`             | 查看详情，等待网络恢复或指定重试时间                                              |
| `UNSUPPORTED_FEATURE` / `PROTOCOL_CHANGED`          | 检查支持范围或项目更新，不绕过校验                                                |
| `WRITE_OUTCOME_UNKNOWN`                             | Apple 可能已保存；先核对原任务和详情中的完成记录 ID，不自动重放或换 ID/新版本再写 |

创建保留同一个 `idempotencyKey`；修改/完成使用刚读取的 `recordChangeTag`，DAV 使用 ETag。循环完成后原 ID 指向下一期，不能拿新版本号再次完成来重试上一期。权限、响应大小、分页、版本和请求时间均有界，不声称能完整扫描任意大集合。

## 开发与验证

```bash
npm ci
npm run check
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

check 包含类型检查、Node 测试、打包及本地 workerd 验证。测试只使用合成数据，不需要 Apple 凭证。2026-10-14 共 223 项 Node 测试通过；真实大陆区服务连接及多项只读操作已联调，简单周循环的「仅完成本次」已核对。真实响铃、所有写入形态、所有地区和长期稳定性未全面验收。详见 [当前验证记录](docs/VALIDATION.md)。

提交问题时附工具名、脱敏参数、错误代码、请求编号和时间，不上传密码、Cookie、Token、个人截图或未经处理的日志。参见 [安全说明](SECURITY.md) 和 [开源前检查](docs/OPEN-SOURCE-REVIEW.md)。

## 来源与许可

采用 [MIT License](LICENSE)。认证、密码学、会话、CloudKit/CRDT 和提醒事项实现基于 [Xzese 的 Worker](https://github.com/Xzese/icloud-mcp-for-cloudflare-workers)；Notes、Photos、Drive 和 Find My 协议参考 [timlaing/pyicloud](https://github.com/timlaing/pyicloud)。保留上游许可和归属，详见 [provenance/NOTICE.md](provenance/NOTICE.md) 与 [研究记录](docs/RESEARCH.md)。部署中不运行 Python。
