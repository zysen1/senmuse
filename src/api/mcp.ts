import type { ApiEngine } from "./engine.ts";
import { ApiError, object } from "./validation.ts";
const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });
const idSchema = objectSchema({ id: { type: "string" } }, ["id"]);
export const apiTools = [
  {
    name: "muse_status",
    description:
      "Check the connected Muse generation component and its available capabilities before creating media.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "muse_generate",
    description:
      "Generate an image or video using the owner's Muse account. Consumes Muse quota. Use a stable requestId (8–100 printable ASCII characters) and reuse it after network errors. Poll muse_get_job. needs_review means the request may already have run: do not automatically resubmit. Duration/aspect are requested targets, not guarantees.",
    inputSchema: objectSchema(
      {
        kind: { type: "string", enum: ["video", "image", "edit", "extend"] },
        prompt: { type: "string", minLength: 1, maxLength: 12000 },
        requestId: { type: "string", minLength: 8, maxLength: 100 },
        referenceIds: { type: "array", items: { type: "string" }, maxItems: 4 },
        aspect: { type: "string", enum: ["9:16", "16:9", "1:1"] },
        duration: { type: "number", minimum: 1, maximum: 60 },
        conversationId: { type: "string" },
      },
      ["kind", "prompt", "requestId"],
    ),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: "muse_get_job",
    description:
      "Get progress and asset IDs for a queued generation. Download completed files using muse_list_assets and the API bearer token.",
    inputSchema: idSchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "muse_list_jobs",
    description: "List the most recent 100 generation jobs.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "muse_cancel_job",
    description:
      "Cancel a queued job or stop monitoring a running job. Already submitted Muse work may continue and will require review.",
    inputSchema: idSchema,
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: "muse_list_assets",
    description:
      "List saved media and authenticated download URLs. Upload reference media with POST /v1/assets (binary body, X-Filename header), then use its ID in muse_generate.",
    inputSchema: objectSchema({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: "muse_queue",
    description:
      "Pause or resume pending generation. Resume refuses while jobs need review. Pausing does not interrupt the running job.",
    inputSchema: objectSchema({ paused: { type: "boolean" } }, ["paused"]),
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
];
export async function handleRpc(
  value: unknown,
  engine: ApiEngine,
  baseUrl: string,
): Promise<unknown | null> {
  const message = object(value);
  if (
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (message.id !== undefined &&
      typeof message.id !== "string" &&
      typeof message.id !== "number" &&
      message.id !== null)
  )
    throw new ApiError(400, "无效的 JSON-RPC 请求");
  if (message.id === undefined) {
    if (!message.method.startsWith("notifications/"))
      throw new ApiError(400, "无效的 MCP notification");
    return null;
  }
  const result = (data: unknown) => ({
    jsonrpc: "2.0",
    id: message.id,
    result: data,
  });
  if (message.method === "initialize") {
    const requested = object(message.params ?? {}).protocolVersion;
    const supported = ["2025-11-25", "2025-06-18", "2025-03-26"];
    return result({
      protocolVersion:
        typeof requested === "string" && supported.includes(requested)
          ? requested
          : "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "senmuse-api", version: "0.3.0-preview.1" },
      instructions:
        "Use muse_status first. Stable requestId prevents duplicate generation. needs_review requires user inspection; never automatically submit a replacement.",
    });
  }
  if (message.method === "ping") return result({});
  if (message.method === "tools/list") return result({ tools: apiTools });
  if (message.method !== "tools/call")
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    };
  try {
    const params = object(message.params);
    const args = object(params.arguments ?? {});
    let data: unknown;
    switch (params.name) {
      case "muse_status":
        data = {
          service: "senmuse-api",
          muse: await engine.status(),
          queuePaused: engine.data.paused,
        };
        break;
      case "muse_generate":
        data = engine.create(args);
        break;
      case "muse_get_job":
        data = engine.job(String(args.id));
        break;
      case "muse_list_jobs":
        data = engine.data.jobs.slice(0, 100);
        break;
      case "muse_cancel_job":
        data = engine.cancel(String(args.id));
        break;
      case "muse_list_assets":
        data = engine.data.assets.slice(0, 100).map((a) => ({
          ...engine.publicAsset(a),
          downloadUrl: `${baseUrl}/v1/assets/${a.id}/file`,
        }));
        break;
      case "muse_queue":
        if (typeof args.paused !== "boolean")
          throw new Error("paused 必须为布尔值");
        engine.pause(args.paused);
        data = { paused: engine.data.paused };
        break;
      default:
        throw new Error("Unknown tool");
    }
    return result({ content: [{ type: "text", text: JSON.stringify(data) }] });
  } catch (error) {
    return result({
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "调用失败",
        },
      ],
    });
  }
}
