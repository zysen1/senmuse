import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { loadManifest } from "./manifest.ts";
import { ensureFFmpeg, locateFFmpeg } from "../main/ffmpeg.ts";
import { inspectAsset, renderProject } from "../main/render.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const fontPath = path.join(root, "assets/fonts/NotoSansCJKsc-Regular.otf");
const help = `森映 · Linux 云端与本地命令行（Node.js 24+，无需 npm install）

node scripts/senmuse.mjs doctor [--prepare] [--json]
node scripts/senmuse.mjs init <目录> [--name 名称] [--aspect 9:16] [--json]
node scripts/senmuse.mjs validate <project.json> [--json]
node scripts/senmuse.mjs render <project.json> [--output 目录] [--json]
node scripts/senmuse.mjs demo <新目录> [--json]

doctor 只检查；--prepare 准备合成工具。demo 创建明确标注的测试素材。
Muse 使用自己的工具生成并保存素材，本命令不提供 Muse 视频生成 API。
详情：docs/MUSE_CLOUD.md`;

async function capabilities(binary: string, signal?: AbortSignal) {
  const options = {
    timeout: 20_000,
    maxBuffer: 4 * 1024 ** 2,
    windowsHide: true,
    signal,
  };
  const [{ stdout: version }, { stdout: encoders }, { stdout: filters }] =
    await Promise.all([
      exec(binary, ["-version"], options),
      exec(binary, ["-hide_banner", "-encoders"], options),
      exec(binary, ["-hide_banner", "-filters"], options),
    ]);
  return {
    path: binary,
    version: version.split("\n")[0],
    h264: /\blibx264\s/.test(encoders),
    aac: /\baac\s/.test(encoders),
    subtitles: /\bsubtitles\s+V->V/.test(filters),
  };
}

async function doctor(prepare: boolean, signal: AbortSignal) {
  const binary = prepare ? await ensureFFmpeg(signal) : await locateFFmpeg();
  const ffmpeg = binary ? await capabilities(binary, signal) : null;
  const font = await fs
    .stat(fontPath)
    .then((stat) => stat.isFile() && stat.size > 0)
    .catch(() => false);
  const missing: string[] = [];
  if (!ffmpeg) missing.push("FFmpeg：请运行 doctor --prepare");
  else {
    if (!ffmpeg.h264) missing.push("FFmpeg libx264 编码器");
    if (!ffmpeg.aac) missing.push("FFmpeg AAC 编码器");
    if (!ffmpeg.subtitles)
      missing.push(
        "FFmpeg subtitles 字幕滤镜（可用 burnCaptions:false 导出独立 SRT）",
      );
  }
  if (!font) missing.push(`中文字幕字体：${fontPath}`);
  return {
    ok: missing.length === 0,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    ffmpeg,
    font: { path: fontPath, available: font },
    missing,
    museGeneration: {
      managedBy: "当前 Muse 会话的实际生成工具",
      checked: false,
    },
    next: missing.length
      ? "根据 missing 修复运行环境，再执行本命令。"
      : "环境就绪。准备真实素材后 validate 和 render，或用 demo 检查合成流程。",
  };
}

async function initialize(directory: string, name: string, aspect: string) {
  if (!["9:16", "16:9", "1:1"].includes(aspect))
    throw new Error("画幅必须是 9:16、16:9 或 1:1。");
  if (!name.trim() || name.length > 100)
    throw new Error("项目名称需要 1–100 字符。");
  const base = path.resolve(directory);
  await fs.mkdir(base, { recursive: true });
  const manifest = path.join(base, "project.json");
  // Exclusive creation preserves any existing user project.
  await fs.writeFile(
    manifest,
    JSON.stringify(
      {
        version: 1,
        name,
        aspect,
        fit: "contain",
        burnCaptions: true,
        shots: [],
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  await fs.mkdir(path.join(base, "media"), { recursive: true });
  return {
    ok: true,
    manifest,
    readyToRender: false,
    next: "将真实素材保存到 media，填入 shots 的 file、duration、caption，再运行 validate。",
  };
}

async function verify(manifest: string, signal: AbortSignal) {
  const loaded = await loadManifest(manifest);
  if (!(await locateFFmpeg()))
    throw new Error("尚未准备 FFmpeg，请先运行 doctor --prepare。");
  for (const asset of loaded.assets) await inspectAsset(asset, signal);
  if (
    loaded.project.burnCaptions &&
    loaded.project.shots.some((shot) => shot.caption.trim())
  ) {
    await fs.access(fontPath);
    const info = await capabilities((await locateFFmpeg())!, signal);
    if (!info.subtitles)
      throw new Error(
        "FFmpeg 缺少字幕滤镜；使用支持 libass 的 FFmpeg 或设置 burnCaptions:false。",
      );
  }
  return loaded;
}

async function render(
  manifest: string,
  output: string | undefined,
  signal: AbortSignal,
  json: boolean,
) {
  await ensureFFmpeg(signal);
  const loaded = await verify(manifest, signal);
  const outputDir = path.resolve(
    output ?? path.join(path.dirname(loaded.manifestPath), "output"),
  );
  let last = -1;
  const result = await renderProject(loaded.project, loaded.assets, {
    outputDir,
    fontPath,
    signal,
    onProgress(progress) {
      if (progress === last) return;
      last = progress;
      process.stderr.write(
        json
          ? JSON.stringify({ event: "render_progress", progress }) + "\n"
          : `合成进度 ${progress}%\n`,
      );
    },
  });
  const srt = result.path.replace(/\.mp4$/, ".srt");
  const [videoStat, subtitleStat] = await Promise.all([
    fs.stat(result.path),
    fs.stat(srt),
  ]);
  return {
    ok: true,
    manifest: loaded.manifestPath,
    mp4: result.path,
    srt,
    duration: loaded.duration,
    aspect: loaded.manifest.aspect,
    shots: loaded.project.shots.length,
    bytes: { mp4: videoStat.size, srt: subtitleStat.size },
  };
}

async function demo(directory: string, signal: AbortSignal, json: boolean) {
  const base = path.resolve(directory);
  await fs.mkdir(base); // Refuse to overwrite even an existing empty folder.
  const binary = await ensureFFmpeg(signal);
  const media = path.join(base, "media");
  await fs.mkdir(media);
  const options = {
    timeout: 30_000,
    maxBuffer: 4 * 1024 ** 2,
    signal,
    windowsHide: true,
  };
  for (const [name, color] of [
    ["shot-01.png", "0x155e52"],
    ["shot-02.png", "0xa77743"],
  ]) {
    await exec(
      binary,
      [
        "-hide_banner",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=640x360`,
        "-frames:v",
        "1",
        "-threads",
        "1",
        path.join(media, name),
      ],
      options,
    );
  }
  await exec(
    binary,
    [
      "-hide_banner",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "2",
      path.join(media, "test-tone.wav"),
    ],
    options,
  );
  const manifest = path.join(base, "project.json");
  await fs.writeFile(
    manifest,
    JSON.stringify(
      {
        version: 1,
        name: "森映云端合成测试",
        aspect: "9:16",
        fit: "contain",
        burnCaptions: true,
        shots: [
          {
            file: "media/shot-01.png",
            duration: 1,
            caption: "森映 · Linux 云端合成测试",
            prompt: "测试色板，不是 Muse 生成结果",
          },
          {
            file: "media/shot-02.png",
            duration: 1,
            caption: "中文字幕、音轨、MP4 与 SRT",
            prompt: "测试色板，不是 Muse 生成结果",
          },
        ],
        audio: "media/test-tone.wav",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  return {
    ...(await render(manifest, undefined, signal, json)),
    testOnly: true,
    note: "色板与提示音用于验证真实合成流程，不是 Muse 生成作品。",
  };
}

export async function main(argv: string[]) {
  let json = argv.includes("--json");
  let command = argv[0] ?? "help";
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("操作已取消。"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean" },
        prepare: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        output: { type: "string" },
        name: { type: "string" },
        aspect: { type: "string" },
      },
    });
    json = values.json ?? false;
    command = positionals[0] ?? "help";
    if (values.help || command === "help") {
      process.stdout.write(
        json ? JSON.stringify({ ok: true, help }) + "\n" : help + "\n",
      );
      return;
    }
    if (!["doctor", "init", "validate", "render", "demo"].includes(command))
      throw new Error(`未知命令：${command}。用 --help 查看帮助。`);
    if (positionals.length !== (command === "doctor" ? 1 : 2))
      throw new Error(
        `${command} ${command === "doctor" ? "不接受路径参数" : "需要且只接受一个目录或清单路径"}。`,
      );
    const allowed: Record<string, string[]> = {
      doctor: ["prepare"],
      init: ["name", "aspect"],
      validate: [],
      render: ["output"],
      demo: [],
    };
    for (const key of Object.keys(values))
      if (!["json", "help", ...allowed[command]].includes(key))
        throw new Error(`${command} 不支持 --${key}。`);
    let result: Record<string, unknown>;
    switch (command) {
      case "doctor":
        result = await doctor(values.prepare ?? false, controller.signal);
        break;
      case "init":
        result = await initialize(
          positionals[1],
          values.name ?? "我的视频",
          values.aspect ?? "9:16",
        );
        break;
      case "validate": {
        const loaded = await verify(positionals[1], controller.signal);
        result = {
          ok: true,
          manifest: loaded.manifestPath,
          shots: loaded.project.shots.length,
          assets: loaded.assets.length,
          duration: loaded.duration,
          aspect: loaded.manifest.aspect,
        };
        break;
      }
      case "render":
        result = await render(
          positionals[1],
          values.output,
          controller.signal,
          json,
        );
        break;
      default:
        result = await demo(positionals[1], controller.signal, json);
    }
    if (result.ok === false) process.exitCode = 1;
    process.stdout.write(
      JSON.stringify({ command, ...result }, null, json ? undefined : 2) + "\n",
    );
  } catch (error) {
    process.exitCode = controller.signal.aborted ? 130 : 1;
    const value = error as NodeJS.ErrnoException;
    const message =
      value.code === "EEXIST"
        ? "目标项目或目录已存在。请选择新目录，避免覆盖已有作品。"
        : value.message;
    const result = {
      ok: false,
      command,
      error: {
        code: controller.signal.aborted
          ? "CANCELLED"
          : (value.code ?? "INVALID_INPUT_OR_ENVIRONMENT"),
        message,
      },
    };
    if (json) process.stdout.write(JSON.stringify(result) + "\n");
    else process.stderr.write(message + "\n");
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
