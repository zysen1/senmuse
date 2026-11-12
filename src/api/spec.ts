export function openApi(baseUrl: string) {
  const response = (description: string) => ({ description });
  const json = (schema: unknown) => ({
    required: true,
    content: { "application/json": { schema } },
  });
  const id = {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "森映 Muse API",
      version: "0.3.0-preview.1",
      description:
        "通过已授权的 Muse 会话或云主机原生组件生成视频。非 Muse 官方 API。requestId 防止网络重试重复生成；needs_review 不会自动重发。",
    },
    servers: [{ url: baseUrl }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths: {
      "/v1/status": {
        get: {
          summary: "Muse 连接与实际能力",
          responses: { 200: response("连接状态与队列状态") },
        },
      },
      "/v1/jobs": {
        get: {
          summary: "最近 100 个任务",
          responses: { 200: response("任务数组") },
        },
        post: {
          summary: "提交生成任务",
          requestBody: json({
            type: "object",
            required: ["kind", "prompt", "requestId"],
            additionalProperties: false,
            properties: {
              kind: { enum: ["video", "image", "edit", "extend"] },
              prompt: { type: "string", minLength: 1, maxLength: 12000 },
              requestId: { type: "string", minLength: 8, maxLength: 100 },
              referenceIds: {
                type: "array",
                maxItems: 4,
                items: { type: "string", format: "uuid" },
              },
              aspect: { enum: ["9:16", "16:9", "1:1"] },
              duration: { type: "number", minimum: 1, maximum: 60 },
              conversationId: { type: "string" },
            },
          }),
          responses: {
            202: response("已入队；重复 requestId 返回原任务"),
            409: response("相同 requestId 对应了不同内容"),
          },
        },
      },
      "/v1/jobs/{id}": {
        get: {
          parameters: [id],
          responses: { 200: response("任务状态；完成后返回 assetIds") },
        },
      },
      "/v1/jobs/{id}/cancel": {
        post: {
          parameters: [id],
          responses: {
            200: response("已取消或停止本地等待；不保证终止 Muse 已提交任务"),
          },
        },
      },
      "/v1/jobs/{id}/resolve": {
        post: {
          parameters: [id],
          requestBody: json({
            type: "object",
            required: ["action"],
            properties: { action: { const: "acknowledge" } },
          }),
          responses: {
            200: response("人工确认已检查 needs_review 任务；不会重新生成"),
          },
        },
      },
      "/v1/queue": {
        post: {
          requestBody: json({
            type: "object",
            required: ["paused"],
            properties: { paused: { type: "boolean" } },
          }),
          responses: {
            200: response("队列状态"),
            409: response("还有 needs_review 任务，不能恢复"),
          },
        },
      },
      "/v1/assets": {
        get: {
          responses: {
            200: response("最近 100 个素材及需要同一 API token 的下载地址"),
          },
        },
        post: {
          summary: "上传图片或视频参考素材（最大 200 MiB）",
          parameters: [
            {
              name: "X-Filename",
              in: "header",
              schema: { type: "string" },
              description: "文件名；中文需 encodeURIComponent",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/octet-stream": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          responses: { 201: response("素材 ID，可用于 referenceIds") },
        },
      },
      "/v1/assets/{id}/file": {
        get: {
          parameters: [id],
          responses: { 200: response("素材二进制文件") },
        },
      },
      "/mcp": {
        post: {
          summary: "MCP Streamable HTTP，JSON 响应，Bearer 认证",
          responses: {
            200: response("JSON-RPC response"),
            202: response("Notification accepted"),
          },
        },
      },
    },
  };
}
