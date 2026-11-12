# 独立 Muse API：Windows、macOS 与 Linux

此文档对应独立 API `0.3.0-preview.1`。桌面应用仍使用自己的 `0.2.0` 版本。独立 API 通过 REST 和 MCP 接收任务，使用你已授权的 Muse 会话提交生成，并下载实际媒体文件；运行时不需要启动 Electron。

**默认只监听部署本机。** API 与 Claude/Codex 不在同一网络环境时，先按 [AI 部署指南](AI_DEPLOYMENT.md)选择并验证连接路线。该指南包含 Windows / Linux 安装、HTTPS 代理、已有 SSH 转发，以及尚待实现的出站中继方案。

外部电脑使用本文的浏览器会话与加密网关路线。如果你已在 **Muse 自己的 Linux 云主机**内，优先看 [原生媒体组件接入](MUSE_API.md)，使用 `init --native` 探测该主机已有的组件。

这是实验性的、非 Muse 官方的协议适配。Muse 的登录、网关和消息格式变化可能导致连接失效。当前已验证本地协议、队列、下载校验和 CLI 行为，尚未完成真实 Muse 账号的生成验收。`ready` 表示登录、加密连接和会话查询通过，不表示额度充足或保证成片。

## 安装与启动

准备 Node.js 24 或更新版本、npm，以及有权限使用 Muse 的账号。在仓库根目录运行以下命令；Windows PowerShell、macOS 和 Linux 的命令相同：

```sh
npm ci --prefix api
npm --prefix api run browser:install
node scripts/senmuse-api.mjs init --data .senmuse-api
node scripts/senmuse-api.mjs login --data .senmuse-api
node scripts/senmuse-api.mjs doctor --data .senmuse-api
node scripts/senmuse-api.mjs serve --data .senmuse-api
```

`login` 打开一个专用 Chromium 窗口，由你完成正常登录与可能出现的人机验证。它确认有效会话后退出。`serve` 随后使用该会话在后台运行浏览器，终端保持前台运行，按 `Ctrl+C` 停止。进程监管器可以管理长期运行的 `serve` 命令。

所有命令必须使用**同一个数据目录**。相对路径以当前工作目录为准；从不同目录启动时请用绝对路径，或者统一设置 `SENMUSE_API_DATA`。`init` 不会覆盖已有配置。运行中的服务会锁定目录，重新 `login` 或执行 `doctor` 前先停止该目录的服务。

初始化生成：

| 文件或目录              | 用途                             |
| ----------------------- | -------------------------------- |
| `config.json`           | 监听地址、浏览器配置与生成提供方 |
| `api-token`             | 访问本 API 的随机令牌            |
| `browser/`              | 专用 Muse 登录会话               |
| `state.json`、`assets/` | 任务状态与下载的素材             |

保留整个数据目录，不要提交到 Git 或放到公开下载目录。API 令牌与 Muse 登录会话是两种凭据：前者只授权访问此服务，不能代替 Muse 登录。

默认监听 `http://127.0.0.1:47831`。桌面应用的本地 API 也可能占用这个端口；遇到 `EADDRINUSE`，停止桌面 API，或修改独立 API 的 `config.json` 中的 `port`，并同步修改客户端 URL。

## Linux 的首次登录

无桌面的 Linux 能运行已登录的 headless 浏览器，但首次 `login` 需要可操作的图形会话，例如你拥有的远程桌面。虚拟显示本身不会替你完成登录、验证码或授权。

另一种方式是连接你已登录且明确授权的 Chromium CDP 会话，见下节。此路线不会自动取得本机普通浏览器的登录状态，也不要求导出 Cookie。浏览器缺少 Linux 系统依赖时，按安装输出补齐依赖；专用 Chromium 仍需安装。

## 浏览器、代理与 CDP

`init` 自动写入当前机器的绝对路径。下面只展示 `config.json` 的 `provider` 部分；编辑时保留真实的 `profileDir`、其他顶层字段和令牌路径：

```json
{
  "type": "muse",
  "profileDir": "/absolute/path/to/.senmuse-api/browser",
  "headless": true,
  "proxy": "http://127.0.0.1:7890"
}
```

`proxy` 可省略。目前支持无用户名密码的 HTTP/HTTPS 代理，用于新启动的浏览器及网关 WebSocket；不支持 SOCKS，不会在拒绝该配置后偷偷改用直连。代理 URL 不接受路径、查询参数或内嵌凭据。

如使用已有 Chromium 的远程调试接口，在同一个 `provider` 对象中添加：

```json
"cdpUrl": "http://127.0.0.1:9222"
```

CDP 的明文 HTTP/WS 地址只接受 `localhost`、`127.0.0.1`、`[::1]`；远程地址必须显式配置 HTTPS/WSS。该浏览器需要已有 Muse 登录上下文，并能访问 Muse。服务只创建和关闭自己的页面，退出时断开 CDP 连接，不关闭用户的浏览器。连接现有 CDP 浏览器时，它的网络代理由浏览器自身配置；上述 `proxy` 仍控制网关连接。

CDP 等同于浏览器控制权限，只连接你授权的实例，不把调试端口直接暴露到公网。不要让两个服务同时使用同一个浏览器配置目录。

## 检查是否就绪

`doctor` 的输出是 JSON，只有 `state: "ready"` 才返回退出码 0。其他状态返回退出码 1，并附上可操作的说明：

| 状态             | 含义                                                             |
| ---------------- | ---------------------------------------------------------------- |
| `ready`          | 登录、加密网关及会话查询可用；实际生成权限和额度仍以调用结果为准 |
| `login_required` | 未登录、会话失效或需要人工验证                                   |
| `unconfigured`   | 缺少 API 依赖或配置，或原生模式没有媒体组件                      |
| `error`          | 浏览器、网络或协议检查失败                                       |

服务启动后，`GET /healthz` 只表示进程存活。带令牌的 `GET /v1/status` 返回当前提供方状态和可用能力。服务能够启动并提供健康检查，即使提供方当前没有配置完成。

在调用客户端所在的终端设置令牌。下面只把令牌装入该进程环境，不把它写进 MCP 配置文件。

macOS / Linux：

```sh
export SENMUSE_API_TOKEN="$(node scripts/senmuse-api.mjs token --data .senmuse-api)"
curl -H "Authorization: Bearer $SENMUSE_API_TOKEN" http://127.0.0.1:47831/v1/status
```

Windows PowerShell：

```powershell
$env:SENMUSE_API_TOKEN = node scripts/senmuse-api.mjs token --data .senmuse-api
Invoke-RestMethod -Uri http://127.0.0.1:47831/v1/status -Headers @{ Authorization = "Bearer $env:SENMUSE_API_TOKEN" }
```

从同一个终端启动 Codex 或 Claude Code，让客户端继承环境变量。已经启动的 GUI 进程通常不会继承之后在终端设置的变量。远程客户端应通过自己的私密环境配置提供同一令牌，不能在另一台未配置数据目录的机器上直接运行上述 `token` 命令。

## 连接 Codex

在项目的 `.codex/config.toml`，或用户自己的 `~/.codex/config.toml` 中加入以下配置；本项目不会替你修改这些文件：

```toml
[mcp_servers.senmuse]
url = "http://127.0.0.1:47831/mcp"
bearer_token_env_var = "SENMUSE_API_TOKEN"
```

`bearer_token_env_var` 的值是环境变量名称。Codex 将它的值放进 Authorization 请求头。启动客户端后可用 `codex mcp list` 检查配置，或在 Codex TUI 中使用 `/mcp` 查看连接。配置字段以 [Codex 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)为准，本文于 2026-11-12 核对。

## 连接 Claude Code

在使用项目的 `.mcp.json` 中加入以下条目；若文件已有其他服务器，合并到 `mcpServers`，保留其他配置：

```json
{
  "mcpServers": {
    "senmuse": {
      "type": "http",
      "url": "http://127.0.0.1:47831/mcp",
      "headers": {
        "Authorization": "Bearer ${SENMUSE_API_TOKEN}"
      }
    }
  }
}
```

`${SENMUSE_API_TOKEN}` 保留为字面文本，由 Claude Code 启动时读取环境变量。使用 `claude mcp list` 或会话中的 `/mcp` 检查。此 HTTP 类型和环境变量展开语法来自 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)，本文于 2026-11-12 核对。这里使用 API Bearer 认证，不需要对本服务执行 OAuth 登录。

## 从请求到可下载文件

MCP 客户端先调用 `muse_status`，再用 `muse_generate` 提交任务。提交立即返回任务记录，通过 `muse_get_job` 轮询；`muse_list_assets` 返回受同一 Bearer 令牌保护的下载地址。上传参考素材使用 `POST /v1/assets` 的二进制请求体和 `X-Filename` 请求头，然后把返回的素材 ID 放入 `referenceIds`。

网关适配器实现以下请求方式，是否完成生成仍由 Muse 决定：

| 类型              | 请求要求                                                  |
| ----------------- | --------------------------------------------------------- |
| `video` / `image` | 提示词，可选图片参考                                      |
| `edit`            | 提示词和一条 MP4 参考视频                                 |
| `extend`          | 原任务返回的 `conversationId`；该会话最后一轮需要已有视频 |

`aspect` 可提出 `9:16`、`16:9`、`1:1`，`duration` 可提出 1–60 秒目标。这些值进入提示词，不是底层模型的硬参数；不能据此承诺精确画幅、时长或“任意续拍 60 秒”。最多四个参考素材，支持的参考格式包括 PNG、JPEG、WebP、MP4、WebM，具体类型还受上表约束；每个素材最多 200 MiB。

REST 接口的完整请求字段可从带认证的 `GET /v1/openapi.json` 获取。例如以下请求会消耗实际 Muse 额度，只在确认连接与意图后执行：

```json
{
  "requestId": "my-video-request-001",
  "kind": "video",
  "prompt": "一只橘猫走过晨光中的花园，固定镜头",
  "referenceIds": [],
  "aspect": "9:16"
}
```

将其作为 JSON 发送到 `POST /v1/jobs`。相同内容和相同 `requestId` 返回原任务，不会重复入队；同一 ID 携带不同内容返回冲突。网络重试请保持原 ID，只有明确创建新作品时才使用新 ID。生成失败前已经提交到 Muse、连接中断或服务重启时，任务可能进入 `needs_review`，队列暂停且不会自动重新扣费提交。

遇到 `needs_review`，先在 Muse 中确认作品和任务状态，再通过 `POST /v1/jobs/{id}/resolve` 发送 `{"action":"acknowledge"}`，之后可用 `POST /v1/queue` 的 `{"paused":false}` 恢复队列。确认操作不会重新生成或自动导入远端作品。取消已提交任务只停止本地等待，Muse 端可能继续运行。

## 远程提供服务

本节配置的是已有 HTTPS 入口；它不会替用户创建网络通道。代理必须能实际访问 API 上游。Muse 云主机的原生入口、SSH 转发条件和无入口时的处理，见 [连接路线选择](AI_DEPLOYMENT.md#3-选择一条真实可用的连接路线)。

同机使用保留默认回环监听即可。向另一台机器提供服务时，在自己管理的 HTTPS 反向代理后运行 API，并在 `config.json` 顶层添加公开根地址：

```json
"publicUrl": "https://video.example.com"
```

该地址必须是 HTTPS 根地址，不能有路径、查询参数、用户名或密码。它用于下载 URL 和请求 Host/Origin 校验。代理与 API 同机时，保留 `host: "127.0.0.1"`；容器或分离部署确需改变监听地址时，再配置对应的 `host`。

反向代理应保留 `Authorization`，并将 `Host` 设置为公开域名（例如 `video.example.com`）。仅把监听地址改成 `0.0.0.0` 并不能让任意域名通过 Host 校验；配置错误会返回 403。举例，Nginx 的对应转发项是：

```nginx
location / {
    proxy_pass http://127.0.0.1:47831;
    proxy_set_header Host video.example.com;
    proxy_set_header Authorization $http_authorization;
    client_max_body_size 200m;
}
```

这个片段需放进你已配置好证书的 HTTPS server 中。远程 Codex/Claude 的 `url` 改为 `https://video.example.com/mcp`。本服务当前采用有认证的 Streamable HTTP JSON 响应，不提供 SSE 长连接或 OAuth；生成通过异步任务轮询，不要求 MCP 请求一直等到视频完成。

## 当前验证范围

本地自动化覆盖公开 Noise 协议测试向量兼容性、消息分片和有界解析、请求提交边界、断线不自动重发、素材内容/大小校验、队列恢复、取消和关闭。提供方编排测试使用受控协议响应，不能证明线上 Muse 仍使用相同协议或某个账号拥有生成权限。

2026-11-12 在 macOS arm64 / Node 24.16.0 上执行了真实 CLI smoke：原生模式初始化成功；缺少原生组件时 `doctor` 返回退出码 1 和 `unconfigured`；真实 HTTP 服务的 `/healthz` 返回 200、无令牌状态请求返回 401、有令牌状态请求返回 `unconfigured`；MCP 初始化成功；正常关闭后释放目录锁。该检查没有模拟生成成功，也没有提交收费任务。

Windows、macOS、Linux 共用这套 Node API 代码；本文不将本机 smoke 等同于三个平台的真实 Muse 成片验收。下一步验收需要用户自己的有效账号，在实际运行平台依次检查登录、状态、最小生成任务及下载文件。
