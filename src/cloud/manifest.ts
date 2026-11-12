import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Asset, Project } from "../shared/types.ts";

export interface Manifest {
  version: 1;
  name: string;
  aspect: Project["aspect"];
  fit: Project["fit"];
  burnCaptions: boolean;
  shots: { file: string; duration: number; caption: string; prompt?: string }[];
  audio?: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} 必须是对象。`);
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw new Error(`${label} 包含不支持的字段：${extra.join(", ")}`);
}
function string(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!allowEmpty && !value.trim()) ||
    value.includes("\0")
  )
    throw new Error(
      `${label} 需要${allowEmpty ? "" : "非空"}文本，最长 ${max} 字符。`,
    );
  return value;
}

export function parseManifest(input: unknown): Manifest {
  const data = object(input, "清单");
  keys(
    data,
    ["version", "name", "aspect", "fit", "burnCaptions", "shots", "audio"],
    "清单",
  );
  if (data.version !== 1) throw new Error("清单 version 必须为 1。");
  const name = string(data.name, "name", 100);
  if (
    typeof data.aspect !== "string" ||
    !["9:16", "16:9", "1:1"].includes(data.aspect)
  )
    throw new Error("aspect 必须是 9:16、16:9 或 1:1。");
  if (data.fit !== "contain" && data.fit !== "cover")
    throw new Error("fit 必须是 contain 或 cover。");
  if (typeof data.burnCaptions !== "boolean")
    throw new Error("burnCaptions 必须是 true 或 false。");
  if (
    !Array.isArray(data.shots) ||
    data.shots.length < 1 ||
    data.shots.length > 60
  )
    throw new Error("shots 需要 1–60 个已准备好素材的镜头。");
  const shots = data.shots.map((value, index) => {
    const label = `shots[${index}]`;
    const shot = object(value, label);
    keys(shot, ["file", "duration", "caption", "prompt"], label);
    const file = string(shot.file, `${label}.file`, 4096);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(file))
      throw new Error(
        `${label}.file 必须是本地文件；请先将生成结果保存到云主机。`,
      );
    if (
      typeof shot.duration !== "number" ||
      !Number.isFinite(shot.duration) ||
      shot.duration < 0.1 ||
      shot.duration > 120
    )
      throw new Error(`${label}.duration 必须在 0.1–120 秒之间。`);
    return {
      file,
      duration: shot.duration,
      caption: string(shot.caption ?? "", `${label}.caption`, 500, true),
      ...(shot.prompt === undefined
        ? {}
        : { prompt: string(shot.prompt, `${label}.prompt`, 12000, true) }),
    };
  });
  if (shots.reduce((sum, shot) => sum + shot.duration, 0) > 1800)
    throw new Error("单次导出最长 30 分钟。");
  const audio =
    data.audio === undefined ? undefined : string(data.audio, "audio", 4096);
  if (audio && /^[a-z][a-z0-9+.-]*:\/\//i.test(audio))
    throw new Error("audio 必须是本地文件。");
  return {
    version: 1,
    name,
    aspect: data.aspect as Project["aspect"],
    fit: data.fit,
    burnCaptions: data.burnCaptions,
    shots,
    ...(audio ? { audio } : {}),
  };
}

const IMAGES = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".gif",
  ".avif",
  ".tif",
  ".tiff",
]);
const VIDEOS = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v", ".avi"]);

export async function loadManifest(file: string) {
  const manifestPath = path.resolve(file);
  const stat = await fs.stat(manifestPath);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error("清单必须是小于 1 MB 的 JSON 文件。");
  const manifest = parseManifest(
    JSON.parse(
      (await fs.readFile(manifestPath, "utf8")).replace(/^\uFEFF/, ""),
    ),
  );
  const directory = path.dirname(manifestPath);
  const assets: Asset[] = [];
  const assetFor = async (file: string, audio = false): Promise<Asset> => {
    const target = path.resolve(directory, file);
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat?.isFile() || !stat.size)
      throw new Error(`素材不存在或为空：${target}`);
    if (stat.size > 4 * 1024 ** 3) throw new Error(`素材超过 4 GB：${target}`);
    const ext = path.extname(target).toLowerCase();
    const kind = audio
      ? "audio"
      : IMAGES.has(ext)
        ? "image"
        : VIDEOS.has(ext)
          ? "video"
          : undefined;
    if (!kind)
      throw new Error(
        `不支持的镜头素材格式：${ext}。请使用常见图片或 MP4/WebM 视频。`,
      );
    const asset: Asset = {
      id: randomUUID(),
      name: path.basename(target),
      kind,
      path: target,
      url: pathToFileURL(target).href,
      createdAt: Date.now(),
    };
    assets.push(asset);
    return asset;
  };
  const shots: Project["shots"] = [];
  for (const shot of manifest.shots) {
    const asset = await assetFor(shot.file);
    shots.push({
      id: randomUUID(),
      assetId: asset.id,
      duration: shot.duration,
      caption: shot.caption,
      prompt: shot.prompt ?? "",
    });
  }
  const audio = manifest.audio
    ? await assetFor(manifest.audio, true)
    : undefined;
  const project: Project = {
    id: randomUUID(),
    name: manifest.name,
    aspect: manifest.aspect,
    fit: manifest.fit,
    burnCaptions: manifest.burnCaptions,
    shots,
    ...(audio ? { audioAssetId: audio.id } : {}),
    revision: 0,
    updatedAt: Date.now(),
  };
  return {
    manifest,
    manifestPath,
    project,
    assets,
    duration: shots.reduce((sum, shot) => sum + shot.duration, 0),
  };
}
