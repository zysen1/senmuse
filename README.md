# 森映 SenMuse

中文 Muse 创作与分镜成片工作台。用自己的 Muse 账号生成素材，按镜头修改，再把图片、视频、字幕和音轨合成为一条成片。

当前版本为 **0.1.0 开发预览**，优先验证 macOS Apple Silicon。Muse 网页适配需要有效登录，网页变化可能影响生成。首次公开版本的验证范围会在下方持续记录。

## 开始使用

普通用户可以从 [Releases](https://github.com/zysen1/senmuse/releases) 下载适合自己电脑的应用包。macOS 解压后将 SenMuse.app 放进“应用程序”。当前构建采用本机签名，尚未经过 Apple 公证，系统可能要求在“隐私与安全性”中确认打开。

1. 打开森映，点击 **登录 Muse**，在 Muse 官方页面完成登录。
2. 返回森映，点击 **我已登录，检查连接**。
3. 在创作台填写描述，按需添加参考图，再点击生成。
4. 在 **分镜成片** 新建项目，为镜头选择生成素材或导入自己的素材，编辑字幕、时长和音轨，然后导出 MP4。

首次导出会自动下载并校验视频处理组件，需要能够访问 GitHub。中文字体随应用提供。生成使用 Muse 账号自身的额度。

## 已实现的工作流

| 工作流 | 能做什么 |
| --- | --- |
| 创作台 | 图片、视频、参考图、MP4 修改、基于原会话的视频续拍 |
| 分镜成片 | 按段落拆分草稿、手动编辑镜头、单镜重做、镜头排序、原素材复用 |
| 本地合成 | 9∶16、16∶9、1∶1，适应或裁切画面，中文烧录字幕、SRT、可选音轨 |
| 任务队列 | 持久保存、暂停、取消、手动重试、发送状态不明确时停止并提示检查 |
| 素材库 | 本地预览、导入图片/视频/音频、定位原文件 |
| Agent 接口 | 带密钥的本地 HTTP API 和 MCP stdio 桥接 |

“按段落拆分”根据空行整理分镜。角色一致性、画面质量、生成时长取决于 Muse 实际输出。导出的画幅由本地合成控制，裁切可能改变构图。配音目前通过导入音频实现。

## 运行源码

需要 Node.js 24 或更新版本，以及 npm。

```sh
git clone https://github.com/zysen1/senmuse.git
cd senmuse
npm ci
npm run build
npm start
```

开发界面时运行 `npm run dev`。主进程代码修改后需要重新启动开发命令。

```sh
npm run typecheck
npm test
npm run package
```

`npm run package` 为当前系统和架构构建应用。macOS 额外生成 ZIP 文件。Windows、Linux 源码构建路径仍需要对应系统实测。

## 网络与账号

默认使用系统网络设置，也可以在设置中填写自己的 HTTP、HTTPS 或 SOCKS5 代理，例如 `http://127.0.0.1:7890`。网络设置只作用于应用的 Muse 会话。任务执行期间需要等任务结束再更换代理。

Muse 登录保存在 Electron 的独立本机会话中。项目、任务和素材保存在本机 SenMuse 数据目录。导出文件夹可以在设置中修改。森映没有自建云服务，也不会索取 Muse 密码。

如果任务显示 **需要检查**，请先打开 Muse 查看结果。应用会暂停队列，避免对已发送但未能确认的请求自动再次生成。确认后可以手动处理任务并继续队列。取消本地任务后，已提交到 Muse 的请求可能继续运行。

## HTTP API

在设置中启用本地 API，点击显示密钥。默认地址为 `http://127.0.0.1:47831`，只监听本机，所有接口要求 Bearer token。

```sh
curl http://127.0.0.1:47831/v1/jobs \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"kind":"video","prompt":"清晨咖啡馆，镜头缓慢推进","requestId":"coffee-demo-001"}'
```

同一次生成的网络重试请复用 `requestId`，新的生成请换一个值。请求返回任务记录，生成结果需要继续查询。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /v1/status` | 连接和队列状态 |
| `POST /v1/jobs` | 创建生成任务 |
| `GET /v1/jobs` | 任务列表 |
| `GET /v1/jobs/{id}` | 单个任务和结果素材 ID |
| `POST /v1/jobs/{id}/cancel` | 取消本地任务 |
| `POST /v1/jobs/{id}/retry` | 明确请求重新生成 |
| `GET /v1/assets` | 素材列表及下载地址 |
| `GET /v1/assets/{id}/file` | 下载素材，仍需密钥 |
| `GET /v1/projects` | 分镜项目列表 |
| `POST /v1/projects/{id}/export` | 启动本地成片导出 |

## MCP

MCP 桥接需要本机 Node.js，森映应用保持运行并开启 API。在支持 stdio MCP 的客户端配置中添加以下内容，把脚本路径和密钥替换成自己的值。设置页可以复制当前安装位置对应的配置。

```json
{
  "mcpServers": {
    "senmuse": {
      "command": "node",
      "args": ["/absolute/path/to/senmuse/scripts/mcp.mjs"],
      "env": {
        "SENMUSE_API_URL": "http://127.0.0.1:47831",
        "SENMUSE_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

支持生成、查任务、取消、列素材、列项目与启动导出。AI 客户端策划和调用工具仍消耗其自身 token，视频生成消耗 Muse 额度。

## 验证范围

- 自动测试覆盖幂等请求、重启恢复、项目版本冲突、API 认证、Muse 页面识别、生成结果归属和媒体处理。
- 本地 FFmpeg 集成测试实际生成 MP4，检查画幅、时长、音轨、字幕与失败清理。
- Muse 真实账号生成、附件上传、修改与续拍需要单独进行登录态实测。当前不能据本地测试宣称这些线上流程已经稳定。
- 当前支持单个 Muse 账号和顺序生成队列。多账号、批量运营和自动发布尚未实现。

## 开源

本项目由 [zysen1](https://github.com/zysen1) 开发维护，采用 [MIT License](LICENSE)。产品思路受到 [muse4ai](https://github.com/andrew-babo/muse4ai) 启发，应用、界面、任务存储和媒体工作流独立实现。

第三方组件、字体和视频处理组件的来源及许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Muse 是相关权利人的服务与商标，森映是独立项目。使用前请了解 Muse 的账号与服务规则。
