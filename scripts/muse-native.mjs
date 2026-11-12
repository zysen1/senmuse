#!/usr/bin/env node
// Native Muse media CLI adapter. Only executes a CLI already installed on this host.
// Contract evidence and limitations: docs/MUSE_API.md.
import { spawn } from "node:child_process";
import { access, mkdtemp, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mediaType } from "../src/api/validation.ts";

const REQUIRED_FLAGS = [
  "--media-subagent-output-type",
  "--conversation-json",
  "--output-dir",
];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
let activeChild;
let stopping = false;

export function interpretHelp(help) {
  const flags = new Set(help.match(/--[a-z][a-z0-9-]*/g) || []);
  const missing = REQUIRED_FLAGS.filter((flag) => !flags.has(flag));
  const block = (flag) => {
    const index = help.indexOf(flag);
    if (index < 0) return "";
    return help.slice(index).split(/\n\s*(?:-\w,\s*)?--/)[0];
  };
  const modes = block("--media-subagent-output-type");
  const capabilities = missing.length
    ? []
    : ["image", "video"].filter((kind) =>
        new RegExp(`\\b${kind}\\b`, "i").test(modes),
      );
  const orientation = block("--orientation");
  const orientations = ["square", "landscape", "vertical", "portrait"].filter(
    (value) => new RegExp(`\\b${value}\\b`, "i").test(orientation),
  );
  return { flags, capabilities, orientations, missing };
}

export async function inspectRuntime() {
  const configured = process.env.SENMUSE_NATIVE_BIN;
  if (configured && !path.isAbsolute(configured))
    return {
      state: "unconfigured",
      message: "SENMUSE_NATIVE_BIN 必须是本机媒体命令的绝对路径",
      capabilities: [],
    };
  const candidates = configured
    ? [configured]
    : [
        "/opt/hatch/bin/media-generation",
        "/opt/muse/bin/media-generation",
        ...(process.env.PATH || "")
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.resolve(dir, "media-generation")),
      ];
  let executable;
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) {
        executable = candidate;
        break;
      }
    } catch {}
  }
  if (!executable)
    return {
      state: "unconfigured",
      message:
        "当前主机没有可执行的 media-generation；需要在 Muse Linux 云主机运行，或用 SENMUSE_NATIVE_BIN 指定实际已安装命令",
      capabilities: [],
    };
  try {
    const result = await command(executable, ["--help"], 8_000, 128 * 1024);
    if (result.code !== 0)
      throw new Error(`本机媒体命令 --help 失败（退出码 ${result.code}）`);
    const parsed = interpretHelp(`${result.stdout}\n${result.stderr}`);
    if (!parsed.capabilities.length)
      return {
        state: "unconfigured",
        capabilities: [],
        executable,
        message: parsed.missing.length
          ? `本机 CLI 缺少兼容参数：${parsed.missing.join("、")}`
          : "本机帮助未明确列出 image/video 输出类型，无法确认兼容契约；请运行组件探测核对版本",
      };
    const aspects = parsed.flags.has("--orientation")
      ? [
          ...(parsed.orientations.some((value) =>
            ["vertical", "portrait"].includes(value),
          )
            ? ["9:16"]
            : []),
          ...(parsed.orientations.includes("landscape") ? ["16:9"] : []),
          ...(parsed.orientations.includes("square") ? ["1:1"] : []),
        ]
      : [];
    return {
      state: "ready",
      message:
        "原生媒体 CLI 已就绪；账户生成权限与剩余额度未知，以实际调用结果为准",
      capabilities: parsed.capabilities,
      aspects,
      executable,
      ...parsed,
    };
  } catch (error) {
    return {
      state: "error",
      message: safe(error),
      capabilities: [],
      executable,
    };
  }
}

export function generationArgs(request, runtime, outputDir) {
  if (
    !request ||
    !runtime.capabilities.includes(request.kind) ||
    !["image", "video"].includes(request.kind)
  )
    throw new Error(
      "当前本机媒体 CLI 没有声明此生成类型；原生模式尚不提供改片或续拍",
    );
  if (typeof request.prompt !== "string" || !request.prompt.trim())
    throw new Error("生成提示词不能为空");
  if (request.duration !== undefined)
    throw new Error(
      "当前原生 CLI 的固定时长契约未确认，请省略 duration；实际时长由 Muse 返回",
    );
  if (request.conversationId !== undefined)
    throw new Error("当前原生 CLI 不支持通过 conversationId 续接生成");
  const references = request.references || [];
  if (!Array.isArray(references) || references.length > 4)
    throw new Error("参考图片最多 4 张");
  if (references.length && !runtime.flags.has("--image-file"))
    throw new Error("当前 CLI 未声明 --image-file，不能传入参考图片");
  const args = [
    "--media-subagent-output-type",
    request.kind,
    "--conversation-json",
    JSON.stringify([{ text: request.prompt }]),
    "--output-dir",
    outputDir,
  ];
  if (runtime.flags.has("--timeout-secs")) args.push("--timeout-secs", "1200");
  if (request.aspect !== undefined) {
    const choices = {
      "1:1": ["square"],
      "16:9": ["landscape"],
      "9:16": ["vertical", "portrait"],
    }[request.aspect];
    const orientation = choices?.find((value) =>
      runtime.orientations.includes(value),
    );
    if (!runtime.flags.has("--orientation") || !orientation)
      throw new Error(
        `当前 CLI 帮助没有确认 ${request.aspect} 对应的画幅参数，请省略 aspect 或核对版本`,
      );
    args.push("--orientation", orientation);
  }
  for (const reference of references) {
    if (
      typeof reference.path !== "string" ||
      !path.isAbsolute(reference.path) ||
      !reference.mime?.startsWith("image/")
    )
      throw new Error("原生生图/生视频仅接受已上传图片作为参考");
    args.push("--image-file", reference.path);
  }
  return args;
}

async function generate(request, outputDir, runtime) {
  if (typeof outputDir !== "string" || !path.isAbsolute(outputDir))
    throw new Error("outputDir 必须是绝对路径");
  const root = await realpath(outputDir);
  const stage = await mkdtemp(path.join(root, ".native-"));
  const args = generationArgs(request, runtime, stage);
  // Preserve the current runtime identity without printing or discovering credentials.
  if (runtime.flags.has("--user-id") && process.env.JARVIS_USER_ID)
    args.push("--user-id", process.env.JARVIS_USER_ID);
  emit({
    type: "progress",
    message: `正在调用 Muse 原生${request.kind === "image" ? "生图" : "视频"}组件；等待真实文件`,
  });
  const result = await command(
    runtime.executable,
    args,
    25 * 60_000,
    8 * 1024 * 1024,
  );
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      result.code === 0
        ? "本机媒体组件未返回可识别的 JSON；请检查 Muse 中是否已生成，不要重复提交"
        : `本机媒体组件失败（退出码 ${result.code}）：${safe(result.stderr || "没有返回结构化错误")}`,
    );
  }
  if (
    result.code !== 0 ||
    data.error_code ||
    data.error ||
    data.success === false
  ) {
    const detail =
      data.error_message ||
      data.error?.message ||
      data.error ||
      result.stderr ||
      `退出码 ${result.code}`;
    throw new Error(
      `Muse 原生媒体生成失败：${safe(typeof detail === "string" ? detail : JSON.stringify(detail))}`,
    );
  }
  if (
    !Array.isArray(data.media_paths) ||
    !data.media_paths.length ||
    data.media_paths.length > 20
  )
    throw new Error(
      "本机媒体组件没有返回 media_paths；不能把请求接受或 JSON 旁车文件当作素材成功",
    );
  const files = [];
  for (const value of data.media_paths) {
    if (typeof value !== "string")
      throw new Error("本机媒体组件返回了无效的素材路径");
    const candidates = path.isAbsolute(value)
      ? [value]
      : [path.resolve(value), path.resolve(stage, value)];
    let resolved;
    for (const candidate of [...new Set(candidates)]) {
      try {
        const real = await realpath(candidate);
        const relative = path.relative(stage, real);
        if (
          relative &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        ) {
          resolved = real;
          break;
        }
      } catch {}
    }
    if (!resolved)
      throw new Error("本机媒体组件返回的文件不在本次生成目录内或尚不存在");
    const info = await stat(resolved);
    if (!info.isFile() || !info.size || info.size > 200 * 1024 * 1024)
      throw new Error("生成素材需要是非空且不超过 200 MiB 的常规文件");
    const handle = await open(resolved, "r");
    let type;
    try {
      const bytes = Buffer.alloc(16);
      const { bytesRead } = await handle.read(bytes, 0, 16, 0);
      type = mediaType(bytes.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
    if (!type || !type.mime.startsWith(`${request.kind}/`))
      throw new Error(`本机组件没有返回要求的 ${request.kind} 媒体文件`);
    files.push({
      path: resolved,
      mime: type.mime,
      name: path.basename(resolved),
    });
  }
  return { files };
}

function safe(value) {
  return String(value instanceof Error ? value.message : value)
    .replace(/(?:https?|wss?):\/\/\S+/gi, "[服务地址]")
    .replace(
      /(?:Bearer\s+|(?:token|secret|password|api[_-]?key)[=:]\s*)[^\s,;]+/gi,
      "[已隐藏认证信息]",
    )
    .slice(0, 1200);
}

function command(executable, args, timeout, maxBytes) {
  return new Promise((resolve, reject) => {
    if (stopping) {
      reject(new Error("已停止本地等待；远端生成可能继续"));
      return;
    }
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure;
    const terminate = () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
      timer.unref();
      child.once("close", () => clearTimeout(timer));
    };
    const timer = setTimeout(() => {
      failure = new Error("本机媒体组件超时；请检查已有结果后再决定是否重试");
      terminate();
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        failure = new Error("本机媒体组件输出超出限制；请检查已有结果");
        terminate();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      if (failure) reject(failure);
      else if (stopping || signal)
        reject(new Error("本机媒体进程已停止；远端生成状态需要检查"));
      else resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      stopping = true;
      if (activeChild) {
        const child = activeChild;
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
        timer.unref();
        child.once("close", () => clearTimeout(timer));
      } else process.exitCode = 1;
    });
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 1024 * 1024)
        throw new Error("适配器请求过大");
    }
    const input = JSON.parse(raw);
    if (input.protocol !== "senmuse-provider-v1")
      throw new Error("不支持的适配器协议");
    if (!["capabilities", "generate"].includes(input.operation))
      throw new Error("不支持的适配器操作");
    const runtime = await inspectRuntime();
    if (input.operation === "capabilities") {
      emit({
        type: "capabilities",
        state: runtime.state,
        message: runtime.message,
        capabilities: runtime.capabilities,
        ...(runtime.aspects ? { aspects: runtime.aspects } : {}),
      });
    } else {
      if (runtime.state !== "ready") throw new Error(runtime.message);
      emit({
        type: "result",
        ...(await generate(input.request, input.outputDir, runtime)),
      });
    }
  } catch (error) {
    emit({ type: "error", message: safe(error) });
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
