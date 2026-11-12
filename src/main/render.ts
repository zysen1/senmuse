import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Asset, Project } from "../shared/types";
import { ensureFFmpeg, ffmpegPath } from "./ffmpeg.ts";
export { ffmpegPath } from "./ffmpeg.ts";

interface RenderOptions {
  outputDir: string;
  onProgress: (progress: number) => void;
  signal?: AbortSignal;
  fontPath?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const FORMATS = {
  "9:16": { width: 1080, height: 1920, fontSize: 48, marginV: 220 },
  "16:9": { width: 1920, height: 1080, fontSize: 48, marginV: 85 },
  "1:1": { width: 1080, height: 1080, fontSize: 44, marginV: 110 },
} as const;

function run(
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  } = {},
): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      killTimer.unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout = (stdout + chunk).slice(-64_000);
      options.onOutput?.(chunk);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-64_000);
    });
    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new Error(`无法启动视频合成工具。${error.message}`));
    });
    child.once("close", (code) => {
      cleanup();
      if (options.signal?.aborted) {
        reject(new Error("视频导出已取消。"));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = stderr.trim().split("\n").slice(-6).join("\n");
        reject(new Error(`视频合成失败，请检查素材是否可以播放。\n${detail}`));
      }
    });
  });
}

function timestamp(seconds: number, ass = false): string {
  const unit = ass ? 100 : 1000;
  const total = Math.round(seconds * unit);
  const hour = Math.floor(total / (3600 * unit));
  const minute = Math.floor(total / (60 * unit)) % 60;
  const second = Math.floor(total / unit) % 60;
  const fraction = total % unit;
  return `${ass ? hour : String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${ass ? "." : ","}${String(fraction).padStart(ass ? 2 : 3, "0")}`;
}

function captionText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function subtitles(project: Project): { srt: string; ass: string } {
  const format = FORMATS[project.aspect];
  const font = "Noto Sans CJK SC";
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${format.width}`,
    `PlayResY: ${format.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${font},${format.fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H90000000,0,0,0,0,100,100,0,0,1,3,1,2,70,90,${format.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const entries: string[] = [];
  let elapsed = 0;
  for (const shot of project.shots) {
    const end = elapsed + shot.duration;
    const caption = captionText(shot.caption);
    if (caption) {
      entries.push(
        `${entries.length + 1}\n${timestamp(elapsed)} --> ${timestamp(end)}\n${caption}\n`,
      );
      // Full-width replacements prevent caption content being interpreted as ASS override commands.
      const assText = caption
        .replace(/\\/g, "＼")
        .replace(/\{/g, "｛")
        .replace(/\}/g, "｝")
        .replace(/\n/g, "\\N");
      lines.push(
        `Dialogue: 0,${timestamp(elapsed, true)},${timestamp(end, true)},Default,,0,0,0,,${assText}`,
      );
    }
    elapsed = end;
  }
  return {
    srt: "\uFEFF" + entries.join("\n"),
    ass: "\uFEFF" + lines.join("\n") + "\n",
  };
}

export async function inspectAsset(
  asset: Asset,
  signal?: AbortSignal,
): Promise<{ hasAudio: boolean }> {
  const stat = await fs.stat(asset.path).catch(() => null);
  if (!stat?.isFile() || stat.size === 0)
    throw new Error(`找不到可用素材「${asset.name}」，请重新导入。`);
  if (stat.size > 4 * 1024 ** 3)
    throw new Error(`素材「${asset.name}」超过 4 GB，请先裁剪后导入。`);
  const probe = await run(
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      asset.path,
      "-t",
      "0",
      "-f",
      "null",
      "-",
    ],
    { signal },
  );
  const hasAudio = /Stream #[^\n]*Audio:/.test(probe.stderr);
  const hasVideo = /Stream #[^\n]*Video:/.test(probe.stderr);
  if (asset.kind === "audio" && !hasAudio)
    throw new Error(`「${asset.name}」没有可读取的音轨。`);
  if (asset.kind !== "audio" && !hasVideo)
    throw new Error(`「${asset.name}」没有可读取的画面。`);
  return { hasAudio };
}

/** Each shot keeps its original audio. An optional project audio track replaces all shot audio. */
export async function renderProject(
  project: Project,
  assets: Asset[],
  options: RenderOptions,
): Promise<{ path: string; name: string }> {
  options.signal?.throwIfAborted();
  if (
    !Object.hasOwn(FORMATS, project.aspect) ||
    !["contain", "cover"].includes(project.fit)
  )
    throw new Error("请选择有效的画幅与画面适配方式。");
  if (project.shots.length === 0 || project.shots.length > 60)
    throw new Error("每个项目需要 1–60 个镜头。");
  if (
    project.shots.some(
      (shot) =>
        !Number.isFinite(shot.duration) ||
        shot.duration < 0.1 ||
        shot.duration > 120,
    )
  )
    throw new Error("每个镜头的时长需要在 0.1–120 秒之间。");
  if (
    project.shots.some(
      (shot) => typeof shot.caption !== "string" || shot.caption.length > 500,
    )
  )
    throw new Error("单个镜头字幕不能超过 500 字。");
  const totalDuration = project.shots.reduce(
    (sum, shot) => sum + shot.duration,
    0,
  );
  if (totalDuration > 1800) throw new Error("单次导出最长支持 30 分钟。");
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const shotAssets = project.shots.map((shot, index) => {
    const asset = shot.assetId ? assetMap.get(shot.assetId) : undefined;
    if (!asset || asset.kind === "audio")
      throw new Error(`第 ${index + 1} 个镜头还没有图片或视频素材。`);
    return asset;
  });
  const audioAsset = project.audioAssetId
    ? assetMap.get(project.audioAssetId)
    : undefined;
  if (project.audioAssetId && (!audioAsset || audioAsset.kind !== "audio"))
    throw new Error("项目音轨不存在，请重新选择配音或音乐。");
  options.onProgress(0);
  await ensureFFmpeg(options.signal);
  await fs.mkdir(options.outputDir, { recursive: true });
  const directory = await fs.mkdtemp(
    path.join(options.outputDir, ".senmuse-render-"),
  );
  try {
    const metadata = new Map<string, { hasAudio: boolean }>();
    for (const asset of [...shotAssets, ...(audioAsset ? [audioAsset] : [])]) {
      if (!metadata.has(asset.id))
        metadata.set(asset.id, await inspectAsset(asset, options.signal));
    }
    const captions = subtitles(project);
    await fs.writeFile(
      path.join(directory, "subtitles.srt"),
      captions.srt,
      "utf8",
    );
    await fs.writeFile(
      path.join(directory, "subtitles.ass"),
      captions.ass,
      "utf8",
    );
    const burn =
      project.burnCaptions &&
      project.shots.some((shot) => captionText(shot.caption));
    if (burn) {
      const filters = await run(["-hide_banner", "-filters"], {
        signal: options.signal,
      });
      if (!/\bsubtitles\s+V->V/.test(filters.stdout))
        throw new Error(
          "当前 FFmpeg 缺少字幕滤镜。请关闭“烧录字幕”后导出，字幕仍会保存为同名 SRT 文件。",
        );
      const appRoot = process.versions.electron
        ? (await import("electron")).app.getAppPath()
        : process.cwd();
      const fontDirectory = path.join(directory, "fonts");
      await fs.mkdir(fontDirectory);
      await fs
        .copyFile(
          options.fontPath ??
            path.join(appRoot, "assets", "fonts", "NotoSansCJKsc-Regular.otf"),
          path.join(fontDirectory, "NotoSansCJKsc-Regular.otf"),
        )
        .catch(() => {
          throw new Error(
            "缺少内置中文字幕字体，请重新安装应用或关闭烧录字幕。",
          );
        });
    }
    const input: string[] = [];
    for (const asset of shotAssets) {
      if (asset.kind === "image") input.push("-loop", "1", "-framerate", "30");
      input.push("-i", asset.path);
    }
    if (audioAsset) input.push("-i", audioAsset.path);
    const { width, height } = FORMATS[project.aspect];
    const scale =
      project.fit === "cover"
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${width}:${height}`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const graph: string[] = [];
    for (let index = 0; index < project.shots.length; index++) {
      const shot = project.shots[index];
      const asset = shotAssets[index];
      graph.push(
        `[${index}:v:0]${scale},fps=30,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=${shot.duration},trim=duration=${shot.duration},setpts=PTS-STARTPTS[v${index}]`,
      );
      if (asset.kind === "video" && metadata.get(asset.id)?.hasAudio) {
        graph.push(
          `[${index}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${shot.duration},asetpts=PTS-STARTPTS[a${index}]`,
        );
      } else {
        graph.push(
          `anullsrc=r=48000:cl=stereo,atrim=duration=${shot.duration},asetpts=PTS-STARTPTS[a${index}]`,
        );
      }
    }
    const streams = project.shots
      .map((_, index) => `[v${index}][a${index}]`)
      .join("");
    graph.push(
      `${streams}concat=n=${project.shots.length}:v=1:a=1[vconcat][aconcat]`,
    );
    if (burn)
      graph.push("[vconcat]subtitles=subtitles.ass:fontsdir=fonts[vout]");
    if (audioAsset) {
      graph.push("[aconcat]anullsink");
      graph.push(
        `[${shotAssets.length}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${totalDuration},asetpts=PTS-STARTPTS[aout]`,
      );
    }
    const args = [
      "-hide_banner",
      "-nostdin",
      "-y",
      ...input,
      "-filter_complex_threads",
      "2",
      "-filter_complex",
      graph.join(";"),
      "-map",
      burn ? "[vout]" : "[vconcat]",
      "-map",
      audioAsset ? "[aout]" : "[aconcat]",
      "-t",
      String(totalDuration),
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "21",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-progress",
      "pipe:1",
      "-nostats",
      "output.mp4",
    ];
    let progressBuffer = "";
    options.onProgress(3);
    await run(args, {
      cwd: directory,
      signal: options.signal,
      onOutput(chunk) {
        progressBuffer += chunk;
        const lines = progressBuffer.split("\n");
        progressBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^out_time_us=(\d+)$/.exec(line.trim());
          if (match)
            options.onProgress(
              Math.min(
                98,
                3 +
                  Math.round(
                    (Number(match[1]) / (totalDuration * 1_000_000)) * 95,
                  ),
              ),
            );
        }
      },
    });
    options.signal?.throwIfAborted();
    const output = path.join(directory, "output.mp4");
    const stat = await fs.stat(output);
    if (stat.size < 100) throw new Error("导出文件为空，请重试。");
    const base =
      (project.name || "森映作品")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 70) || "森映作品";
    const suffix = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${randomUUID().slice(0, 8)}`;
    const name = `${base}-${suffix}.mp4`;
    const finalPath = path.join(options.outputDir, name);
    const subtitlePath = finalPath.replace(/\.mp4$/, ".srt");
    await fs.rename(path.join(directory, "subtitles.srt"), subtitlePath);
    try {
      await fs.rename(output, finalPath);
    } catch (error) {
      await fs.rm(subtitlePath, { force: true });
      throw error;
    }
    options.onProgress(100);
    return { path: finalPath, name };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
