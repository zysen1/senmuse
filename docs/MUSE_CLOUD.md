# 在 Muse 的 Linux 云主机里使用森映

把仓库链接交给 Muse 后，Muse 可以在具备命令执行能力的 Linux 云主机里运行森映 CLI。Muse 使用当前会话中实际可用的图片、视频或音频工具制作素材，森映读取保存到磁盘的素材，完成分镜合成、中文烧录字幕和 SRT 导出。

当前入口是 `node scripts/senmuse.mjs`，需要 Node.js 24 或更新版本。Linux 云端流程可以直接运行仓库源码，使用共享媒体引擎，安装步骤只需要准备 Node.js 和媒体工具。素材生成的可用性和额度取决于 Muse 当前会话及其提供的工具。桌面端的登录状态保存在用户电脑，云端使用自己的执行环境与已有授权。

## 发给 Muse 的话

复制下面这段话，修改主题、时长和画幅即可。

```text
请使用这个开源项目帮我完成一条视频：
https://github.com/zysen1/senmuse

主题：雨天咖啡馆的产品短片。
时长：15 秒。
画幅：9:16 竖屏。
字幕：简短中文，配合每个镜头。
素材：优先使用我提供的文件，缺少的镜头请用你当前环境实际可用的生成工具制作。

请先阅读仓库的 AGENTS.md 和 docs/MUSE_CLOUD.md，在你的 Linux 云主机上运行森映 CLI。
先检查命令执行、Node.js、素材生成与文件保存能力，再运行 doctor。
将真实素材保存到项目文件夹，制作 JSON 分镜清单，逐镜检查后运行 validate 和 render。
请完成到可下载的 MP4 和 SRT，并说明实际镜头内容、总时长以及需要我注意的生成结果问题。
如果当前环境缺少某项必要能力，请说明具体缺项，以及需要我补充的素材或操作。
```

这段提示适用于用户已同意使用当前生成工具完成作品的情况。需要新增付费服务或额外账号时，应先说明具体需要的服务和用途。

## 环境检查与首次运行

如果已经打开本仓库，从仓库根目录开始执行。首次获取源码可以运行以下命令。

```sh
git clone https://github.com/zysen1/senmuse.git
cd senmuse
node --version
node scripts/senmuse.mjs doctor --json
```

`doctor` 只检查运行环境。根据输出中的缺项处理依赖，再准备视频合成工具。

```sh
node scripts/senmuse.mjs doctor --prepare --json
```

`--prepare` 优先复用可用的系统 FFmpeg。未找到 FFmpeg 时，会下载并校验固定版本的 Linux x64 或 arm64 合成工具。中文烧录字幕还需要仓库提供的字体文件和 FFmpeg 字幕滤镜。若已有 FFmpeg 缺少所需编码器或滤镜，`doctor` 会列出缺项，请更换合适的 FFmpeg，或在仅缺字幕滤镜时设置 `burnCaptions:false` 导出独立 SRT。

有现成 FFmpeg 或需要调整缓存位置时，可以设置以下环境变量。将路径替换成云主机中的实际位置。

```sh
export SENMUSE_FFMPEG=/usr/bin/ffmpeg
export SENMUSE_CACHE_DIR=/workspace/senmuse-cache
node scripts/senmuse.mjs doctor --json
```

`SENMUSE_FFMPEG` 指向自备的可执行文件，`SENMUSE_CACHE_DIR` 指定下载组件的缓存目录。按需设置即可。

若系统 Node.js 版本较旧，但已有 npm，可以使用以下形式运行同一组命令。

```sh
npx --yes --package=node@24 node scripts/senmuse.mjs doctor --prepare --json
```

后续命令同样可以将开头的 `node` 替换成 `npx --yes --package=node@24 node`。首次使用这个替代入口会下载 Node.js，需要网络可用。后续在同一个 Linux 工作目录内继续执行即可。

## 先确认整条合成流程

下面的命令创建测试色板图片、短音频，并实际导出测试视频。

```sh
node scripts/senmuse.mjs demo ./senmuse-demo --json
```

`demo` 用于检查云主机的文件读写、字体和视频合成。它产生的画面是测试素材，交付时应标明测试用途。用户作品需要使用符合创作要求的实际素材。

## 创建项目和分镜清单

```sh
node scripts/senmuse.mjs init ./coffee-video --name "雨天咖啡馆" --aspect "9:16"
```

将生成或上传的素材保存到项目的 `media` 目录，然后编辑项目清单 `coffee-video/project.json`。一个包含两个镜头的清单如下。

```json
{
  "version": 1,
  "name": "雨天咖啡馆",
  "aspect": "9:16",
  "fit": "contain",
  "burnCaptions": true,
  "shots": [
    {
      "file": "media/coffee-closeup.mp4",
      "duration": 5,
      "caption": "雨天，给自己一杯热咖啡。",
      "prompt": "热拿铁特写，雨水沿窗玻璃滑落，镜头缓慢推近。"
    },
    {
      "file": "media/window-seat.mp4",
      "duration": 10,
      "caption": "让忙碌，慢下来。",
      "prompt": "窗边咖啡桌，暖色灯光，窗外雨景，缓慢横移镜头。"
    }
  ],
  "audio": "media/voice.wav"
}
```

示例中的三个媒体文件需要真实存在。没有配音或音乐时，删除 `audio` 字段即可。

| 字段               | 用法                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `version`          | 当前清单版本为 `1`。                                                           |
| `name`             | 项目名称，用于识别导出文件。                                                   |
| `aspect`           | `9:16`、`16:9` 或 `1:1`。                                                      |
| `fit`              | `contain` 完整显示并填充空边，`cover` 填满画面并裁切边缘。                     |
| `burnCaptions`     | `true` 将每个镜头的字幕烧录进画面。导出同时提供独立 SRT。                      |
| `shots`            | 按播放顺序排列的镜头。                                                         |
| `shots[].file`     | 已保存的图片或视频路径，相对于清单所在目录。                                   |
| `shots[].duration` | 镜头在成片中的秒数。                                                           |
| `shots[].caption`  | 该镜头整段显示的字幕，可以为空字符串。                                         |
| `shots[].prompt`   | 可选的生成意图记录，供制作或重做素材时参考。                                   |
| `audio`            | 可选音频路径，相对于清单所在目录。添加后替换镜头原声，未添加时保留原视频声音。 |

图片按镜头时长显示。较长的视频按指定时长裁切，较短的视频可以以末帧补足时长。需要连续运动时，应生成足够长的素材并检查成片。清单的 `prompt` 用于记录描述，生成素材由 Muse 当前可用的工具完成。

## 验证、合成和交付

```sh
node scripts/senmuse.mjs validate ./coffee-video/project.json --json
node scripts/senmuse.mjs render ./coffee-video/project.json --output ./coffee-video/output --json
```

`validate` 检查清单、文件和媒体可读取性。缺少 FFmpeg 时先运行 `doctor --prepare`。验证错误需要先修复，再执行合成。

`render` 合成实际文件，并返回 MP4、SRT 路径及总时长。根据返回的真实路径检查文件存在、大小正常、时长和画幅符合要求，再用当前环境支持的附件方式交给用户。查看首尾画面、字幕和声音，检查是否出现黑屏、字幕缺字或意外静音。图片组成的作品应明确描述为图片短片。

修改某个镜头时，可以保留其他素材，更新对应文件或清单字段，再次验证和导出。每次生成素材消耗的额度由实际使用的生成工具决定。

## 当前环境缺少能力时

| 检查结果                               | 处理方式                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 有命令执行和已有素材                   | 直接创建清单、验证和合成。                                                                                           |
| 有命令执行和素材生成工具               | 先用实际工具生成素材，检查并保存文件，再合成。                                                                       |
| 有命令执行，缺少用户要求的视频生成能力 | 说明缺少视频生成工具，并请用户补充对应素材。若用户目标适合图片短片，可以说明这种呈现形式后继续已有授权范围内的工作。 |
| 有生成工具，生成结果只能预览           | 使用工具提供的保存或下载方式获取文件，取得可读取路径后再填入清单。                                                   |
| 缺少命令执行能力                       | 说明当前会话无法运行 CLI，列出已经完成的脚本或分镜，以及继续执行所需的环境。                                         |
| 下载或依赖检查失败                     | 保留具体错误，报告缺失组件与尝试结果，处理环境问题后重试。                                                           |

能力判断来自当前可调用工具及实际执行结果。账号名称、订阅或历史使用经历无法单独证明本次会话拥有某项生成能力。素材不足时应报告具体缺少的镜头，避免把尚未生成的文件写成已完成结果。
