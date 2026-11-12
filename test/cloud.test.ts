import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ensureFFmpeg, ffmpegPath } from "../src/main/ffmpeg";
import { parseManifest } from "../src/cloud/manifest";

const exec = promisify(execFile);
let directory: string;
let entry: string;
let environment: NodeJS.ProcessEnv;
beforeAll(async () => {
  await ensureFFmpeg();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "senmuse-cloud-"));
  const checkout = path.join(directory, "无依赖仓库");
  // Deliberately exclude node_modules and dist: this is the repository-only Linux flow.
  for (const file of [
    "scripts/senmuse.mjs",
    "src/cloud/cli.ts",
    "src/cloud/manifest.ts",
    "src/main/render.ts",
    "src/main/ffmpeg.ts",
    "src/shared/types.ts",
    "assets/fonts/NotoSansCJKsc-Regular.otf",
  ]) {
    const target = path.join(checkout, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.resolve(file), target);
  }
  await fs.writeFile(path.join(checkout, "package.json"), '{"type":"module"}');
  entry = path.join(checkout, "scripts/senmuse.mjs");
  environment = {
    ...process.env,
    SENMUSE_FFMPEG: ffmpegPath(),
    SENMUSE_CACHE_DIR: path.join(directory, "cache"),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
}, 300_000);
afterAll(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

async function cli(args: string[], env = environment) {
  try {
    const result = await exec(process.execPath, [entry, ...args, "--json"], {
      cwd: directory,
      env,
      timeout: 60_000,
    });
    return { code: 0, value: JSON.parse(result.stdout) };
  } catch (error) {
    const result = error as { code: number; stdout: string };
    return { code: result.code, value: JSON.parse(result.stdout) };
  }
}

it("runs without installed packages and renders real media from another working directory", async () => {
  const status = await cli(["doctor"]);
  expect(status).toMatchObject({
    code: 0,
    value: { ok: true, font: { available: true } },
  });
  const demo = await cli(["demo", path.join(directory, "真实 云端测试")]);
  expect(demo).toMatchObject({
    code: 0,
    value: { ok: true, duration: 2, testOnly: true, aspect: "9:16" },
  });
  const { stderr } = await exec(ffmpegPath(), [
    "-hide_banner",
    "-i",
    demo.value.mp4,
    "-t",
    "0",
    "-f",
    "null",
    "-",
  ]);
  expect(stderr).toMatch(/1080x1920/);
  expect(stderr).toMatch(/Duration: 00:00:02/);
  expect(stderr).toMatch(/Audio: aac/);
  expect(await fs.readFile(demo.value.srt, "utf8")).toContain(
    "Linux 云端合成测试",
  );
  expect((await cli(["validate", demo.value.manifest])).value).toMatchObject({
    ok: true,
    shots: 2,
  });
}, 60_000);

it("does not overwrite existing projects and reports incomplete projects honestly", async () => {
  const project = path.join(directory, "existing");
  const first = await cli(["init", project, "--name", "保留的项目"]);
  expect(first.value.readyToRender).toBe(false);
  const before = await fs.readFile(first.value.manifest, "utf8");
  expect((await cli(["init", project])).code).toBe(1);
  expect(await fs.readFile(first.value.manifest, "utf8")).toBe(before);
  expect((await cli(["validate", first.value.manifest])).value.ok).toBe(false);
});

it("rejects remote media, invalid durations and unsupported options without rendering", async () => {
  const manifest = {
    version: 1,
    name: "test",
    aspect: "9:16",
    fit: "contain",
    burnCaptions: true,
    shots: [
      { file: "https://example.com/video.mp4", duration: 3, caption: "" },
    ],
  };
  expect(() => parseManifest(manifest)).toThrow("本地文件");
  expect(() =>
    parseManifest({
      ...manifest,
      shots: [{ file: "shot.mp4", duration: 0, caption: "" }],
    }),
  ).toThrow("0.1");
  expect(() =>
    parseManifest({
      ...manifest,
      aspect: ["9:16"],
      shots: [{ file: "shot.mp4", duration: 3 }],
    }),
  ).toThrow("aspect");
  const result = await cli(["doctor", "--output", "ignored"]);
  expect(result.code).toBe(1);
  expect(result.value.error.message).toContain("不支持");
});

it("reports an invalid explicit tool and corrupt media as failed CLI calls", async () => {
  const invalidTool = await cli(["doctor", "--prepare"], {
    ...environment,
    SENMUSE_FFMPEG: directory,
  });
  expect(invalidTool).toMatchObject({ code: 1, value: { ok: false } });
  expect(invalidTool.value.error.message).toContain("SENMUSE_FFMPEG");
  const base = path.join(directory, "corrupt");
  await fs.mkdir(base);
  await fs.writeFile(path.join(base, "broken.mp4"), "not a video");
  const manifest = path.join(base, "project.json");
  await fs.writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      name: "bad",
      aspect: "9:16",
      fit: "contain",
      burnCaptions: false,
      shots: [{ file: "broken.mp4", duration: 1, caption: "" }],
    }),
  );
  const result = await cli(["render", manifest]);
  expect(result).toMatchObject({ code: 1, value: { ok: false } });
  expect(result.value.error.message).toMatch(/moov|Invalid data/i);
  expect(await fs.readdir(base)).toEqual(
    expect.arrayContaining(["broken.mp4", "project.json"]),
  );
  expect(await fs.stat(path.join(base, "output")).catch(() => null)).toBeNull();
});

it.skipIf(process.platform === "win32")(
  "repairs a verified cache whose executable bit was lost, without downloading",
  async () => {
    const cache = path.join(directory, "permission-cache");
    const platform = `${process.platform}-${process.arch}`;
    const archiveChecksums: Record<string, string> = {
      "darwin-arm64":
        "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
      "darwin-x64":
        "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
      "linux-arm64":
        "754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0",
      "linux-x64":
        "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
    };
    const cached = path.join(cache, `ffmpeg-b6.1.1-${platform}`);
    await fs.mkdir(cached, { recursive: true });
    const binary = path.join(cached, "ffmpeg");
    // An executable fixture is enough here: real encoding is covered above.
    const contents = `#!${process.execPath}\nconsole.log('ffmpeg cache fixture\\n libx264 \\n aac \\n subtitles V->V');\n`;
    await fs.writeFile(binary, contents, { mode: 0o644 });
    await fs.writeFile(
      path.join(cached, "verified.json"),
      JSON.stringify({
        archiveSha256: archiveChecksums[platform],
        binarySha256: createHash("sha256").update(contents).digest("hex"),
      }),
    );
    const env: NodeJS.ProcessEnv = {
      ...environment,
      PATH: "",
      SENMUSE_CACHE_DIR: cache,
    };
    delete env.SENMUSE_FFMPEG;
    expect(await cli(["doctor"], env)).toMatchObject({
      code: 1,
      value: { ok: false, ffmpeg: null },
    });
    expect(await cli(["doctor", "--prepare"], env)).toMatchObject({
      code: 0,
      value: { ok: true, ffmpeg: { path: binary } },
    });
    expect(await cli(["doctor"], env)).toMatchObject({
      code: 0,
      value: { ok: true },
    });
    expect(await fs.readFile(binary, "utf8")).toBe(contents);
  },
);

it.skipIf(process.platform === "win32")(
  "cancels an active render on SIGTERM and removes partial output",
  async () => {
    const base = path.join(directory, "cancel");
    await fs.mkdir(base);
    await exec(ffmpegPath(), [
      "-hide_banner",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180",
      "-frames:v",
      "1",
      "-threads",
      "1",
      path.join(base, "shot.png"),
    ]);
    const manifest = path.join(base, "project.json");
    const output = path.join(base, "output");
    await fs.writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        name: "cancel",
        aspect: "9:16",
        fit: "contain",
        burnCaptions: false,
        shots: [{ file: "shot.png", duration: 120, caption: "" }],
      }),
    );
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      cancelled: boolean;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [entry, "render", manifest, "--json"],
        { cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "",
        cancelled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI did not cancel promptly"));
      }, 15_000);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (!cancelled && stderr.includes('"progress":3')) {
          cancelled = true;
          child.kill("SIGTERM");
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, cancelled });
      });
    });
    expect(result).toMatchObject({ code: 130, cancelled: true });
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "CANCELLED" },
    });
    expect(await fs.readdir(output)).toEqual([]);
    expect((await fs.stat(path.join(base, "shot.png"))).size).toBeGreaterThan(
      0,
    );
  },
  20_000,
);
