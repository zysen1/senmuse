import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ApiServer } from "../src/api/server.ts";
import { ApiEngine } from "../src/api/engine.ts";
import type { GenerationProvider } from "../src/api/types.ts";
const requireApi = createRequire(path.resolve("api/package.json"));
const token = "test-only-api-token-not-a-real-secret-0123456789";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "senmuse-api-http-"));
  let calls = 0;
  const provider: GenerationProvider = {
    status: async () => ({
      state: "ready",
      message: "Test-only provider",
      capabilities: ["video"],
    }),
    close: async () => {},
    run: async (request, context) => {
      calls++;
      context.onSubmitted("test-thread");
      const file = path.join(context.outputDir, "fixture.mp4");
      fs.writeFileSync(
        file,
        Buffer.concat([
          Buffer.from([0, 0, 0, 24]),
          Buffer.from("ftypisom"),
          Buffer.alloc(24),
        ]),
      );
      return {
        conversationId: "test-thread",
        files: [{ path: file, mime: "video/mp4", name: "fixture.mp4" }],
      };
    },
  };
  const engine = new ApiEngine(dir, provider);
  const server = new ApiServer(
    {
      version: 1,
      host: "127.0.0.1",
      port: 0,
      tokenFile: "unused",
      provider: { type: "command", command: "fixture", args: [] },
    },
    token,
    engine,
  );
  await server.listen();
  cleanups.push(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  return { server, engine, url: server.baseUrl, headers, calls: () => calls };
}
it("requires bearer authentication, validates Host/Origin and keeps health data minimal", async () => {
  const { url, headers } = await start();
  expect((await fetch(url + "/healthz")).status).toBe(200);
  expect(await (await fetch(url + "/healthz")).json()).toEqual({
    service: "senmuse-api",
    alive: true,
  });
  expect((await fetch(url + "/v1/jobs")).status).toBe(401);
  expect(
    (
      await fetch(url + "/v1/jobs", {
        headers: { ...headers, Origin: "https://attacker.invalid" },
      })
    ).status,
  ).toBe(403);
  const hostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const request = http.get(
        url + "/v1/jobs",
        { headers: { ...headers, Host: "attacker.invalid" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
    },
  );
  expect(hostStatus).toBe(403);
  expect((await fetch(url + "/v1/status", { headers })).status).toBe(200);
});
it("supports upload, idempotent generation, status polling and authenticated download", async () => {
  const { url, headers, engine, calls } = await start();
  const picture = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const upload = await fetch(url + "/v1/assets", {
    method: "POST",
    headers: {
      Authorization: headers.Authorization,
      "X-Filename": encodeURIComponent("参考.png"),
    },
    body: picture,
  });
  expect(upload.status).toBe(201);
  const asset = (await upload.json()) as any;
  expect(asset).not.toHaveProperty("path");
  const input = {
    kind: "video",
    prompt: "Test fixture only",
    requestId: "http-test-123",
    referenceIds: [asset.id],
  };
  const send = () =>
    fetch(url + "/v1/jobs", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
  const response = await send();
  expect(response.status).toBe(202);
  const job = (await response.json()) as any;
  await expect.poll(() => engine.job(job.id).status).toBe("completed");
  expect(((await (await send()).json()) as any).id).toBe(job.id);
  expect(calls()).toBe(1);
  const jobReply = (await (
    await fetch(`${url}/v1/jobs/${job.id}`, { headers })
  ).json()) as any;
  const files = (await (
    await fetch(url + "/v1/assets", { headers })
  ).json()) as any[];
  const file = files.find((a) => a.id === jobReply.assetIds[0]);
  expect(file).toBeTruthy();
  expect((await fetch(file.downloadUrl)).status).toBe(401);
  const download = await fetch(file.downloadUrl, { headers });
  expect(download.headers.get("content-type")).toBe("video/mp4");
  expect((await download.arrayBuffer()).byteLength).toBe(36);
});
it("rejects malformed/oversized JSON and unsupported uploaded content", async () => {
  const { url, headers } = await start();
  expect(
    (await fetch(url + "/v1/jobs", { method: "POST", headers, body: "[" }))
      .status,
  ).toBe(400);
  expect(
    (
      await fetch(url + "/v1/jobs", {
        method: "POST",
        headers,
        body: JSON.stringify({ x: "x".repeat(65536) }),
      })
    ).status,
  ).toBe(413);
  expect(
    (
      await fetch(url + "/v1/assets", {
        method: "POST",
        headers: { Authorization: headers.Authorization },
        body: "not media",
      })
    ).status,
  ).toBe(400);
  expect((await fetch(url + "/v1/openapi.json", { headers })).status).toBe(200);
});
it("works with the official MCP SDK Streamable HTTP client and keeps generation asynchronous", async () => {
  const { url, headers, engine, calls } = await start();
  const { Client } = requireApi("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = requireApi(
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
  );
  const client = new Client({
    name: "senmuse-contract-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(new URL(url + "/mcp"), {
    requestInit: { headers: { Authorization: headers.Authorization } },
  });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    expect(list.tools.map((tool: any) => tool.name)).toContain("muse_generate");
    const response = await client.callTool({
      name: "muse_generate",
      arguments: {
        kind: "video",
        prompt: "Test fixture only",
        requestId: "mcp-sdk-001",
      },
    });
    expect(response.isError).not.toBe(true);
    const job = JSON.parse(response.content[0].text);
    await expect.poll(() => engine.job(job.id).status).toBe("completed");
    const repeat = await client.callTool({
      name: "muse_generate",
      arguments: {
        kind: "video",
        prompt: "Test fixture only",
        requestId: "mcp-sdk-001",
      },
    });
    expect(JSON.parse(repeat.content[0].text).id).toBe(job.id);
    expect(calls()).toBe(1);
    const bad = await client.callTool({
      name: "muse_generate",
      arguments: { kind: "video", prompt: "Test fixture only" },
    });
    expect(bad.isError).toBe(true);
  } finally {
    await client.close();
  }
});
