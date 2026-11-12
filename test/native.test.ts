import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeCommandProvider } from "../src/api/native.ts";
import type { ProviderContext, ProviderRequest } from "../src/api/types.ts";

const roots: string[] = [];
const providers: NativeCommandProvider[] = [];
const request: ProviderRequest = {
  jobId: "job-test",
  requestId: "request-test",
  kind: "video",
  prompt: "test fixture",
  referenceIds: [],
  references: [],
};
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(body: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "senmuse-native-test-"));
  roots.push(root);
  const script = path.join(root, "adapter.mjs");
  await writeFile(
    script,
    `import { writeFile, symlink } from 'node:fs/promises';\nimport path from 'node:path';\nlet stdin = ''; for await (const chunk of process.stdin) stdin += chunk; const input = JSON.parse(stdin); const send = event => process.stdout.write(JSON.stringify(event) + '\\n');\n${body}`,
  );
  const outputDir = path.join(root, "output");
  await mkdir(outputDir);
  const provider = new NativeCommandProvider({
    type: "command",
    command: process.execPath,
    args: [script],
    cwd: root,
  });
  providers.push(provider);
  let submitted = 0;
  const progress: string[] = [];
  const controller = new AbortController();
  const context: ProviderContext = {
    outputDir,
    signal: controller.signal,
    onSubmitted: () => {
      submitted++;
    },
    onProgress: (message) => progress.push(message),
  };
  return {
    root,
    outputDir,
    provider,
    context,
    progress,
    controller,
    submissions: () => submitted,
  };
}
const caps = `if (input.operation === 'capabilities') send({type:'capabilities',state:'ready',message:'fixture capability only',capabilities:['video']}); else`;

describe("native command provider", () => {
  it("reflects only explicitly reported aspect choices", async () => {
    const { provider } = await setup(
      `send({type:'capabilities',state:'ready',message:'fixture',capabilities:['image'],aspects:['1:1']});`,
    );
    expect((await provider.status()).aspects).toEqual(["1:1"]);
  });
  it("reflects capabilities and does not infer extra generation modes", async () => {
    const { provider, context, submissions } = await setup(
      `${caps} throw new Error('must not run');`,
    );
    expect((await provider.status()).capabilities).toEqual(["video"]);
    await expect(
      provider.run({ ...request, kind: "extend" }, context),
    ).rejects.toThrow("没有声明 extend");
    expect(submissions()).toBe(0);
  });

  it("consumes JSONL events and returns only real files in this job output directory", async () => {
    const { provider, context, submissions, progress } = await setup(`${caps} {
      send({type:'submitted',conversationId:'native-session'});
      send({type:'progress',message:'fixture output'});
      const file = path.join(input.outputDir,'fixture.png');
      await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3f8AAAAASUVORK5CYII=','base64'));
      send({type:'result',conversationId:'native-session',files:[{path:file,mime:'image/png'}]});
    }`);
    const result = await provider.run(request, context);
    expect(result.conversationId).toBe("native-session");
    expect((await readFile(result.files[0].path)).subarray(0, 4)).toEqual(
      Buffer.from([137, 80, 78, 71]),
    );
    expect(submissions()).toBe(2); // conservative dispatch, then native acknowledgement
    expect(progress).toEqual(["fixture output"]);
  });

  it("rejects a symlink that escapes the job output directory", async () => {
    const { provider, context } = await setup(`${caps} {
      const outside = path.resolve(input.outputDir,'../private.png'); await writeFile(outside,'private');
      const file = path.join(input.outputDir,'escape.png'); await symlink(outside,file);
      send({type:'result',files:[{path:file,mime:'image/png'}]});
    }`);
    await expect(provider.run(request, context)).rejects.toThrow(
      "本次 outputDir",
    );
  });

  it("keeps a failed dispatched attempt marked as submitted", async () => {
    const { provider, context, submissions } = await setup(
      `${caps} process.stdout.write('not-json');`,
    );
    await expect(provider.run(request, context)).rejects.toThrow();
    expect(submissions()).toBe(1);
  });

  it("returns setup failures without pretending the provider is ready", async () => {
    const { provider } = await setup(
      `send({type:'error',message:'native media component is unavailable'});`,
    );
    expect(await provider.status()).toEqual({
      state: "error",
      message: "native media component is unavailable",
      capabilities: [],
    });
  });

  it("stops a running adapter on cancellation", async () => {
    const { provider, context, controller } = await setup(
      `${caps} { send({type:'progress',message:'waiting'}); setInterval(() => {},1000); }`,
    );
    context.onProgress = () => controller.abort();
    await expect(provider.run(request, context)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
