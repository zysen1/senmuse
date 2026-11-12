import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

// Pinned release assets, verified against GitHub release metadata on 2026-11-12.
// Binaries are downloaded directly by the end user and are excluded from SenMuse distributions.
const RELEASE = "b6.1.1";
const ARCHIVES: Record<string, string> = {
  "darwin-arm64":
    "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
  "darwin-x64":
    "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
  "linux-arm64":
    "754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0",
  "linux-x64":
    "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
  "win32-x64":
    "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
};

let resolved: string | undefined;
let preparing: Promise<string> | undefined;

export function ffmpegPath(): string {
  if (resolved) return resolved;
  if (!process.versions.electron) {
    const local = path.resolve(
      "node_modules",
      "ffmpeg-static",
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    if (existsSync(local)) return local;
  }
  throw new Error("视频合成工具尚未准备好，请重新点击导出。");
}

async function cacheRoot(): Promise<string> {
  if (process.versions.electron) {
    const { app } = await import("electron");
    return path.join(app.getPath("userData"), "tools");
  }
  return path.join(os.tmpdir(), "senmuse-tools");
}

async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sizeLimit(maximum: number): Transform {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maximum)
        done(new Error("视频工具下载大小超出预期，请稍后重试。"));
      else done(null, chunk);
    },
  });
}

async function prepare(signal?: AbortSignal): Promise<string> {
  const platform = `${process.platform}-${process.arch}`;
  const checksum = ARCHIVES[platform];
  if (!checksum)
    throw new Error(`当前系统 ${platform} 暂不支持自动安装视频工具。`);
  const root = await cacheRoot();
  const directory = path.join(root, `ffmpeg-${RELEASE}-${platform}`);
  const executable = path.join(
    directory,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  try {
    const receipt = JSON.parse(
      await fs.readFile(path.join(directory, "verified.json"), "utf8"),
    );
    if (
      receipt.archiveSha256 === checksum &&
      receipt.binarySha256 === (await fileHash(executable))
    )
      return executable;
  } catch {
    /* An incomplete or corrupt cache is replaced by a verified download. */
  }
  await fs.mkdir(root, { recursive: true });
  const staging = await fs.mkdtemp(path.join(root, ".ffmpeg-download-"));
  const timeoutSignal = AbortSignal.timeout(240_000);
  const downloadSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}/ffmpeg-${platform}.gz`;
    const fetcher = process.versions.electron
      ? (await import("electron")).net.fetch.bind(
          (await import("electron")).net,
        )
      : fetch;
    const response = await fetcher(url, { signal: downloadSignal });
    if (!response.ok || !response.body)
      throw new Error(
        `视频工具下载失败（HTTP ${response.status}），请检查网络后重新导出。`,
      );
    const archive = path.join(staging, "ffmpeg.gz");
    await pipeline(
      Readable.fromWeb(response.body as never),
      sizeLimit(100 * 1024 ** 2),
      createWriteStream(archive),
      { signal: downloadSignal },
    );
    if ((await fileHash(archive)) !== checksum)
      throw new Error("视频工具下载校验失败，已丢弃文件，请重新导出。");
    const binary = path.join(staging, path.basename(executable));
    await pipeline(
      createReadStream(archive),
      createGunzip(),
      sizeLimit(300 * 1024 ** 2),
      createWriteStream(binary),
      { signal: downloadSignal },
    );
    await fs.chmod(binary, 0o755);
    await fs.writeFile(
      path.join(staging, "verified.json"),
      JSON.stringify({
        archiveSha256: checksum,
        binarySha256: await fileHash(binary),
        source: url,
      }),
    );
    await fs.rm(archive);
    downloadSignal.throwIfAborted();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rename(staging, directory);
    return executable;
  } catch (error) {
    if (signal?.aborted) throw new Error("视频工具下载已取消。");
    if (timeoutSignal.aborted)
      throw new Error("首次下载视频工具超时，请检查网络后重新导出。");
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Source installs use their installed helper. Packaged apps download the verified helper on first export. */
export async function ensureFFmpeg(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    return ffmpegPath();
  } catch {
    /* First export from a packaged application. */
  }
  if (process.versions.electron) {
    const { app } = await import("electron");
    const local = path.join(
      app.getAppPath(),
      "node_modules",
      "ffmpeg-static",
      process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
    );
    if (!app.isPackaged && existsSync(local)) {
      resolved = local;
      return local;
    }
  }
  if (!preparing)
    preparing = prepare(signal).finally(() => {
      preparing = undefined;
    });
  resolved = await preparing;
  signal?.throwIfAborted();
  return resolved;
}
