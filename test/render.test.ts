import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegPath, renderProject } from "../src/main/render";
import type { Asset, Project } from "../src/shared/types";

const exec = promisify(execFile);
let directory: string;
let assets: Asset[];

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "test-project",
    name: "中文合成验证",
    aspect: "9:16",
    fit: "contain",
    burnCaptions: true,
    revision: 0,
    updatedAt: Date.now(),
    shots: [
      {
        id: "one",
        prompt: "",
        caption: "第一镜 · 保留完整构图",
        duration: 0.6,
        assetId: "image",
      },
      {
        id: "two",
        prompt: "",
        caption: "第二镜 · 视频与原声",
        duration: 0.8,
        assetId: "video",
      },
    ],
    ...overrides,
  };
}

async function probe(
  file: string,
): Promise<{
  duration: number;
  width: number;
  height: number;
  audio: boolean;
}> {
  const { stderr } = await exec(ffmpegPath(), [
    "-hide_banner",
    "-i",
    file,
    "-t",
    "0",
    "-f",
    "null",
    "-",
  ]);
  const dimensions = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!dimensions || !duration) throw new Error(stderr);
  return {
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
    duration:
      Number(duration[1]) * 3600 +
      Number(duration[2]) * 60 +
      Number(duration[3]),
    audio: /Stream #[^\n]*Audio:/.test(stderr),
  };
}

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "senmuse-render-test-"));
  const image = path.join(directory, "fixture.png");
  const video = path.join(directory, "fixture.mp4");
  const audio = path.join(directory, "voice.wav");
  await exec(ffmpegPath(), [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x155e52:s=320x180",
    "-frames:v",
    "1",
    image,
  ]);
  await exec(ffmpegPath(), [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=320x180:r=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "0.3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    video,
  ]);
  await exec(ffmpegPath(), [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000",
    "-t",
    "0.2",
    audio,
  ]);
  assets = [
    {
      id: "image",
      kind: "image",
      name: "参考图.png",
      path: image,
      url: "",
      createdAt: 0,
    },
    {
      id: "video",
      kind: "video",
      name: "原声视频.mp4",
      path: video,
      url: "",
      createdAt: 0,
    },
    {
      id: "audio",
      kind: "audio",
      name: "配音.wav",
      path: audio,
      url: "",
      createdAt: 0,
    },
  ];
}, 30_000);

afterAll(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

describe("真实 FFmpeg 合成", () => {
  it("joins image and short video into a 1080 × 1920 clip, pads duration, burns Chinese captions and exports SRT", async () => {
    const progress: number[] = [];
    const result = await renderProject(project(), assets, {
      outputDir: directory,
      onProgress: (n) => progress.push(n),
    });
    const info = await probe(result.path);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.duration).toBeCloseTo(1.4, 1);
    expect(info.audio).toBe(true);
    expect(progress.at(-1)).toBe(100);
    const srt = await fs.readFile(
      result.path.replace(/\.mp4$/, ".srt"),
      "utf8",
    );
    expect(srt).toContain("00:00:00,600 --> 00:00:01,400");
    expect(srt).toContain("第一镜");
    const files = await fs.readdir(directory);
    expect(files.some((name) => name.startsWith(".senmuse-render-"))).toBe(
      false,
    );
  }, 60_000);

  it("exports a square crop with a replacement audio track and unburned subtitles", async () => {
    const result = await renderProject(
      project({
        aspect: "1:1",
        fit: "cover",
        audioAssetId: "audio",
        burnCaptions: false,
        shots: [
          {
            id: "one",
            prompt: "",
            caption: "可以单独修改的字幕",
            duration: 0.5,
            assetId: "video",
          },
        ],
      }),
      assets,
      { outputDir: directory, onProgress: () => {} },
    );
    const info = await probe(result.path);
    expect(info).toMatchObject({ width: 1080, height: 1080, audio: true });
    expect(info.duration).toBeCloseTo(0.5, 1);
    expect(
      await fs.readFile(result.path.replace(/\.mp4$/, ".srt"), "utf8"),
    ).toContain("可以单独修改的字幕");
  }, 60_000);

  it("rejects missing assets and non-finite durations without leaving render directories", async () => {
    await expect(
      renderProject(
        project({ shots: [{ id: "x", prompt: "", caption: "", duration: 3 }] }),
        assets,
        { outputDir: directory, onProgress: () => {} },
      ),
    ).rejects.toThrow("没有图片或视频素材");
    await expect(
      renderProject(
        project({
          shots: [
            {
              id: "x",
              prompt: "",
              caption: "",
              duration: Number.NaN,
              assetId: "image",
            },
          ],
        }),
        assets,
        { outputDir: directory, onProgress: () => {} },
      ),
    ).rejects.toThrow("时长");
  });

  it("cleans unfinished export on cancellation", async () => {
    const controller = new AbortController();
    const before = (await fs.readdir(directory)).sort();
    await expect(
      renderProject(project(), assets, {
        outputDir: directory,
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress === 3) controller.abort();
        },
      }),
    ).rejects.toThrow(/abort|取消/i);
    expect((await fs.readdir(directory)).sort()).toEqual(before);
  }, 30_000);
});
