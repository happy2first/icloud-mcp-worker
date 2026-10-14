# 部署与使用指南

本指南面向自行部署者。项目是非官方 Apple 集成；当前大陆区部署与服务已联调，具体证据和未覆盖范围见 [VALIDATION.md](VALIDATION.md)。英文部署说明见 [README.en.md](../README.en.md)。

## 1. 部署准备

需要 Node.js 24+、Cloudflare Workers/D1 权限、Cloudflare 自定义域名，以及允许登录的个人身份。

```bash
npm ci
npm run check
npx wrangler login
npx wrangler d1 create icloud-mcp-worker
cp wrangler.toml wrangler.local.toml
```

以上创建数据库步骤仅用于首次部署。已有部署保留原数据库，不删库重建。将返回的 database_id 填入已忽略的 wrangler.local.toml，绑定名保持 DB；在文件顶层配置自己的 custom_domain 路由。

在 Cloudflare Access 为整个域名建立应用，仅允许本人或明确授权的身份。记录该应用 AUD，开启 [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)。不要留下绕过 Access 的公开管理/MCP入口。

| 配置                 | 类型     | 值                                               |
| -------------------- | -------- | ------------------------------------------------ |
| TEAM_DOMAIN          | 普通变量 | 完整 https://your-team.cloudflareaccess.com 地址 |
| POLICY_AUD           | 普通变量 | 保护该域名的 Access 应用 AUD                     |
| ENCRYPTION_KEYS_JSON | Secret   | 32 字节随机密钥的标准 Base64，不加 JSON/引号     |

普通变量放 Dashboard 或本地 [vars]；仓库 keep_vars=true 保留 Dashboard 变量。密钥名称为兼容旧版本保留，不是要求 JSON。旧格式仍兼容，更新时不要更换密钥。

```bash
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEYS_JSON --config wrangler.local.toml
npx wrangler d1 execute DB --remote --file schema.sql --config wrangler.local.toml
npx wrangler deploy --config wrangler.local.toml
```

只在首次部署生成新密钥。已有密文必须沿用原密钥，Apple 密码不属于环境变量。

### 1.1 Cloudflare Workers Builds：从 GitHub 部署

关联仓库，构建命令用 npm run build，部署命令用 npm run deploy:cloud。云端配置同样的变量、Secret和自定义域名，本地被忽略的配置不会上传。

Wrangler 按 database_name 复用或创建 D1，部署脚本应用初始 schema；若已有数据库名称不同，显式绑定正确的 database_id。不要使用占位 UUID。首次 Access 验证后的 API 请求也会初始化缺失的表，不会删除已有数据或擅自迁移不兼容结构。

workers.dev 和预览地址默认关闭。Apple 登录及会话恢复默认开启，需要暂停才设 APPLE_LOGIN_ENABLED=false / APPLE_SESSION_RENEWAL_ENABLED=false。服务开关和写权限保存在 D1；普通更新保留数据库、密钥、Access配置和 Dashboard变量。

## 2. 两类凭证

| 凭证               | 用途                               | 流程                                |
| ------------------ | ---------------------------------- | ----------------------------------- |
| Apple 网页会话     | 提醒事项、备忘录、照片、云盘、查找 | 管理页 Apple 登录及按需可信设备验证 |
| Apple App 专用密码 | 日历、通讯录                       | Apple 账户页生成，管理页加密保存    |

管理页浏览器用主密码计算 SRP 证明，Worker 不接收或保存主密码。会话 Cookie/Token 与 App 专用密码加密存入 D1，按验证后的 Access 身份隔离。部署页面属于你自己的非官方应用，需要信任其源码和部署。

网页版数据访问应在 Apple 设置中允许。本项目真实测试使用高级数据保护关闭场景，开启后未验证。中国大陆（云上贵州）账户选择大陆区，国际账户选择国际区；该区域随会话保存，DAV集合通过发现获取。

## 3. 登录和检查服务

1. 打开自己的 /admin，通过 Access 登录。
2. 在「凭证管理」登录 Apple，选择对应区域。已有凭证默认收起，需更新时展开流程。
3. 按 Apple 要求在可信设备批准，填写页面上的六位验证码。完成后返回管理页，查看网页凭证是否已保存。
4. 在需要的服务卡片启用服务，先保持写权限关闭，点「检查连接」。
5. 只有 Apple 要求时才继续设备批准/数据访问验证。按提示等待后检查，不连续提交，不因某项失败清掉其他凭证。
6. 查找若要求额外验证，使用其卡片上的验证入口；若已连接，不需再验证。App 专用密码无法替代查找网页会话。
7. 从 [Apple 账户页](https://account.apple.com/) 生成 App 专用密码，为日历/通讯录凭证填写账号及密码并保存，再分别检查连接。

主密码与 App 专用密码不能互换。[Apple 专用密码说明](https://support.apple.com/en-us/102654)介绍其生成及撤销方式。移除本地凭证只删除本项目保存的信息，不删除 Apple 内容，也不撤销 Apple 网站上的密码。

新网页会话无本地保留期限，直到主动断开或 Apple 撤销；这不代表永久可用。刷新页面读取保存状态和上次服务检查结果，不向 Apple 重新验证。连接正常附有检查时间，只代表该次请求成功。

## 4. 连接 MCP 客户端

从首屏复制按实际部署域名生成的 MCP 地址，添加到支持远程 MCP与 OAuth的客户端，不限于 ChatGPT。OAuth授权进入你的 MCP服务，Apple凭证仍只在管理页录入。根据 Access Managed OAuth配置允许客户端实际要求的准确回调地址，不使用宽泛通配符放松保护。

先调用 icloud_status，再读取各服务。提醒事项可先用 get_reminder_lists 获取真实列表ID，再用 get_reminders 或 get_all_open_reminders。管理页的凭证已保存不代表所有工具都已通过验证；逐项检查所需操作。

服务端更新工具后，客户端可能需要刷新工具列表。完整能力和工具入口见 [README.md](../README.md#功能)。

## 5. 写入、循环提醒和查找

只有明确需要写入时，才开启相应服务的「允许新增与修改」。创建复用同一个 idempotencyKey；修改使用当前 recordChangeTag或 ETag，变更对象先读后写。

支持的简单定时日/周循环只完成当前一期：创建本次完成记录，原ID仍代表未完成的下一期，循环规则保留。完成返回 record（已完成历史）和 nextOccurrence（下一期）。不能把下一期的新版本当成上一期的重试。复杂循环或子任务等未支持形态会明确拒绝。

查找读取的是本人及有权限访问的家庭设备，不是朋友位置。refresh=false读最后报告位置；刷新被接受不代表已有新位置。播放声音需要用户确认指定设备，再传 confirmed=true，不自动重试。没有丢失模式、抹除或公开删除工具。

## 6. 文件和错误

缩略图以 MCP图片返回，显示方式取决于客户端。下载返回 Access受保护临时链接和 icloud-file://资源，不公开 Apple签名URL。资源读取上限5MiB，HTTP下载上限100MiB/60秒，临时票据最多5分钟，受服务权限和会话代次约束。

操作结果、错误详情和技术状态都有复制入口。提交公开问题前先脱敏技术状态，保留工具名、错误码、请求编号、时间及必要参数即可。

- REAUTH_REQUIRED：看服务详情，网页会话重新验证或 DAV替换专用密码。
- DEVICE_APPROVAL_PENDING / VERIFICATION_REQUIRED：按页面提示批准/验证，不连续重试。
- RATE_LIMITED / UPSTREAM_UNAVAILABLE：等待指定时间或检查网络，不盲目重发写入。
- CONFLICT：读取当前对象和版本，再决定下一步。
- WRITE_OUTCOME_UNKNOWN：先核对原ID及详情中的完成记录ID，不自动换ID、刷新版本或强制覆盖。
- UNSUPPORTED_FEATURE / PROTOCOL_CHANGED：核对支持范围及项目更新，不绕过校验。

[安全说明](../SECURITY.md) · [验证记录](VALIDATION.md) · [协议及验收清单](PROTOCOL-AND-ACCEPTANCE.md)
