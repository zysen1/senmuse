#!/usr/bin/env node
import readline from "node:readline";

const base = process.env.SENMUSE_API_URL ?? "http://127.0.0.1:47831";
const endpoint = new URL(base);
if (
  endpoint.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(endpoint.hostname)
)
  throw new Error("SENMUSE_API_URL must point to the local SenMuse app.");
const token = process.env.SENMUSE_API_TOKEN;
if (!token)
  throw new Error(
    "Set SENMUSE_API_TOKEN to the token shown in SenMuse settings.",
  );
const object = (properties) => ({
  type: "object",
  properties,
  additionalProperties: false,
});
const tools = [
  {
    name: "muse_status",
    description: "Check the local Muse connection and queue.",
    inputSchema: object({}),
  },
  {
    name: "muse_generate",
    description:
      "Queue image/video generation using the signed-in Muse account. This consumes Muse quota. requestId is required (8–100 characters): reuse exactly the same value when retrying after a network error or timeout, and choose a new value only for a new intended generation. Returns a job; poll muse_get_job for results.",
    inputSchema: {
      ...object({
        kind: { type: "string", enum: ["image", "video", "edit", "extend"] },
        prompt: { type: "string" },
        referenceIds: { type: "array", items: { type: "string" } },
        requestId: { type: "string", minLength: 8, maxLength: 100, pattern: "\\S" },
      }),
      required: ["kind", "prompt", "requestId"],
    },
  },
  {
    name: "muse_list_jobs",
    description: "Read current and previous generation tasks.",
    inputSchema: object({}),
  },
  {
    name: "muse_get_job",
    description:
      "Read one job by ID. needs_review means check the Muse window before retrying.",
    inputSchema: { ...object({ id: { type: "string" } }), required: ["id"] },
  },
  {
    name: "muse_cancel_job",
    description:
      "Cancel a queued task or stop local monitoring. An already submitted Muse task may continue remotely.",
    inputSchema: { ...object({ id: { type: "string" } }), required: ["id"] },
  },
  {
    name: "muse_list_assets",
    description:
      "List saved assets and their authenticated local download URLs.",
    inputSchema: object({}),
  },
  {
    name: "senmuse_list_projects",
    description: "List storyboard projects created in SenMuse.",
    inputSchema: object({}),
  },
  {
    name: "senmuse_export_project",
    description:
      "Render an existing storyboard to an MP4. Every shot must have a saved asset.",
    inputSchema: { ...object({ id: { type: "string" } }), required: ["id"] },
  },
];
async function request(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
async function call(name, args = {}) {
  const id = () => {
    if (!/^[0-9a-f-]{36}$/i.test(args.id ?? "")) throw new Error("Invalid ID");
    return args.id;
  };
  switch (name) {
    case "muse_status":
      return request("/v1/status");
    case "muse_generate":
      if (
        typeof args?.requestId !== "string" ||
        args.requestId.length < 8 ||
        args.requestId.length > 100 ||
        !args.requestId.trim()
      )
        throw new Error(
          "requestId is required and must be 8–100 characters. Reuse the same requestId after a network error or timeout; use a new value for a new generation.",
        );
      return request("/v1/jobs", args);
    case "muse_list_jobs":
      return request("/v1/jobs");
    case "muse_get_job":
      return request(`/v1/jobs/${id()}`);
    case "muse_cancel_job":
      return request(`/v1/jobs/${id()}/cancel`, {});
    case "muse_list_assets":
      return request("/v1/assets");
    case "senmuse_list_projects":
      return request("/v1/projects");
    case "senmuse_export_project":
      return request(`/v1/projects/${id()}/export`, {});
    default:
      throw new Error("Unknown tool");
  }
}
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
const lines = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
for await (const line of lines) {
  let message;
  try {
    if (line.length > 1_000_000) throw new Error("Message too large");
    message = JSON.parse(line);
  } catch {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    continue;
  }
  if (message.id === undefined) continue;
  const response = { jsonrpc: "2.0", id: message.id };
  if (message.method === "initialize") {
    send({
      ...response,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "senmuse", version: "0.2.0" },
      },
    });
  } else if (message.method === "ping") send({ ...response, result: {} });
  else if (message.method === "tools/list")
    send({ ...response, result: { tools } });
  else if (message.method === "tools/call") {
    try {
      const result = await call(
        message.params?.name,
        message.params?.arguments,
      );
      send({
        ...response,
        result: { content: [{ type: "text", text: JSON.stringify(result) }] },
      });
    } catch (error) {
      send({
        ...response,
        result: {
          isError: true,
          content: [{ type: "text", text: error.message }],
        },
      });
    }
  } else
    send({ ...response, error: { code: -32601, message: "Method not found" } });
}
