# 在 Muse Linux 云主机接入原生媒体组件

目标是让 Claude、Codex 等客户端提交生成任务，由 Muse 当前主机真实可用的媒体组件执行。SenMuse 负责 API、任务队列、素材和成片合成；模型生成能力、账户额度与可用地区仍由 Muse 决定。

云端原生接入使用 Node.js 24，不需要启动 Electron。仓库内置 `scripts/muse-native.mjs`，会检查当前主机的 `media-generation --help`，确认兼容参数和输出类型后直接调用原生媒体命令。没有组件或版本不匹配时，它明确返回未配置状态，不会产生假素材。账户权限和剩余额度仍以实际调用结果为准。

开始部署前先读 [AI 部署指南](AI_DEPLOYMENT.md)，确定 API 主机和实际客户端的位置，再选择本机或跨机器连接。可以直接使用该指南开头的完整执行提示词。

## 可以直接发给 Muse 的话

> 请在你当前的 Linux 云主机安装并配置 https://github.com/zysen1/senmuse，让我的 Claude/Codex 能通过它请求你当前账户实际可用的生图、视频生成能力。先阅读仓库 AGENTS.md 和 docs/MUSE_API.md，运行 `node scripts/probe-muse.mjs --json`，核实当前的媒体命令、SDK 和原生网络组件。运行 `node scripts/senmuse-api.mjs init --native`，用内置原生适配器检查并启动服务；如果版本不兼容，再依据本机实际帮助文档调整绑定。不要把请求再发给你自己的聊天 Agent。只声明已确认的功能；若只有对话内工具而没有服务进程能调用的入口，明确报告缺项。网络接入依据当前组件的真实说明，不要猜端口映射命令、URL、权限或永久运行能力，不要打印登录凭据。配置完成后检查服务与能力接口；若已有我授权生成的内容，实际生成一次并核验输出文件，再返回真实可用的连接信息与 Claude/Codex 配置。探测本身不要生成视频或消耗额度。

## 先确认当前主机的真实接口

在仓库根目录运行：

```bash
node scripts/probe-muse.mjs --json
```

系统 Node.js 版本较旧、但有 npm 和下载权限时，可临时运行 Node.js 24：

```bash
npx --yes --package=node@24 node scripts/probe-muse.mjs --json
```

探测只检查固定组件路径及其 `--help`，每个帮助命令有超时和输出大小限制。它不生成媒体，不读取环境变量值、Cookie 或令牌，不启动入口代理，也不修改系统组件。报告保留 `accountAvailability: "unknown"`、`quota: "unknown"` 与 `publicIngress: "unverified"`。

重点核对这些候选位置：

| 路径                                                             | 应确认的事实                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `/opt/hatch/bin/media-generation`                                | 本机是否可执行，帮助是否提供图像/视频操作、输入与结果契约                  |
| `/opt/muse/bin/media-generation` 或 PATH 中的 `media-generation` | 较新或不同主机布局下的同名媒体命令                                         |
| `/opt/hatch/bin/ingress-rev-proxy`                               | 当前安装版本是否提供给用户服务使用的入口；不能仅凭文件名假设它支持映射端口 |
| `/opt/hatch/bin/hatch-ws-client`                                 | 是否存在与当前任务有关且可授权使用的连接方式                               |
| `/opt/hatch/skills/spaces/ts-runtime/README.md`                  | 当前主机 Web Artifact 运行时的支持范围                                     |
| `/opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz`         | 实际安装的 SDK 及其类型声明；依照当前版本核对服务端能力                    |
| `/opt/muse/assets/spaces/ts-runtime/`                            | 较新快照使用的 SDK 和运行时资源目录                                        |
| `~/docs/media.md`、`~/docs/artifacts.md`                         | 当前主机的媒体与发布限制                                                   |

这些路径来自公开运行环境快照，只是探测候选。不同账户、版本、地区或隔离环境可能没有相同组件。SDK 文档里的 Web Artifact 能力也不自动等于任意 Node.js 服务能调用的能力。

若发现媒体 CLI，仅依据其实际 `--help` 阅读对应子命令的帮助。若发现 SDK，检查安装包的类型和公开导出，再使用它明文支持的接口。不要从名字猜 `generate-video` 参数，不要把聊天工具名 `media.generate_video` 当作可直接访问的 HTTP 路径，不要读取凭据存储或调用不明 Unix socket 来绕开正常授权。

## 适配器协议

`src/api/native.ts` 的 `NativeCommandProvider` 使用 `spawn(command, args, { shell: false })` 启动已配置的本机适配器。`command` 和 `args` 来自服务配置，生成提示词通过标准输入传递，不拼接到 shell 命令。

每次启动只处理一条标准输入 JSON；标准输出采用 JSONL，每个事件独占一行。调试信息不要混入标准输出。服务不把原生标准错误直接回传给远程客户端，以免泄漏凭据；可处理的失败必须返回 `error` 事件，并在适配器自己的受控日志中记录必要诊断。

能力查询输入：

```json
{ "protocol": "senmuse-provider-v1", "operation": "capabilities" }
```

响应示例（仅说明协议，实际能力必须来自当前适配器）：

```json
{
  "type": "capabilities",
  "state": "ready",
  "message": "本机视频命令已绑定；账户可用性需实际生成确认",
  "capabilities": ["video"]
}
```

`state` 可为 `ready`、`login_required`、`unconfigured`、`error`。能力名称限定为 `image`、`video`、`edit`、`extend`。未配置或不可用时返回空数组。能力查询不得偷偷生成测试素材、承诺可用额度或补上尚未实现的编辑/续拍能力。

生成输入形状：

```json
{
  "protocol": "senmuse-provider-v1",
  "operation": "generate",
  "request": {
    "jobId": "server-job-id",
    "requestId": "client-request-id",
    "kind": "video",
    "prompt": "用户要求的画面",
    "referenceIds": [],
    "references": [],
    "aspect": "9:16"
  },
  "outputDir": "/absolute/job/output"
}
```

有参考素材时，`references` 含 `{ "path": "/absolute/input.png", "mime": "image/png", "name": "input.png" }`。可选的 `duration`、`conversationId` 仍须按底层能力处理；底层不支持指定时长或画幅时，应明确报错或说明实际行为，不能默默声称遵守。

生成事件顺序：

```json
{"type":"submitted","conversationId":"native-result-or-session-id"}
{"type":"progress","message":"正在等待本机媒体组件返回"}
{"type":"result","files":[{"path":"/absolute/job/output/video.mp4","mime":"video/mp4","name":"video.mp4"}]}
```

`submitted` 与 `progress` 可选；`conversationId` 只有底层真的返回了相应标识时才填写。成功以单个 `result` 结束并退出码为 0。失败返回 `{"type":"error","message":"真实失败原因"}`，随后退出。不得在终结事件后输出更多事件。

适配器须把真实生成文件复制到该次 `outputDir` 内。服务检查绝对路径、常规非空文件和 `realpath` 边界，符号链接不能指向目录外。不要返回任意主机文件、网页 URL、聊天文本或尚未下载的路径作为生成结果。

为避免重复扣费，服务在把生成请求交给子进程前会保守记录“已派发”。进程崩溃、超时或结果丢失时，不能断言远端未生成；应先检查 Muse，再决定是否重试。终止本机适配器也不等于取消已经提交的远端任务。能力查询限时 10 秒；生成进程限时 30 分钟；标准输出上限为 2 MB。

## 自动接入与能力检查

内置的 `scripts/muse-native.mjs` 自动查找本机媒体命令，依次检查已知安装位置与 PATH。也可以用 `SENMUSE_NATIVE_BIN` 指定已安装命令的绝对路径。它不会下载或执行公开快照中的二进制。

适配器要求本机帮助包含 `--media-subagent-output-type`、`--conversation-json`、`--output-dir`，并明确列出支持的 `image` 或 `video`。只启用列出的类型。提示词以 `[{"text":"用户提示词"}]` 传给结构化参数；有 `--image-file` 时支持参考图片。画幅按帮助实际列出的 `square`、`landscape`、`vertical` 或 `portrait` 映射。当前不宣称改片、续拍、固定时长、音频参考或额度查询能力；不支持的参数会明确失败。

原生命令成功退出并返回 `media_paths` 后，适配器检查每个文件存在、非空、媒体文件头匹配，并且位于该任务独立生成目录内。JSON 旁车文件、错误响应或空目录均不算成功。

创建独立服务配置：

```bash
node scripts/senmuse-api.mjs init --native --data .senmuse-api
```

该命令创建 `.senmuse-api/config.json` 和专用 API 令牌，绑定仓库内置原生适配器。默认仅监听 `127.0.0.1:47831`。也可以用 `SENMUSE_API_DATA` 指定数据目录；每次启动时使用同一目录以保留队列与素材记录。

配置中的 provider 形状如下；`init --native` 使用当前 Node 和仓库脚本的实际绝对路径：

```json
{
  "type": "command",
  "command": "/absolute/path/to/node",
  "args": ["/absolute/path/to/senmuse/scripts/muse-native.mjs"],
  "cwd": "/absolute/workspace"
}
```

可以先单独检查内置适配器的协议响应；下面这条命令不会生成媒体：

```bash
printf '%s\n' '{"protocol":"senmuse-provider-v1","operation":"capabilities"}' | node scripts/muse-native.mjs
```

检查并启动服务：

```bash
node scripts/senmuse-api.mjs doctor --data .senmuse-api
node scripts/senmuse-api.mjs serve --data .senmuse-api
```

`serve` 是前台进程。需要持续运行时，使用当前主机明确支持的进程管理方式，并验证重启后的恢复；仓库不承诺 Muse 会永久保留任意后台进程。原生模式不需要安装 `api/` 中的浏览器依赖，也不需要执行 `login`。

如果当前主机有另一套明确文档化的接口，可以参考 `examples/muse-native-adapter.mjs` 实现自定义适配器，并修改 `provider`。这个自定义模板刻意保持未配置；它与已经实现的 `scripts/muse-native.mjs` 是两个文件。

如果本机根本没有可供进程调用的媒体接口，只在 Muse 对话中出现生成工具，则报告“当前缺少可供服务进程调用的原生媒体入口”。现有素材仍可通过[云端成片流程](MUSE_CLOUD.md)合成。不要把向 Muse 自己发聊天请求写成已经完成的原生组件绑定。

## 网络组件与外部客户端

**默认 API 只在 Muse 云主机本机可用。** Muse 在该主机发请求可直接调用，用户电脑上的 Claude/Codex 需要另一条真实网络连接。部署 AI 应执行 [本机与跨机器部署指南](AI_DEPLOYMENT.md)，从真实客户端验收并分别报告本机、远程和生成结果。

媒体执行与客户端连接是两件事。即使原生媒体适配器就绪，也需要验证 Claude/Codex 到服务的真实网络路径。

优先遵循该主机原生网络组件的当前帮助与使用文档。仓库不提供猜测的 `ingress-rev-proxy` 启动命令，不修改 Muse 管理的守护进程，不承诺它接受任意自定义路由。运行一个本地服务、设置 `host` 或填写 `publicUrl` 都不会自动创建可访问的公网入口。

仅当该主机确实提供支持的入口，或用户已经有授权可用的网络连接时，再设置服务的监听地址和 `publicUrl`。启用客户端鉴权，核对从客户端实际访问服务、提交任务、查询任务、取回素材的整条流程。连接地址若只在当前会话有效，应明确其有效范围。没有连接方案时，说明缺少外部可达入口，保留本机服务供继续配置。

原生模式使用该 Muse Linux 主机当前允许的媒体能力。另一种在外部主机通过用户自己登录的 Muse 会话接入的方式，属于不同 provider；它不能证明原生组件绑定成功，也不代表账号额度会迁移到别处。

## REST 与 MCP 客户端

同机测试可以用 `http://127.0.0.1:47831`。远程客户端使用已经验证的实际服务地址；所有 API 请求都需要 `Authorization: Bearer <API token>`。需要查看本地专用 API 令牌时，显式运行：

```bash
node scripts/senmuse-api.mjs token --data .senmuse-api
```

这条命令会显示访问令牌，适合用户自行配置客户端；不要把输出写进聊天记录、版本库、公开链接或探测报告。它是 SenMuse 服务自己的凭据，不是 Muse 的登录 Cookie。

| 接口                               | 用途                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `GET /v1/status`                   | 检查 provider 状态、真实声明的能力和队列情况            |
| `POST /v1/jobs`                    | 提交生成请求，携带 `requestId`                          |
| `GET /v1/jobs`、`GET /v1/jobs/:id` | 查询已有任务                                            |
| `POST /v1/jobs/:id/cancel`         | 停止本地任务或跟踪；不能假定远端同步取消                |
| `POST /v1/jobs/:id/resolve`        | 用 `{ "action": "acknowledge" }` 确认已检查不确定任务   |
| `POST /v1/queue`                   | 用 `{ "paused": true/false }` 暂停或继续队列            |
| `GET /v1/assets`                   | 查询已入库素材                                          |
| `POST /v1/assets`                  | 上传二进制参考素材，通过 `X-Filename` 提供文件名        |
| `GET /v1/assets/:id/file`          | 下载素材真实内容                                        |
| `GET /v1/openapi.json`             | 读取服务接口契约                                        |
| `POST /mcp`                        | MCP JSON-RPC 入口；客户端调用 `tools/list` 获取当前工具 |

下面的状态查询假设用户已经把专用令牌放入 `SENMUSE_API_TOKEN` 环境变量：

```bash
curl --fail-with-body http://127.0.0.1:47831/v1/status \
  -H "Authorization: Bearer $SENMUSE_API_TOKEN"
```

用户决定进行真实生成时，提交一次请求并保存返回的任务标识：

```bash
curl --fail-with-body http://127.0.0.1:47831/v1/jobs \
  -H "Authorization: Bearer $SENMUSE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"requestId":"example-video-001","kind":"video","prompt":"一只橘猫走过晨光中的花园","referenceIds":[]}'
```

重复查询用返回的任务 ID，不要重新创建任务。相同内容和相同 `requestId` 用于幂等提交；要明确生成新任务时使用新的 `requestId`。提交被接受不等于成片完成，以任务结果和可下载文件为准。

Claude/Codex 的远程 MCP 连接地址使用真实服务地址加 `/mcp`，并配置相同的 Bearer 鉴权。不要把探测出来的 Muse 入口域名直接当成 SenMuse 地址。客户端具体配置格式以其当前版本为准；连通后先列工具、查状态，再发起用户授权的生成任务。

## 已核对的资料与边界

官方 [Muse 安全架构说明](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)确认了持久 Linux VM、运行时容器、连接器 CLI、Unix socket 与受控网络出口的总体架构。官方 [Connector 文档](https://platform.muse.ai/docs)说明连接外部服务的机制，没有给本项目提供可直接套用的 Muse 视频生成或任意端口发布契约。

组件候选路径和运行时说明来自非官方 [MuseAI-Skills 固定版本快照](https://github.com/win4r/MuseAI-Skills/tree/e222ba4391b6270ba394cd2b8c3809ff959ab609)。它不构成官方 API 承诺，里面的二进制条目也不能证明当前账户支持相同操作。快照中的 Tailscale 说明限定为出站连接；不能据此承诺该主机可被 tailnet 入站访问。

CLI 调用依据是另一份公开运行时快照中的 [podcast-helper 实际源代码，第 497–539 行](https://github.com/sneakers-the-rat/muse-skills/blob/1c37f0f549c47b1521f53d5f2e43ce8e37b9f791/skills/generate_podcast/scripts/podcast-helper#L497)：它使用结构化提示词、输出类型、画幅、目录和超时参数，并读取顶层 `media_paths`。视频输出类型和图片参考参数还有一个[实际创作项目的调用示例](https://github.com/sonlovinbot-team/Muse-animated-short-film/blob/72561de52eb8e9ee240f5f79d0485e8d584912a8/references/05-video-generation.md)。这些是公开源代码与使用记录，不是本仓库对用户当前 VM 的成功调用记录，因此适配器仍会核对安装版本的帮助。

Spaces SDK 的 [类型声明](https://github.com/obra/muse-skills/blob/9d8d67af6b8774db53448ff298671703f573ad8e/spaces/ts-runtime/sdk/src/verticals.ts#L443)和[媒体客户端源码](https://github.com/obra/muse-skills/blob/9d8d67af6b8774db53448ff298671703f573ad8e/spaces/ts-runtime/worker/src/space_media.ts)提供的是 `ctx.tool.generate_media` **生图**能力，依赖 Web Artifact 的上下文与媒体 socket；不能据此声称存在任意服务都可调用的视频 SDK。原生 API 路径使用本机 CLI，不绕过这些上下文检查。以当前 VM 的实际帮助、权限和调用结果为准。
