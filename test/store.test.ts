import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/main/store";
import type { Project } from "../src/shared/types";

const dirs: string[] = [];
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "senmuse-store-"));
  dirs.push(dir);
  return { store: new Store(path.join(dir, "state.json"), dir), dir };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
describe("durable queue and storyboard", () => {
  it("deduplicates client retries across restarts", () => {
    const { store, dir } = makeStore();
    const input = {
      kind: "video" as const,
      prompt: "雨后的街道",
      requestId: randomUUID(),
    };
    const first = store.createJob(input);
    const reopened = new Store(path.join(dir, "state.json"), dir);
    expect(reopened.createJob(input).id).toBe(first.id);
    expect(reopened.data.jobs).toHaveLength(1);
  });
  it("recovers submitted jobs for review and unsent jobs for queueing", () => {
    const { store, dir } = makeStore();
    const sent = store.createJob({
      kind: "video",
      prompt: "a",
      requestId: randomUUID(),
    });
    sent.status = "running";
    sent.submittedAt = Date.now();
    const unsent = store.createJob({
      kind: "video",
      prompt: "b",
      requestId: randomUUID(),
    });
    unsent.status = "running";
    store.save();
    const reopened = new Store(path.join(dir, "state.json"), dir);
    expect(reopened.data.jobs.find((job) => job.id === sent.id)?.status).toBe(
      "needs_review",
    );
    expect(reopened.data.jobs.find((job) => job.id === unsent.id)?.status).toBe(
      "queued",
    );
    expect(reopened.data.queuePaused).toBe(true);
  });
  it("handles special request keys and rejects conflicting retries", () => {
    const { store } = makeStore();
    const input = {
      kind: "video" as const,
      prompt: "test",
      requestId: "__proto__",
    };
    const job = store.createJob(input);
    expect(store.createJob(input).id).toBe(job.id);
    expect(() => store.createJob({ ...input, prompt: "changed" })).toThrow(
      "requestId",
    );
  });
  it("rejects stale revisions after a shot result and preserves other shots", () => {
    const { store } = makeStore();
    const draft: Project = {
      id: randomUUID(),
      name: "测试",
      shots: [1, 2].map(() => ({
        id: randomUUID(),
        prompt: "咖啡",
        caption: "",
        duration: 2,
      })),
      aspect: "9:16",
      fit: "contain",
      burnCaptions: false,
      updatedAt: 0,
      revision: 0,
    };
    const saved = store.saveProject(draft);
    const stale = structuredClone(saved);
    const job = store.createJob({
      kind: "video",
      prompt: "咖啡",
      requestId: randomUUID(),
      projectId: saved.id,
      shotId: saved.shots[0].id,
    });
    const asset = {
      id: randomUUID(),
      name: "a.mp4",
      kind: "video" as const,
      path: "/tmp/a.mp4",
      url: "",
      createdAt: 0,
      jobId: job.id,
    };
    store.completeJob(job, [asset], "https://muse.ai/thread/test");
    expect(store.data.projects[0].shots[0].assetId).toBe(asset.id);
    expect(store.data.projects[0].shots[1].assetId).toBeUndefined();
    expect(() => store.saveProject(stale)).toThrow("新结果");
  });
});
