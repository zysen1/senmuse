# 让 AI 部署 SenMuse：本机调用与跨机器连接

**默认 API 只供部署它的本机使用。** 要让另一台电脑上的 Claude、Codex 调用 Muse 云主机里的 API，还需要一条真实可用的网络连接。本指南供用户和接手部署的 AI 执行，适用于独立 API `0.3.0-preview.1`。

仓库已实现本地服务、原生媒体适配器、登录网关 provider、REST 和 HTTP MCP。Muse 云主机的外部入口及真实账号视频生成尚未完成端到端验收；后文的出站中继是开发方案，尚无启动命令。

## 用户可以直接复制给 AI

```text
请使用 https://github.com/zysen1/senmuse 配置能实际调用 Muse 的视频 API。
先读 AGENTS.md、docs/AI_DEPLOYMENT.md，再按部署位置阅读 docs/MUSE_API.md 或 docs/API_GATEWAY.md。
先确认 API 在哪台主机运行、Claude/Codex 在哪台主机实际发出请求；不要把不同机器的 localhost 当成一个地址。
在 Muse Linux 云主机优先检测并使用本机 media-generation；在普通 Windows/macOS/Linux 主机使用我自己的 Muse 登录会话。
按指南选择实际可用的同机连接、原生网络入口、HTTPS 反向代理或已有 SSH 转发，完成配置和验证，不要只给我安装建议。
若只能向外联网，说明缺少入站入口；如果我已有可用的中继服务器且任务包含开发，就按指南实现 worker/relay，否则保留已完成的本机服务并指出唯一缺项。
保留鉴权和现有文件，不公开令牌，不猜测 Muse 的网络命令、权限或生成接口。
先验证连接和工具，再生成一条“一只橘猫走过晨光花园”的测试视频；我授权这一次生成使用 Muse 额度，优先选择当前组件支持的最低成本选项，不反复提交收费任务。
从真正的客户端检查 REST、MCP 和下载文件。无法操作客户端时，交付该客户端的验证步骤并标记尚未验证。
最后返回实际地址、客户端配置文件位置、启动与停止方法、连接有效期，以及 local_ok / remote_ok / generation_ok 的真实结果，不要把部署本机成功当作远程成功。
```

用户可以把测试视频描述换成自己的需求。仅安装部署、不准备生成时，删除授权生成那一行；能力探测本身不应消耗生成额度。

## 1. 先确认两端在哪

“客户端”指真正执行 HTTP / MCP 请求的进程所在主机。界面在用户电脑上，不代表请求一定从该电脑发出；托管在云端的 AI 客户端也有自己的网络环境。

| API 服务位置 | 请求发出位置 | 连接方法 |
| --- | --- | --- |
| 用户 Windows / macOS / Linux 电脑 | 同一电脑、同一网络命名空间 | 默认 `http://127.0.0.1:47831` |
| Muse Linux 云主机 | 该主机上的 Muse 工具进程 | 默认 `http://127.0.0.1:47831` |
| Muse Linux 云主机 | 用户电脑或其他云端客户端 | 需要下文的 HTTPS 入口或已授权的 SSH 转发 |
| 用户电脑 | 云端托管的 AI 客户端 | 需要云端客户端能访问的入口；不能填写用户电脑的 `127.0.0.1` |

容器、WSL、远程开发环境可能有独立的网络命名空间。实际检查端口与请求路径，不要仅凭“同一台物理电脑”判断可达。

先记录操作系统、Node 版本、仓库目录、数据目录、API 主机、实际客户端主机，以及已有的合法网络入口。不要扫描无关文件或读取其他账户凭据。

## 2. 先把本机 API 跑通

需要 Node.js 24 或更新版本。下面的安装命令在 Windows PowerShell、macOS 和 Linux 终端逐行运行；已有仓库时先检查改动，复用现有目录，不覆盖用户工作。

```sh
git clone https://github.com/zysen1/senmuse.git
cd senmuse
node --version
```

### Muse 自己的 Linux 云主机

```sh
node scripts/probe-muse.mjs --json
node scripts/senmuse-api.mjs init --native --data .senmuse-api
node scripts/senmuse-api.mjs doctor --data .senmuse-api
node scripts/senmuse-api.mjs serve --data .senmuse-api
```

这条路线无需 Electron、npm 依赖或浏览器登录窗口。按 [原生组件说明](MUSE_API.md) 阅读实际媒体 CLI 的帮助；当前内置适配器只声明已确认的能力。只有对话工具、没有服务进程可调用的媒体接口时，应报告缺项。不能用“重新给 Muse 自己发聊天消息”代替原生适配。

### 用户 Windows / macOS / 普通 Linux 主机

```sh
npm ci --prefix api
npm --prefix api run browser:install
node scripts/senmuse-api.mjs init --data .senmuse-api
node scripts/senmuse-api.mjs login --data .senmuse-api
node scripts/senmuse-api.mjs doctor --data .senmuse-api
node scripts/senmuse-api.mjs serve --data .senmuse-api
```

首次登录需要用户在可操作的浏览器中完成授权，详见 [登录网关说明](API_GATEWAY.md)。不要索取用户密码、验证码或从其他应用提取 Cookie。无图形界面的普通服务器不能凭 headless 模式自动完成首次登录。

两条路线中，`init` 只在首次配置时运行；配置已存在就检查并保留，不能为了让命令通过而删除数据目录。所有后续命令使用同一个 `--data`。默认端口若被桌面版或其他服务占用，选择空闲端口并同步修改客户端配置。

`serve` 是前台进程，关闭进程就停止服务。另开终端做验证；需要长期运行时，依据主机实际提供的进程管理器配置启动命令、绝对路径、环境和持久目录。仓库没有自动安装守护服务的命令，`nohup` 或后台运行也不证明能跨会话、跨重启存活。不要改动 Muse 管理的守护进程。

## 3. 选择一条真实可用的连接路线

### A. 同机调用

保留 `host: "127.0.0.1"`，无需设置 `publicUrl`。独立 API 的 REST 根地址是 `http://127.0.0.1:47831`，MCP 地址是 `http://127.0.0.1:47831/mcp`。Muse 在自己的云主机发请求也适用。

### B. Muse 当前确实提供服务发布入口

阅读当前主机网络组件的帮助、SDK 类型和官方说明。探测到 `ingress-rev-proxy`、出站代理或网络 socket，并不表示这些组件允许发布任意端口；[原生指南](MUSE_API.md#网络组件与外部客户端)列出了已核对资料的边界。

只有文档明确支持用户服务接入，才依说明建立映射。记录真实绑定的端口、分配的 URL、访问权限和会话有效期。检查它是否支持服务端客户端直接携带 Bearer 令牌访问、POST、二进制上传下载。要求浏览器登录 Cookie、跳转登录页、仅展示文件的分享链接，不能直接当 MCP 入口。

现有 `publicUrl` 只接受类似 `https://video.example.com` 的 HTTPS 根地址。若入口只给 `https://example.com/some/path`，当前服务不支持直接作为基础路径部署；需要有授权的根域名映射或另行实现并测试路径前缀支持，不能删除路径后假装可用。网页控制台要求同源，当前不支持跨站 iframe 嵌入；Muse 构件可以提供已验证入口的链接，不能假定嵌入后即可工作。

取得兼容的入口后，将真实 HTTPS 根地址写入 `.senmuse-api/config.json` 顶层 `publicUrl` 并重启服务。确认入口完整转发 `/`、静态文件、`/v1/*` 和 `/mcp`，保留 `Authorization`，上游 `Host` 匹配公开地址，随后从实际客户端执行第 4 节。否则可能返回 403，或仍把回环地址作为素材下载地址。

### C. 用户已有可达的 HTTPS 反向代理

代理必须实际能连接 API 所在的主机和端口。仅在另一台服务器安装 Nginx，不会让它访问 Muse VM 内部的 `127.0.0.1`。

1. 为用户控制的真实域名配置 DNS、证书和到 API 的上游连接。
2. 代理与 API 在同一网络命名空间时，API 继续监听 `127.0.0.1`；确需跨容器连接时再按真实网络配置监听地址和访问范围。
3. 在 `.senmuse-api/config.json` 顶层设置真实的 `publicUrl`，保留其余配置并重启服务。
4. 使用 [HTTPS 代理配置示例](API_GATEWAY.md#远程提供服务)，完整转发 `/`、静态文件、`/v1/*` 和 `/mcp`。保留 `Authorization`，让上游 `Host` 匹配配置的公开地址，支持最大 200 MiB 的素材请求。检查代理自身的超时和上传限制。
5. 从真正的外部客户端执行第 4 节的验证，再交付 HTTPS 地址。

`publicUrl` 用于生成下载链接和校验请求 Host/Origin，**不会创建隧道或开放端口**。`0.0.0.0` 仅改变监听网卡，也不会自动处理路由、防火墙、证书或 Host 校验。`provider.proxy` 则是访问 Muse 的出站代理，与客户端连接 API 的入站入口无关。代理请求头配置可参考 [Nginx 官方文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)。

### D. 用户已经有到 API 主机的 SSH 连接

此路线要求可用的 SSH 主机地址、用户授权的登录方式和允许的端口转发。Muse 网页登录不等于拥有其 VM 的 SSH 权限。

在**实际客户端主机**运行下面的命令，将 `YOUR_USER@YOUR_SSH_HOST` 替换为已有连接；Windows 需安装可用的 OpenSSH 客户端。

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:47831:127.0.0.1:47831 YOUR_USER@YOUR_SSH_HOST
```

SSH 服务器必须与 API 共享目标回环网络，服务保持运行。该命令让客户端本地端口经 SSH 连接远端 API；此时客户端仍填写 `http://127.0.0.1:47831/mcp`，并提供 API 令牌。关闭 SSH 转发，连接即失效。[OpenSSH 官方说明](https://man.openbsd.org/ssh#L)解释了本地端口转发。

当前 API 校验 Host 并返回绝对下载 URL，因此这个直通示例两端都使用 `47831`。若端口冲突，要同步调整远端 API `port`、转发两端端口和客户端地址；不要只改客户端端口。仅使用 SSH 路线时，不应保留一个不可达的 `publicUrl`，否则下载链接会指向该地址。已有其他客户端依赖公开地址时，应保留原配置，另行规划兼容的入口。

### 没有任何可用入口时

保留已经验证的本机 API，报告 `remote_ok: false`。Muse 自己仍可在同机调用；外部 Claude/Codex 暂时不能直连。

如果用户的目标是先让电脑上的 AI 能用，可以改在该电脑按登录网关路线部署。这是另一个运行位置和 provider，仍需该用户自己的登录与生成验收，不代表 Muse 云主机已对外开放。

如果用户坚持让 Muse VM 执行，而它只有出站能力，见第 6 节中继开发方案。它需要额外的可达服务器；开源仓库和 GitHub Pages 本身不提供运行 API 的后端。

## 4. 从真正的调用端逐项验收

先在服务本机检查，再在预期的客户端重复。AI 无权操作客户端时，必须把远程验证留作未完成，并提供使用真实地址的检查步骤。

| 检查 | 通过标准 | 不能据此推断的内容 |
| --- | --- | --- |
| `GET /healthz` | 返回 SenMuse JSON 和 `alive: true`，不是登录 HTML 或重定向 | 媒体能力、令牌、生成额度 |
| 无令牌 `GET /v1/status` | 返回 401 | 正确令牌已经配置 |
| 带 Bearer 令牌 `GET /v1/status` | 返回实际 provider 状态；生成前需 `muse.state: "ready"` 且支持 `video` | 实际生成一定成功、额度足够 |
| `POST /mcp` 初始化与 `tools/list` | 正确返回 JSON-RPC，能发现工具 | 视频生成和素材传输成功 |
| 参考素材往返 | 上传一份用户授权的有效小媒体文件，再下载并核对字节 / 哈希 | 上游一定接受该参考格式 |
| 一次真实生成 | 同一任务完成，返回实际素材，调用端下载并确认可解码的视频 | 所有模式、时长或未来会话都可用 |

令牌是 SenMuse 自己的 API 凭据，默认保存在配置指定的 `api-token` 文件，不是 Muse 密码；服务进程设置了 `SENMUSE_API_TOKEN` 时以该环境变量为准。按 [Codex 配置](API_GATEWAY.md#连接-codex)或 [Claude Code 配置](API_GATEWAY.md#连接-claude-code)使用私密环境变量或客户端支持的安全配置；只在报告中给出配置位置，不回显密钥。远程客户端需要安全提供同一令牌，不能在没有服务数据目录的电脑直接运行 `token` 命令。

例如，macOS / Linux 客户端已设置私密的 `SENMUSE_API_TOKEN` 后：

```sh
SENMUSE_API_URL='http://127.0.0.1:47831'
curl --fail-with-body "$SENMUSE_API_URL/v1/status" \
  -H "Authorization: Bearer $SENMUSE_API_TOKEN"
```

把地址换成所选路线的真实入口。Windows PowerShell 对应的状态检查为：

```powershell
$senmuseApiUrl = 'http://127.0.0.1:47831'
Invoke-RestMethod -Uri "$senmuseApiUrl/v1/status" -Headers @{ Authorization = "Bearer $env:SENMUSE_API_TOKEN" }
```

HTTP MCP 请求带同一鉴权、`Content-Type: application/json` 和 `Accept: application/json, text/event-stream`。先发送：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"deployment-check","version":"1.0"}}}
```

然后发送初始化通知 `{"jsonrpc":"2.0","method":"notifications/initialized"}`，再发送 `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`。本服务返回 JSON，不提供 SSE 长连接；不能用浏览器打开 `/mcp` 得到 405 就判定连接失败。实际 Claude/Codex 配置使用独立 API 的 HTTP `/mcp`，见 [配置示例](API_GATEWAY.md)。不要混用旧桌面版 `scripts/mcp.mjs` 的项目导出工具。

素材上传使用 `POST /v1/assets` 原始二进制请求体及 `X-Filename`，返回素材 ID；通过返回的下载地址取回，仍需 Bearer 令牌。生成使用 `POST /v1/jobs` 或 `muse_generate`，保存 8–100 字符的 `requestId` 和返回的任务 ID。按 [请求字段](MUSE_API.md#rest-与-mcp-客户端)提交用户授权的内容，轮询已有任务，用素材 ID 找到并下载结果。202 只说明任务入队，必须确认实际文件是可播放视频；不要把 HTML 错误页、测试色板或旧素材作为生成结果。

网络超时重试保留同一 `requestId` 和相同请求内容；不要换 ID 再生成。`needs_review` 时检查上游实际状态，不能自动重交。取消本地跟踪不保证 Muse 停止生成。

持久化检查应在没有正在提交的任务时做：正常停止、用同一数据目录重启，核对已完成的任务和素材仍在、入口仍可用。若环境会回收 VM、进程或入口，把实际有效期写明。不要为了验收故意中断正在消耗额度的生成。

## 5. 交付给用户的结果

交付实际值，不原样返回示例域名或占位符。可以使用下面的格式；未检查写 `未验证`，同机方案的 `remote_ok` 写 `不适用`。

```text
API 主机 / 请求客户端主机：
生成 provider：原生组件 / 登录网关
连接路线：同机 / 原生入口 / HTTPS 代理 / SSH 转发 / 已实现并验收的中继
REST 根地址 / MCP 地址：
客户端配置文件位置 / 令牌私密配置位置（不含令牌值）：
local_ok：true / false / 未验证
remote_ok：true / false / 未验证 / 不适用
generation_ok：true / false / 未验证
证据：检查结果、任务 ID、实际视频文件位置及格式
服务和入口：启动方法、停止方法、是否随会话结束、是否验证过重启
未完成项及下一步：
```

在真正的客户端尚未验证前，可以交付“待验证地址”，不能称为“已经能远程调用”。如果 `ready` 但没有完成真实视频生成，应明确写 `generation_ok: 未验证`。

## 6. 只有出站网络时：worker / relay 开发方案

**以下尚未实现。当前仓库没有 relay、worker、隧道启用命令或托管中继服务。** 这是供接手开发的 AI 使用的实现方案，仅在用户希望采用此路线且提供可运行后端的服务器时进入开发。

```text
Claude / Codex ──HTTPS REST / MCP──> 用户自己的公网 relay
                                         ↑
                          Muse VM 上的 worker 主动向外连接
                                         ↓
                           VM 内的 SenMuse 本机 REST API
                                         ↓
                                  原生媒体组件
```

relay 接收任务，worker 通过出站 HTTPS 长轮询领取，调用 VM 内现有 API，再将状态和实际素材回传。VM 不需要被公网主动连接；relay 仍需要真实可达的 HTTPS 入口及存储。必须先验证该 VM 允许访问用户的 relay，不绕过主机的出站限制。

### 给接手 AI 的实现顺序

1. **确认资源与绑定。** 明确 relay 服务器、HTTPS 域名、持久存储、Muse VM 可用的 Node 和出站权限。初版采用单用户、固定 worker 与 Muse 账号绑定；不要引入共享账号池。继续保留现有本地 REST/MCP 用法。
2. **实现 broker 存储。** 保存客户端请求 ID、规范化请求内容、relay 任务 ID、worker ID、领取租约、提交阶段、本机任务 ID、素材映射和结果。创建任务必须持久化后才回应。相同请求重复提交返回原任务，不同内容复用同 ID 返回冲突。
3. **实现独立认证。** 客户端令牌只能提交与读取自己的任务；worker 使用单独且限制到指定账号的凭据领取、续租、回报。Muse 登录凭据和本地 API 令牌只留在 VM。relay 不接受下发任意 shell 命令、任意目标 URL 或 VM 文件路径。
4. **实现 worker。** 只主动连到配置的 HTTPS relay，使用现有本地 `/v1/status`、`/v1/jobs`、`/v1/assets`。在持久日志中先记录准备提交，再提交；保存并复用稳定的 `requestId` 和本机任务 ID。重连后先查已有状态，不盲目创建新请求。不递归调用 Muse 聊天 Agent。
5. **处理故障和租约。** 网络只能保证尽力交付，不能宣称上游严格 exactly-once。领取超时不等于从未生成；已提交或提交结果不明确的任务应进入 `needs_review`，不能因租约到期自动交给另一个 worker 重做。重启后保留提交标记，区分可安全恢复的查询与可能重复扣费的提交。
6. **传输实际素材。** relay 保存用户上传的参考文件，worker 经鉴权获取并上传到本地 API，记录两端素材 ID。结果从本地受保护的素材接口读出，再上传 relay；客户端只拿 relay 的受保护下载地址。验证类型、大小、哈希及账号归属；为存储设置配额、保留期和清理机制，不能接受任意本地路径作为结果。
7. **提供外部 REST/MCP。** 可复用现有接口字段和工具语义，但 relay 需要自己的任务执行与存储逻辑；当前 command provider 是本地进程适配器，不会自动变成远程 worker。状态明确返回 worker 离线、排队、执行中、需要检查等情况，不能离线时仍报生成就绪。取消指令和上游取消结果分开记录。
8. **补齐交付与验收。** 编写真实的 relay / worker 启动入口、Windows 与 Linux 安装说明、持久目录、环境配置和日志脱敏。测试重连、重复领取、提交后断线、租约过期、重启恢复、跨账号拒绝、参考素材往返和大文件失败；最后从真实客户端完成一次授权生成与视频下载。测试通过前，README 继续标注该路线为开发中。

建议把开发拆为 broker 队列、worker 执行、素材传输、MCP 和故障验收五部分。具体新增路由和命令应随实际代码定义与记录；不要凭本方案声称仓库已经存在 `/worker/*` 等接口。缺少公网服务器或必要登录权限时，保留已完成的可审查代码，并说明具体缺项。
