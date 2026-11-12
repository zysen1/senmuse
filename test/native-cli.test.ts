import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const HELP = `Usage: media-generation [OPTIONS]\n  --media-subagent-output-type <TYPE> [possible values: image, video]\n  --conversation-json <JSON>\n  --output-dir <DIR>\n  --orientation <VALUE> [possible values: square, landscape, vertical]\n  --image-file <FILE>\n  --timeout-secs <SECONDS>\n`;

async function fixture(help = HELP, behavior = "success") {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "senmuse-native-cli-test-"),
  );
  roots.push(root);
  const binary = path.join(root, "media-generation");
  const outputDir = path.join(root, "output");
  await mkdir(outputDir);
  const code = `#!${process.execPath}\nimport fs from 'node:fs'; import path from 'node:path';
  const args=process.argv.slice(2);
  if(args.includes('--help')) console.log(${JSON.stringify(help)});
  else {
    fs.writeFileSync(${JSON.stringify(path.join(root, "args.json"))},JSON.stringify(args));
    if(${JSON.stringify(behavior)} === 'error') { console.log(JSON.stringify({error_code:'video_not_available',error_message:'Video unavailable for this account'})); process.exitCode=1; }
    else {
      const out=args[args.indexOf('--output-dir')+1]; const file=path.join(out,'fixture.png');
      fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3f8AAAAASUVORK5CYII=','base64'));
      console.log(JSON.stringify({media_paths:[file],artifact_ids:['fixture-handle']}));
    }
  }`;
  await writeFile(binary, code);
  await chmod(binary, 0o700);
  const call = (input: unknown) =>
    new Promise<{
      code: number | null;
      events: Record<string, unknown>[];
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.resolve("scripts/muse-native.mjs")],
        {
          env: { ...process.env, SENMUSE_NATIVE_BIN: binary },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        try {
          resolve({
            code,
            stderr,
            events: stdout
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          });
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(
        JSON.stringify({
          protocol: "senmuse-provider-v1",
          ...(input as object),
        }),
      );
    });
  return { root, outputDir, call };
}

describe.skipIf(process.platform === "win32")(
  "installed Muse media CLI adapter (Linux/macOS process contract)",
  () => {
    it("enables only modes explicitly exposed by compatible help without generating", async () => {
      const { root, call } = await fixture();
      const result = await call({ operation: "capabilities" });
      expect(result.code).toBe(0);
      expect(result.events[0]).toMatchObject({
        type: "capabilities",
        state: "ready",
        capabilities: ["image", "video"],
        aspects: ["9:16", "16:9", "1:1"],
      });
      await expect(
        readFile(path.join(root, "args.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not enable a version missing the documented structured prompt flag", async () => {
      const { call } = await fixture(
        HELP.replace("--conversation-json <JSON>\n", ""),
      );
      const result = await call({ operation: "capabilities" });
      expect(result.events[0]).toMatchObject({
        state: "unconfigured",
        capabilities: [],
      });
    });

    it("passes prompts as data and validates actual native output files", async () => {
      const { root, outputDir, call } = await fixture();
      const prompt = '猫； $(touch should-not-exist) "quote"';
      const result = await call({
        operation: "generate",
        outputDir,
        request: { kind: "image", prompt, aspect: "9:16", references: [] },
      });
      expect(result.code).toBe(0);
      const args = JSON.parse(
        await readFile(path.join(root, "args.json"), "utf8"),
      ) as string[];
      expect(JSON.parse(args[args.indexOf("--conversation-json") + 1])).toEqual(
        [{ text: prompt }],
      );
      expect(args[args.indexOf("--orientation") + 1]).toBe("vertical");
      const last = result.events.at(-1)!;
      expect(last.type).toBe("result");
      const files = last.files as { path: string; mime: string }[];
      expect(files[0].mime).toBe("image/png");
      expect(
        files[0].path.startsWith((await realpath(outputDir)) + path.sep),
      ).toBe(true);
      expect((await readFile(files[0].path)).length).toBeGreaterThan(16);
    });

    it("does not silently accept an unsupported fixed duration", async () => {
      const { root, outputDir, call } = await fixture();
      const result = await call({
        operation: "generate",
        outputDir,
        request: { kind: "video", prompt: "test", duration: 20 },
      });
      expect(result.code).toBe(1);
      expect(result.events.at(-1)).toMatchObject({
        type: "error",
        message: expect.stringContaining("duration"),
      });
      await expect(
        readFile(path.join(root, "args.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("returns the actual native refusal without pretending success", async () => {
      const { outputDir, call } = await fixture(HELP, "error");
      const result = await call({
        operation: "generate",
        outputDir,
        request: { kind: "video", prompt: "test" },
      });
      expect(result.code).toBe(1);
      expect(result.events.at(-1)).toMatchObject({
        type: "error",
        message: expect.stringContaining("Video unavailable for this account"),
      });
      expect(result.events.some((event) => event.type === "result")).toBe(
        false,
      );
    });
  },
);
