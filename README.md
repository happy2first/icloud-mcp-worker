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

## 五步部署到 Cloudflare（推荐：无需命令行）

**Fork 仓库 → Cloudflare 连接 GitHub 自动部署 → 绑定域名 → Access / OAuth + 运行时变量 → 管理页登录 Apple。**

[**查看带配置表、示意图和排错步骤的图解部署教程 →**](docs/USER-GUIDE.md)

![管理页配置示意](docs/images/admin-overview.svg)

前提：GitHub、Cloudflare Workers/D1 账号，以及一个已接入 Cloudflare 的域名。使用图形化部署，**不必安装 Mac、Node.js、Wrangler 或 VPS**。

1. **Fork：** 打开 [本仓库](https://github.com/happy2first/icloud-mcp-worker)，点击右上角 **Fork**，保留仓库名 `icloud-mcp-worker`。
2. **导入：** Cloudflare → **Workers & Pages → Create application → Import a repository**，连接 GitHub 并选择刚才的 Fork。Worker 名称与 `wrangler.toml` 一致：`icloud-mcp-worker`，分支 `main`。构建命令填 `npm run build`，部署命令填 `npm run deploy:cloud`，然后 **Save and Deploy**。部署脚本按仓库配置创建/复用 D1（绑定名 `DB`）并应用 `schema.sql`。如果 D1 创建失败，参见 [部署指南的排错说明](docs/USER-GUIDE.md#第-2-步在-cloudflare-导入-github-仓库)。
3. **域名：** Worker → **Settings → Domains & Routes → Add → Custom Domain**，例如 `icloud.example.com`。使用此完整域名，而不是 `workers.dev`。
4. **Access / OAuth：** Zero Trust → **Access controls → Applications**，新建保护**整个子域名**的 Self-hosted 应用，Allow 策略只允许自己的邮箱。到 **Advanced settings** 打开 **Managed OAuth**，在 **Allowed redirect URIs** 中添加：

   ```text
   https://chatgpt.com/connector/oauth/*
   ```

   这是 ChatGPT 的 OAuth **回调允许列表**，不是 Worker URL。Cloudflare 支持 `/*` 子路径通配符；不要使用更宽泛的通配符。复制该 Access 应用的 **Application Audience (AUD) Tag**。
5. **变量与管理页：** Worker → **Settings → Variables and Secrets**，添加下表后访问 `https://icloud.example.com/admin`，通过 Access 登录并配置 Apple 凭证：

   | 名称 | 类型 | 值 |
   | --- | --- | --- |
   | `TEAM_DOMAIN` | Text（普通变量） | Zero Trust 团队地址，如 `https://your-team.cloudflareaccess.com` |
   | `POLICY_AUD` | Text（普通变量） | 第 4 步 Access 应用的 AUD Tag |
   | `ENCRYPTION_KEYS_JSON` | **Secret** | 32 字节随机密钥的**标准 Base64**（例如在可信本机执行 `openssl rand -base64 32`），直接填写值，不要加 JSON 或引号 |

   配置的是 Worker **运行时**变量，不是 Build variables。首次使用请妥善备份密钥；以后更新**保留原 D1 和同一密钥**，不要重置。

管理页中，**Apple 网页登录**负责提醒事项、备忘录、照片、云盘、查找；**App 专用密码**负责日历、通讯录。按需保存凭证、启用服务、逐项点击「检查连接」，只有 Apple 要求时才做额外可信设备/PCS 验证。最后复制顶部生成的 `https://icloud.example.com/mcp`，在 ChatGPT 或其他远程 MCP 客户端连接并测试 `icloud_status`。

![Access Managed OAuth 设置示意](docs/images/access-oauth-setup.svg)

示意图根据设置项绘制，**并非真实控制台截图**。详细的每个按钮、两种 Apple 凭证、Find My 验证和故障处理，都在 [零命令行图解教程](docs/USER-GUIDE.md)。命令行部署是可选高级方式，也在该指南末尾提供。

**安全提示：** 此项目使用 Apple 非官方协议，**只允许可信的 Access 身份**，不可公开暴露管理和 MCP 路由；Apple 主密码、Cookie、Token 和 App 专用密码只通过自己部署的管理页录入，绝不写在 GitHub 仓库或 Worker 变量中。

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

check 包含类型检查、Node 测试、打包及本地 workerd 验证。测试只使用合成数据，不需要 Apple 凭证。2026-10-14 共 225 项 Node 测试通过；真实大陆区服务连接及多项只读操作已联调，简单周循环的「仅完成本次」已核对。真实响铃、所有写入形态、所有地区和长期稳定性未全面验收。详见 [当前验证记录](docs/VALIDATION.md)。

提交问题时附工具名、脱敏参数、错误代码、请求编号和时间，不上传密码、Cookie、Token、个人截图或未经处理的日志。参见 [安全说明](SECURITY.md) 和 [开源前检查](docs/OPEN-SOURCE-REVIEW.md)。

## 来源与许可

采用 [MIT License](LICENSE)。认证、密码学、会话、CloudKit/CRDT 和提醒事项实现基于 [Xzese 的 Worker](https://github.com/Xzese/icloud-mcp-for-cloudflare-workers)；Notes、Photos、Drive 和 Find My 协议参考 [timlaing/pyicloud](https://github.com/timlaing/pyicloud)。保留上游许可和归属，详见 [provenance/NOTICE.md](provenance/NOTICE.md) 与 [研究记录](docs/RESEARCH.md)。部署中不运行 Python。
