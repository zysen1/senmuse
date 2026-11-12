import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { expect, it } from "vitest";

interface ToolResponse {
  id: number;
  result: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    tools?: { name: string; inputSchema: { required?: string[] } }[];
  };
}

async function runBridge(messages: object[]): Promise<{
  responses: ToolResponse[];
  requests: Record<string, unknown>[];
}> {
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(202, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "fixture-job", status: "queued" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("scripts/mcp.mjs")], {
        env: {
          ...process.env,
          SENMUSE_API_URL: `http://127.0.0.1:${address.port}`,
          SENMUSE_API_TOKEN: "stdio-test-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), 8000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`MCP exited with ${code}: ${stderr}`));
      });
      child.stdin.end(messages.map((message) => JSON.stringify(message)).join("\n") + "\n");
    });
    return { responses: output.trim().split("\n").map((line) => JSON.parse(line)), requests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const generation = (id: number, args: object) => ({
  jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "muse_generate", arguments: { kind: "video", prompt: "A quiet forest", ...args } },
});

it("advertises required requestId and rejects invalid IDs before any HTTP request", async () => {
  const { responses, requests } = await runBridge([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    generation(2, {}),
    generation(3, { requestId: null }),
    generation(4, { requestId: "short" }),
    generation(5, { requestId: "        " }),
    generation(6, { requestId: "x".repeat(101) }),
  ]);
  expect(responses[0].result.tools?.find((tool) => tool.name === "muse_generate")?.inputSchema.required).toContain("requestId");
  expect(responses).toHaveLength(6);
  for (const response of responses.slice(1)) {
    expect(response.result.isError).toBe(true);
    expect(response.result.content?.[0].text).toContain("requestId is required");
  }
  expect(requests).toEqual([]);
});

it("preserves the caller's idempotency key on retries and a distinct key for a new generation", async () => {
  const { responses, requests } = await runBridge([
    generation(1, { requestId: "forest-video-001" }),
    generation(2, { requestId: "forest-video-001" }),
    generation(3, { requestId: "forest-video-002" }),
  ]);
  expect(requests.map((request) => request.requestId)).toEqual(["forest-video-001", "forest-video-001", "forest-video-002"]);
  expect(responses).toHaveLength(3);
  expect(responses.every((response) => !response.result.isError)).toBe(true);
});
