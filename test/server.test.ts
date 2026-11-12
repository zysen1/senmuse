import { afterEach, expect, it, vi } from "vitest";
import { LocalApi } from "../src/main/server";
import type { AppState } from "../src/shared/types";

const servers: LocalApi[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.configure(false, 0);
});
it("requires authentication, rejects browser origins, and serves agent clients", async () => {
  const createJob = vi.fn(() => ({ id: "queued-job" }) as never);
  const snapshot: AppState = {
    version: "0.1.0",
    muse: { state: "unknown", message: "" },
    jobs: [],
    projects: [],
    assets: [],
    queuePaused: false,
    exports: [],
    settings: {
      outputDir: "/tmp",
      proxy: "",
      apiEnabled: false,
      apiPort: 47831,
    },
    api: { running: false, port: 47831 },
  };
  const server = new LocalApi("test-token", {
    state: () => snapshot,
    createJob,
    cancelJob: vi.fn(),
    retryJob: vi.fn(),
    exportProject: vi.fn(),
  });
  servers.push(server);
  await server.configure(true, 0);
  const base = `http://127.0.0.1:${server.status().port}`;
  expect((await fetch(`${base}/v1/status`)).status).toBe(401);
  expect(
    (
      await fetch(`${base}/v1/status`, {
        headers: {
          Authorization: "Bearer test-token",
          Origin: "https://example.com",
        },
      })
    ).status,
  ).toBe(403);
  const response = await fetch(`${base}/v1/status`, {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).version).toBe("0.1.0");
  const created = await fetch(`${base}/v1/jobs`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
    body: JSON.stringify({ prompt: "test" }),
  });
  expect(created.status).toBe(202);
  expect(createJob).toHaveBeenCalledWith({ prompt: "test" });
});
