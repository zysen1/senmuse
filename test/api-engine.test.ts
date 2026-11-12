import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ApiEngine } from "../src/api/engine.ts";
import {
  initConfig,
  lockData,
  readConfig,
  readToken,
} from "../src/api/config.ts";
import { ApiError, generationInput } from "../src/api/validation.ts";
import type {
  GenerationProvider,
  ProviderContext,
  ProviderResult,
  ProviderStatus,
} from "../src/api/types.ts";

// These providers and files are local test fixtures. They never call Muse or
// claim to demonstrate real generation; the engine only inspects file magic.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3f8AAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];
const engines: ApiEngine[] = [];
const ready: ProviderStatus = {
  state: "ready",
  message: "test provider only",
  capabilities: ["video", "image", "edit", "extend"],
};
const input = (requestId = "request-test-01") => ({
  kind: "image",
  prompt: "test fixture",
  requestId,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function folder() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "senmuse-api-engine-test-"),
  );
  roots.push(dir);
  return dir;
}
function provider(
  run: GenerationProvider["run"] = async () => {
    throw new Error("unexpected test invocation");
  },
): GenerationProvider {
  return { status: async () => ready, run, close: async () => {} };
}
function engine(implementation = provider(), dir = folder()) {
  const value = new ApiEngine(dir, implementation);
  engines.push(value);
  return value;
}
function result(context: ProviderContext): ProviderResult {
  const file = path.join(context.outputDir, "test-only.png");
  fs.writeFileSync(file, png);
  return { files: [{ path: file, mime: "image/png" }] };
}
function statusCode(action: () => unknown, status: number) {
  try {
    action();
    throw new Error("expected API rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
  }
}
async function terminal(value: ApiEngine, id: string) {
  await expect
    .poll(() => value.job(id).status, { timeout: 2500, interval: 5 })
    .not.toMatch(/^(queued|running)$/);
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((value) => value.close()));
  roots
    .splice(0)
    .forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
});

describe("API durable queue and idempotency", () => {
  it("keeps an acknowledged request ID and its conflict check across a process restart", async () => {
    const first = engine();
    first.pause(true);
    const original = first.create({ ...input(), prompt: "  test fixture  " });
    expect(first.create(input()).id).toBe(original.id);
    statusCode(
      () => first.create({ ...input(), prompt: "different output" }),
      409,
    );
    await first.close();
    const reopened = engine(provider(), first.dir);
    expect(reopened.data.paused).toBe(true);
    expect(reopened.create(input()).id).toBe(original.id);
    expect(reopened.data.jobs).toHaveLength(1);
    statusCode(() => reopened.create({ ...input(), aspect: "9:16" }), 409);
  });

  it("rejects missing IDs, coerced kinds, and unknown fields before persisting a job", () => {
    const value = engine();
    value.pause(true);
    for (const bad of [
      { kind: "image", prompt: "test" },
      { ...input(), kind: ["video"] },
      { ...input(), requestId: "short" },
      { ...input(), referenceIds: ["not-an-asset-id"] },
      { ...input(), callbackUrl: "https://example.invalid" },
    ])
      statusCode(() => value.create(bad), 400);
    expect(value.data.jobs).toEqual([]);
    expect(Object.keys(value.data.requests)).toHaveLength(0);
  });

  it("runs oldest first, never overlaps providers, and skips a cancelled queued job", async () => {
    const release = deferred<void>();
    const calls: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const value = engine(
      provider(async (request, context) => {
        calls.push(request.requestId);
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          if (request.requestId === "request-first") await release.promise;
          context.onSubmitted("fixture-conversation");
          return result(context);
        } finally {
          concurrent--;
        }
      }),
    );
    value.pause(true);
    const first = value.create(input("request-first"));
    const cancelled = value.create(input("request-cancelled"));
    const last = value.create(input("request-last"));
    value.pause(false);
    await expect.poll(() => calls.length).toBe(1);
    expect(value.cancel(cancelled.id).status).toBe("cancelled");
    expect(value.job(last.id).status).toBe("queued");
    release.resolve();
    await terminal(value, last.id);
    expect(calls).toEqual(["request-first", "request-last"]);
    expect(maxConcurrent).toBe(1);
    expect(value.job(first.id).status).toBe("completed");
    const asset = value.asset(value.job(first.id).assetIds[0]);
    expect(fs.readFileSync(asset.path)).toEqual(png);
    expect(value.publicAsset(asset)).not.toHaveProperty("path");
  });

  it("returns a completed result on a network retry without another provider call", async () => {
    let calls = 0;
    const value = engine(
      provider(async (_request, context) => {
        calls++;
        context.onSubmitted();
        return result(context);
      }),
    );
    const job = value.create(input());
    await terminal(value, job.id);
    expect(value.create(input())).toBe(job);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    expect(job.status).toBe("completed");
    expect(job.assetIds).toHaveLength(1);
  });

  it("does not call the provider when connection checks fail, and permits the next queued job", async () => {
    let calls = 0;
    let checks = 0;
    const implementation = provider(async (_request, context) => {
      calls++;
      return result(context);
    });
    implementation.status = async () =>
      ++checks === 1
        ? {
            state: "login_required",
            message: "test login required",
            capabilities: [],
          }
        : ready;
    const value = engine(implementation);
    const first = value.create(input("request-login"));
    const second = value.create(input("request-ready"));
    await terminal(value, second.id);
    expect(first.status).toBe("failed");
    expect(first.submittedAt).toBeUndefined();
    expect(second.status).toBe("completed");
    expect(calls).toBe(1);
    expect(value.data.paused).toBe(false);
  });

  it("restores an interrupted pre-submission job but pauses an ambiguous submitted one", async () => {
    const original = engine();
    original.pause(true);
    const pending = original.create(input("request-before-submit"));
    const submitted = original.create(input("request-after-submit"));
    await original.close();
    const file = path.join(original.dir, "state.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const job of saved.jobs) job.status = "running";
    saved.jobs.find(
      (job: { id: string }) => job.id === submitted.id,
    ).submittedAt = new Date().toISOString();
    saved.paused = false;
    fs.writeFileSync(file, JSON.stringify(saved));
    let calls = 0;
    const restored = engine(
      provider(async (_request, context) => {
        calls++;
        return result(context);
      }),
      original.dir,
    );
    restored.pump();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(restored.job(pending.id).status).toBe("queued");
    expect(restored.job(submitted.id).status).toBe("needs_review");
    expect(restored.data.paused).toBe(true);
    expect(calls).toBe(0);
    statusCode(() => restored.pause(false), 409);
    restored.resolve(submitted.id, "acknowledge");
    expect(restored.data.paused).toBe(true);
    restored.pause(false);
    await terminal(restored, pending.id);
    expect(calls).toBe(1);
    expect(restored.create(input("request-after-submit")).status).toBe(
      "cancelled",
    );
  });
});

describe("API cancellation and ambiguous dispatch", () => {
  it.each(["output directory", "state persistence"])(
    "keeps the event loop responsive after a %s failure",
    (failure) => {
      const dir = folder();
      const moduleUrl = new URL("../src/api/engine.ts", import.meta.url).href;
      // Use a child process: this regression used to spin in microtasks forever,
      // starving even timers. The parent timeout safely bounds a failing run.
      const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      import { ApiEngine } from ${JSON.stringify(moduleUrl)};
      let providerChecks = 0;
      const persistenceFailure = ${JSON.stringify(failure === "state persistence")};
      const engine = new ApiEngine(process.argv[2], {
        status: async () => { providerChecks++; return {state:'ready', message:'test only', capabilities:['image']}; },
        run: async () => {throw new Error('must not dispatch');}, close: async () => {}
      });
      engine.pause(true);
      const job = engine.create({kind:'image', prompt:'isolated test', requestId:'isolated-repro'});
      const next = persistenceFailure ? engine.create({kind:'image', prompt:'must remain queued', requestId:'isolated-next'}) : undefined;
      if (!persistenceFailure) fs.writeFileSync(path.join(engine.dir, 'work', job.id), 'test path collision');
      setTimeout(async () => {
        await engine.close();
        console.log(JSON.stringify({status:job.status, paused:engine.data.paused, next:next?.status, providerChecks}));
      }, 25);
      engine.pause(false);
      if (persistenceFailure) fs.mkdirSync(path.join(engine.dir, 'state.json.tmp'));
    `;
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-", dir],
        {
          input: script,
          encoding: "utf8",
          timeout: 2500,
          killSignal: "SIGKILL",
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const state = JSON.parse(child.stdout.trim());
      expect(state.status).toBe("failed");
      expect(state.providerChecks).toBe(0);
      if (failure === "state persistence") {
        expect(state.paused).toBe(true);
        expect(state.next).toBe("queued");
      }
    },
  );

  it("closes the provider while a readiness check is pending instead of waiting for its network timeout", async () => {
    const check = deferred<ProviderStatus>();
    let closeCalls = 0;
    const implementation = provider();
    implementation.status = () => check.promise;
    implementation.close = async () => {
      closeCalls++;
      check.resolve(ready);
    };
    const value = engine(implementation);
    const job = value.create(input());
    await expect.poll(() => job.status).toBe("running");
    const closing = value.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const providerClosedWithoutNetworkReply = closeCalls > 0;
    // Release even when the assertion fails so the regression cannot hang CI.
    check.resolve(ready);
    await closing;
    expect(providerClosedWithoutNetworkReply).toBe(true);
    expect(job.status).toBe("cancelled");
    expect(job.submittedAt).toBeUndefined();
  });

  it("cancels before dispatch without consuming a provider run", async () => {
    const check = deferred<ProviderStatus>();
    let calls = 0;
    const implementation = provider(async (_request, context) => {
      calls++;
      return result(context);
    });
    implementation.status = () => check.promise;
    const value = engine(implementation);
    const job = value.create(input());
    await expect.poll(() => job.status).toBe("running");
    value.cancel(job.id);
    check.resolve(ready);
    await value.close();
    expect(job.status).toBe("cancelled");
    expect(job.submittedAt).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("stops waiting after submission without replaying, blocks the queue, and requires explicit acknowledgement", async () => {
    const stopped = deferred<void>();
    let calls = 0;
    const value = engine(
      provider(async (_request, context) => {
        calls++;
        context.onSubmitted("submitted-conversation");
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener(
            "abort",
            () => {
              stopped.resolve();
              reject(new Error("test cancelled"));
            },
            { once: true },
          ),
        );
        throw new Error("unreachable");
      }),
    );
    const job = value.create(input());
    const next = value.create(input("request-next"));
    await expect.poll(() => job.submittedAt).toBeDefined();
    value.cancel(job.id);
    expect(job.status).toBe("needs_review");
    statusCode(() => value.resolve(job.id, "acknowledge"), 409);
    await stopped.promise;
    await value.close();
    expect(calls).toBe(1);
    expect(next.status).toBe("queued");
    expect(value.data.paused).toBe(true);
    statusCode(() => value.pause(false), 409);
    statusCode(() => value.resolve(job.id, "retry"), 400);
    value.resolve(job.id, "acknowledge");
    expect(job.status).toBe("cancelled");
    expect(value.data.paused).toBe(true);
    expect(value.create(input()).id).toBe(job.id);
  });

  it("treats a late dispatch notification during cancellation conservatively", async () => {
    const started = deferred<ProviderContext>();
    const finish = deferred<ProviderResult>();
    const value = engine(
      provider(async (_request, context) => {
        started.resolve(context);
        return finish.promise;
      }),
    );
    const job = value.create(input());
    const context = await started.promise;
    value.cancel(job.id);
    expect(job.status).toBe("cancelled");
    context.onSubmitted("late-acknowledgement");
    finish.reject(new Error("connection lost after dispatch"));
    await value.close();
    expect(job.status).toBe("needs_review");
    expect(value.data.paused).toBe(true);
    expect(job.assetIds).toEqual([]);
  });

  it("keeps a submitted provider failure ambiguous and redacts credentials from durable errors", async () => {
    const value = engine(
      provider(async (_request, context) => {
        context.onSubmitted();
        throw new Error(
          "lost https://gateway.invalid/?auth_token=secret-a Bearer secret-b token=secret-c",
        );
      }),
    );
    const job = value.create(input());
    await terminal(value, job.id);
    expect(job.status).toBe("needs_review");
    expect(value.data.paused).toBe(true);
    expect(job.error).not.toMatch(/secret-[abc]/);
    const saved = fs.readFileSync(path.join(value.dir, "state.json"), "utf8");
    expect(saved).not.toMatch(/secret-[abc]/);
  });
});

describe("API generated asset boundaries", () => {
  it("rejects output outside this job directory without exposing local files", async () => {
    const outside = path.join(folder(), "private-test.png");
    fs.writeFileSync(outside, png);
    const value = engine(
      provider(async (_request, context) => {
        context.onSubmitted();
        return { files: [{ path: outside, mime: "image/png" }] };
      }),
    );
    const job = value.create(input());
    await terminal(value, job.id);
    expect(job.status).toBe("needs_review");
    expect(job.assetIds).toEqual([]);
    expect(value.data.assets).toEqual([]);
  });

  it("does not publish a partially invalid output batch", async () => {
    const value = engine(
      provider(async (_request, context) => {
        context.onSubmitted();
        const good = result(context).files[0];
        const bad = path.join(context.outputDir, "broken.png");
        fs.writeFileSync(bad, "not an image");
        return { files: [good, { path: bad, mime: "image/png" }] };
      }),
    );
    const job = value.create(input());
    await terminal(value, job.id);
    expect(job.status).toBe("needs_review");
    expect(job.assetIds).toEqual([]);
    expect(value.data.assets).toEqual([]);
    expect(fs.readdirSync(path.join(value.dir, "assets"))).toEqual([]);
  });

  it("does not publish an image as a successful video result", async () => {
    const value = engine(
      provider(async (_request, context) => {
        context.onSubmitted();
        return result(context);
      }),
    );
    const job = value.create({ ...input(), kind: "video" });
    await terminal(value, job.id);
    expect(job.status).toBe("needs_review");
    expect(job.assetIds).toEqual([]);
    expect(value.data.assets).toEqual([]);
  });
});

describe("API configuration and single-writer lock", () => {
  it("creates a private persistent token and refuses to overwrite an existing setup", () => {
    const dir = folder();
    const created = initConfig(dir);
    expect(readConfig(dir)).toEqual(created);
    const token = fs.readFileSync(created.tokenFile, "utf8").trim();
    expect(token).toMatch(/^sm_[a-f0-9]{64}$/);
    if (!process.env.SENMUSE_API_TOKEN) expect(readToken(created)).toBe(token);
    statusCode(() => initConfig(dir), 409);
    expect(fs.readFileSync(created.tokenFile, "utf8").trim()).toBe(token);
    if (process.platform !== "win32")
      expect(fs.statSync(created.tokenFile).mode & 0o777).toBe(0o600);
  });

  it("refuses a second live writer and permits clean release and reacquisition", () => {
    const dir = folder();
    const release = lockData(dir);
    expect(() => lockData(dir)).toThrow("已有 API 服务运行");
    expect(fs.readFileSync(path.join(dir, "service.lock"), "utf8")).toBe(
      String(process.pid),
    );
    release();
    const again = lockData(dir);
    again();
    expect(fs.existsSync(path.join(dir, "service.lock"))).toBe(false);
  });

  it("does not accept protocol coercion or credential-bearing public service URLs", () => {
    const dir = folder();
    const config = initConfig(dir);
    for (const publicUrl of [
      "http://example.invalid",
      "https://user:secret@example.invalid",
      "https://example.invalid/private",
      "https://example.invalid/?token=secret",
    ]) {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ ...config, publicUrl }),
      );
      expect(() => readConfig(dir)).toThrow();
    }
    expect(() => generationInput({ ...input(), aspect: ["9:16"] })).toThrow();
  });
});
