# 部署后使用指南（手机优先）

本指南对应当前源码。Apple 使用的是非官方网页协议，首次真实账号验收、Cloudflare 生产验收及 iPhone Safari 实机测试仍需完成。不能以“保存凭证”或“PCS 已就绪”替代实际读写验证。

## 1. 先完成部署配置

安装 Node.js 24 或更新版本，获取仓库源码，在仓库目录执行：

```bash
npm ci
npm run check
npx wrangler login
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

`wrangler.local.toml` 已被忽略，不应提交 operator ID 或秘密。把创建 D1 后返回的 database_id 写入本地配置，保留绑定名 DB，并配置自己的自定义域名，例如：

```toml
routes = [{ pattern = "icloud.mcp.example.com", custom_domain = true }]
```

将该行放在文件顶层（在 `[build]` 之前）。示例域名没有被本项目创建。使用自己的 Cloudflare 域名。只需在 Dashboard“变量和机密”添加以下两个普通变量，或者写入配置文件的 `[vars]`；仓库启用 `keep_vars=true`，部署会保留 Dashboard 普通变量：

| 配置 | 内容 |
|---|---|
| TEAM_DOMAIN | 完整 Access 团队地址，例如 `https://your-team.cloudflareaccess.com` |
| POLICY_AUD | 保护整个管理/MCP域名的 Access 应用 AUD |

Apple 登录和会话恢复默认开启，新网页会话永久保留，无本地 30 天限制。上述四项 Apple/密钥编号变量无需填写；ENCRYPTION_KEY_ID 和保留期变量已不使用。可选地设置 APPLE_LOGIN_ENABLED=false / APPLE_SESSION_RENEWAL_ENABLED=false 暂停对应功能。

用本机生成 32 字节随机 AES 密钥，将输出的 Base64 字符串直接放入 **Workers Secret** `ENCRYPTION_KEYS_JSON`，不加 JSON、引号或版本号。名称保留只是为了兼容已有部署：

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
# 在交互输入中直接粘贴刚生成的 Base64 字符串
npx wrangler d1 execute DB --remote --file schema.sql --config wrangler.local.toml
npx wrangler deploy --config wrangler.local.toml
```

密钥不是 Apple 密码。不要把 Apple 主密码、专用密码、Cookie 或 Token 写到 Wrangler 配置，也不要在聊天中发送。

在 Cloudflare Zero Trust 中为整个自定义域名建立 Access 应用，只允许本人登录，记录其 AUD。为 MCP 客户端开启应用高级设置中的 **Managed OAuth**，参考 [Cloudflare 官方配置文档](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。本项目不另建 OAuth 服务。保持 workers.dev 和 preview URL 关闭。若使用已有 Access 应用，核对域名、AUD和策略，不复制不相关应用的 AUD。

不需要 APP_ORIGIN 或 REMINDERS_OWNER_ID，也不需要先获取 sub 再部署。Worker 从实际 HTTPS 请求取得域名并检查同源；签名验证后的 Access JWT sub 自动隔离每个身份的凭证、会话、服务设置和下载。Access 策略仍应只允许本人，不能设成 Bypass；允许另一身份时，它只能管理自己的独立数据。旧两个变量如果还存在，会作为额外限制；不需要时删除即可。不要用 Service Token 代替本人登录。

### 1.1 Cloudflare Workers Builds：从 GitHub 部署

云端构建只取得 Git 仓库中的文件，不能读取你电脑上被忽略的 `wrangler.local.toml`。此前全零 `database_id` 导致部署报错 10181；默认配置现已移除占位 ID。当前锁定的 Wrangler 4.147.0 支持按 `database_name` 查找已有数据库，若不存在则自动创建，并在后续部署复用。参考 [Cloudflare 自动资源配置说明](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)。此行为已核对 Wrangler 实际源码，尚未在你的生产账户中验证。

1. 在 Cloudflare Worker 的构建设置中选择 GitHub `main` 分支、仓库根目录；构建命令设为 `npm run build`，推荐部署命令 **`npm run deploy:cloud`**，显式执行远程 schema。Worker 现在也会在首次经过 Access 验证的 API 请求中安全初始化缺失的表；直接使用 `npx wrangler deploy` 时也不必另做首次建表。两种方式都使用同一个 schema.sql，不清空已有数据。
2. 构建 API Token 必须具有对应账户的 Workers Scripts 编辑权限、D1 读取/编辑权限；自定义域名还需要对应域名/路由的部署权限。如自动配置报权限错误，在 Cloudflare 构建的 API Token 设置中补齐，或先手动创建 D1、把真实 ID 填入仓库配置。数据库 ID 不是密码，但不要虚构它。
3. 若已有数据库名就是 `icloud-mcp-worker`，保持现有名称，Wrangler 会复用；若名称不同，先把 `database_name` 和真实 `database_id` 改成同一个现有数据库的信息。不要另建数据库代替已有存储，也不要删除已有数据库。没有任何数据库时才允许首次自动创建。
4. 在 Worker 的域名设置中添加自己的自定义域名，或在仓库 `wrangler.toml` 顶层添加 custom_domain 路由。在 Dashboard 添加 TEAM_DOMAIN、POLICY_AUD 即可；不要只修改本地忽略文件，也不要在 Git 配置里重复写同名旧值覆盖 Dashboard 设置。
5. 在 Worker 的“变量和机密”中把 `ENCRYPTION_KEYS_JSON` 添加为 **Secret**，值直接填写上节生成的 Base64 字符串，不加 JSON 或引号。这是运行时机密，不应添加到 Git 文件或构建日志。旧 JSON 格式仍可使用；如改为纯 Base64，只提取同一密钥值，不能重新生成替换，否则已有加密凭证无法解密。
6. 点击部署最新提交。日志须同时显示 Worker 部署成功和远程 schema 执行成功。SQL 仅使用 `CREATE TABLE IF NOT EXISTS`，重复执行不会清空已有数据；它是当前初始结构，未来结构变更仍需独立迁移。

首次访问管理页时，状态接口只读取 D1，不联系 Apple。缺失表由 Worker 自动创建；已有但不兼容的列结构返回 STORAGE_SCHEMA_MISMATCH，需检查所绑定的数据库并执行明确迁移，不能删库重建。D1 暂时不可用返回 STORAGE_UNAVAILABLE，不能解释为 Apple 断连。也可以手动执行 `npx wrangler d1 execute DB --remote --file schema.sql --yes` 初始化空库。D1 就绪不证明 Apple 凭证有效，仍需继续完成下面的真实服务检查。

## 2. 确认 Apple 账户准备完成

在 iPhone 确认两步验证已启用，且设备登录了同一 Apple 账户并能收到可信设备验证提示。日历、通讯录、提醒事项、备忘录、照片、云盘中想读取的数据必须已同步到 iCloud；“我的 iPhone”、Gmail或其他账号中的本地数据不会自动变成 iCloud 数据。

高级数据保护按当前需求保持关闭，无需为本项目修改已有安全保护。网页服务还需允许 iCloud 网页数据访问。Apple 官方说明的设置入口是：新系统“设置 → 你的姓名 → iCloud → iCloud.com → 允许数据访问”；较早系统在 iCloud 设置中直接显示“在网页上访问 iCloud 数据”。以设备实际标签为准，参考 [Apple 网页访问说明](https://support.apple.com/en-us/102630)。此项目的目录内文件筛选不是 Apple 新增的设备端全局搜索。

首次建议在 [iCloud.com](https://www.icloud.com/) 确认相关数据可见，处理 Apple 要求的账户解锁或条款更新。该步骤不向 Worker 导入凭证，也不需要抓取浏览器 Token。当前仅支持 `.icloud.com` 服务地址；`.icloud.com.cn` 尚未支持，不可视为同一已验证区域。

## 3. 两类凭证的区别

| 凭证 | 在哪里提供 | 用途 | 如何保存 |
|---|---|---|---|
| Apple 账户主密码 + 本次可信设备验证码 | 管理页的“登录 Apple 账户”页面 | 建立四项网页服务共用的会话 | 主密码和输入验证码不持久化；会话 Cookie/Token AES-256-GCM 加密存 D1 |
| Apple App 专用密码 | 管理页“日历 / 通讯录凭证” | CalDAV / CardDAV | AES-256-GCM 加密存 D1 |

网页登录是你部署的非官方页面，会在本机处理密码并将证明发给 Worker，因此需要信任这份源码及自己的部署。不要在网页登录页面使用 App 专用密码，也不要把主密码填到专用密码框。

## 4. 登录并保存 Apple 网页会话

1. 用手机浏览器打开自己的 `/admin`，完成 Cloudflare Access 登录。等待页面读取配置，按钮恢复可操作。
2. 点“登录 Apple 账户”。输入 Apple 账户和**主密码**，阅读并勾选浏览器信任、加密会话保留两项同意，点“登录并验证设备”。已有会话时，重新登录会替换旧会话和各服务的 PCS 状态。
3. 保持页面打开。在可信设备上允许**这一次**登录。待页面显示六位码输入框后，填写本次提示的验证码，点“验证设备”。不能用普通短信、电话或硬件安全密钥流程替代本次现代设备挑战。
4. 看到“网页会话已加密保存”后，点“返回管理页申请服务授权”。此时账户认证完成，服务 PCS 尚未完成是正常状态。不要为了某项 PCS 失败反复重新输入主密码。

一次交互最多三分钟。手机切换应用、网络变化或浏览器进入后台可能中断 WebSocket，当前未做 iPhone 实机认证；出现连接失效时返回管理页先确认会话是否已保存，再决定重新登录。页面不会接收聊天中的密码或验证码，也没有浏览器扩展导入路径。

如果出现 APPLE_REDIRECT_ERROR，详情只显示阶段、HTTP 状态和次数：browser-trust 是设备验证后的浏览器信任，device-verification 是设备验证，account-login 是账户会话建立。no Location 表示 Apple 返回跳转状态但缺少地址，loop 表示请求未发生会话进展而循环，limit exceeded 表示超过有界跳转预算。三者都不表示登录成功，也不能仅凭输入验证码判断 Apple 已接受。部署最新代码后重新发起一次登录；若仍失败，保留此安全错误详情，不发送 URL 查询参数、Cookie、Token 或验证码，不连续重试。

新网页会话在本地永久保留，直到主动断开或确认 Apple 拒绝该账户会话；不再设置人为到期时间。Apple 自身的 Cookie/Token 有效期及 PCS 授权仍由 Apple 决定，永久保存不代表永久可用。旧版本保存的 1/30 天会话可以继续解密，重新登录一次才采用永久策略，不改写旧认证证据。状态读取失败时点“重新检查登录状态”；若 Access 已过期，重新打开管理页完成 Access 登录。登录交互、PCS 检查、分页游标及临时下载链接仍有自己的短期时限。

## 5. 分别申请 PCS 并开启四项网页服务

在提醒事项、备忘录、照片、iCloud 云盘的服务卡片中逐项操作：

1. 打开“启用服务”，保持写权限关闭。
2. 点“申请 / 检查 PCS”。对应 appName 分别是 reminders、notes3、photos、iclouddrive。
3. 如果提示等待设备批准，先在可信设备允许网页数据访问；等待按钮倒计时结束后，再点相同按钮。一次只操作一项，避免竞争同一个会话。
4. PCS 已就绪后点“检查服务”。按钮实际请求该服务的一个有界只读接口；成功只证明此次只读检查，不代表全部工具都已验收。
5. 一项未就绪不需要重新登录或清掉其他授权。已耗尽一次 PCS 检查预算时等待本轮期限结束，再开始新的尝试。不要无限轮询。

高级数据保护已关闭时，Apple 可能立即返回就绪，不一定每项都弹提示。网页会话的共享状态可能仍显示“提醒事项等待授权”，但其他已完成 PCS 的服务可以独立使用，以各卡片状态和真实调用为准。

## 6. 获取并导入 App 专用密码

1. 在手机浏览器进入 [account.apple.com](https://account.apple.com/)，按 Apple 官方流程登录同一账户。
2. 进入“登录与安全 → App 专用密码”，点生成专用密码。可命名为 `icloud-mcp-worker DAV`，后续方便识别和撤销。按 Apple 页面要求完成账户验证。
3. 把 Apple 生成的专用密码复制到管理页“日历 / 通讯录凭证”。同时输入 Apple 账户邮箱。只支持邮箱形式的 DAV 账户输入；手机号形式尚未做兼容。
4. 点“加密保存”。支持粘贴带连字符、空格或连续16位小写字母的格式；输入框会清空。看到保存成功仅证明加密存储成功，还需下一步验证凭证。
5. 分别启用日历、通讯录，保持写权限关闭，并分别点“检查服务”。两项均能发现 DAV 集合后，再在 ChatGPT 中读取一条测试数据。

Apple 要求生成 App 专用密码的账户已启用两步验证；更改或重置主密码会自动撤销已有专用密码。这时需在 Apple 网站重新生成，再在管理页替换。参考 [Apple 专用密码说明](https://support.apple.com/en-us/102654)。此处“移除本地专用密码”只删除 D1 中的凭证，不删除联系人/日程，也不会撤销 Apple 网站上的密码。

## 7. 连接 ChatGPT并逐项验收

从管理页复制 MCP 地址 `https://你的域名/mcp`。按复核时的 [OpenAI 官方说明](https://developers.openai.com/api/docs/guides/custom-mcp-server)，首次添加可在 ChatGPT 网页的 Plugins 页面操作：点加号 → Add custom MCP server → 填写名称、HTTPS Server URL → 选择 OAuth → 阅读风险提示并 Create as a plugin → 安装。账户或工作区权限会影响入口是否可用；手机App没有该入口时先使用网页完成添加。

OAuth登录应跳转到你的 Cloudflare Access，通过本人身份认证。该登录是 MCP访问授权，不是 Apple 登录。不要在 OAuth client ID/secret字段填 Apple 主密码、App 专用密码或 Worker加密密钥。Cloudflare Managed OAuth处理发现和客户端注册；若客户端提供注册方式选择，应与服务端元数据支持一致（DCR为动态客户端注册；本项目没有自建静态OAuth客户端密钥）。如果返回 redirect URI不被允许，在 Access的 Managed OAuth设置中核对并允许实际客户端要求的准确 HTTPS回调地址，不要猜地址或用全站通配符放宽策略。该端到端流程仍需真实验收。

安装后在对话中选择对应插件（可用客户端可通过 `@` 选择），明确要求它调用本项目工具。更新服务器工具后在插件详情页刷新工具列表。

先让 ChatGPT 调用 `icloud_status`，然后按以下顺序检查：

| 服务 | 首次只读检查 | 进一步验收 |
|---|---|---|
| 日历 | calendar_collections → calendar_query | 测试日历中开启写权限后新增、按 ETag修改 |
| 通讯录 | contacts_collections → contacts_query | 测试联系人新增、按 ETag修改 |
| 提醒事项 | get_reminder_lists → get_reminders | 测试提醒创建、修改、完成、重新打开 |
| 备忘录 | notes_folders → notes_list → notes_get | Unicode 正文、分页；搜索仅标题/摘要，不含全文 |
| 照片 | photos_albums / photos_query → photos_thumbnail | 指定照片原图下载；仅个人图库 |
| 云盘 | drive_browse → drive_download | 测试目录的小文件下载；不是全盘递归搜索 |

创建时必须保留同一个 idempotencyKey；修改前读取当前 ETag或 recordChangeTag。WRITE_OUTCOME_UNKNOWN意味着可能已写成功，要先核对目标，不能自动换新 ID或强制覆盖。只读检查全部通过后，才为日历、通讯录、提醒事项中的所需服务开启“允许新增与修改”。

日历/通讯录的 changes 只填用户明确要求修改的字段。改日历标题无需重复发送起止时间；更改时间时则必须同时给出 start/end（UTC）。改联系人邮箱无需重复发送姓名，原结构化姓名会保留。若提供EMAIL或TEL，则替换该属性的全部值；多个号码/地址中的精细选择仍需先确认，不能把它当作任意一项值的局部替换。

## 8. 删除能力与文件读取

**六项服务均没有公开删除工具。** 日历/通讯录的内部 DAV delete方法、提醒事项内部删除实现保留；备忘录/照片/云盘维持只读，未新增删除实现。管理页的断开会话/移除凭证不是 Apple 内容删除。

MCP照片缩略图以图片内容返回。下载工具返回短期 Access受保护链接与 icloud-file资源，不返回 Apple 签名URL。MCP资源读上限5MiB；更大文件在已登录Access的浏览器下载，HTTP最多100MiB/60秒。链接最多5分钟，服务停用或会话切换后旧引用不能继续读取。

## 9. 出错时怎么处理

| 现象/代码 | 操作 |
|---|---|
| 页面回到Access登录/SESSION_EXPIRED | 重新打开管理页完成Access登录，再刷新状态 |
| NOT_CONNECTED | 配置对应的网页会话或App专用密码 |
| REAUTH_REQUIRED | 网页服务重新登录；DAV重新生成并替换专用密码 |
| DEVICE_APPROVAL_PENDING | 在对应卡片申请/检查PCS，在可信设备允许后等待倒计时 |
| RATE_LIMITED | 等待返回的重试时间；不要连续操作 |
| UNSUPPORTED_AUTH | 账户可能被锁定或Apple只提供当前未支持的挑战；先通过官方界面处理。不要关闭账户保护来绕过 |
| PROTOCOL_CHANGED | 记录工具名、错误代码和时间，不复制Cookie/Token；比对项目更新并重新做受控验证 |
| UNSUPPORTED_FEATURE | 可能为区域/大小/共享库/复杂字段超出首期范围；用Apple应用处理 |
| CONFLICT | 重新读取版本、配置或准确ID，不强制覆盖 |
| WRITE_OUTCOME_UNKNOWN | 核对实际Apple内容，再决定是否用相同ID重试 |

最终验收应记录每项具体操作、时间与结果。初次登录成功、某项检查成功、模拟测试通过是不同层级的证据；完整清单见 [PROTOCOL-AND-ACCEPTANCE.md](PROTOCOL-AND-ACCEPTANCE.md)。
