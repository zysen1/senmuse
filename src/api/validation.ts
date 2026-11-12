import type { GenerationInput } from "./types.ts";
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(400, "请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}
export function generationInput(value: unknown): GenerationInput {
  const data = object(value);
  const allowed = new Set([
    "kind",
    "prompt",
    "requestId",
    "referenceIds",
    "aspect",
    "duration",
    "conversationId",
  ]);
  if (Object.keys(data).some((key) => !allowed.has(key)))
    throw new ApiError(400, "请求含有不支持的参数");
  if (
    typeof data.kind !== "string" ||
    !["video", "image", "edit", "extend"].includes(data.kind)
  )
    throw new ApiError(400, "kind 必须是 video、image、edit 或 extend");
  if (
    typeof data.prompt !== "string" ||
    !data.prompt.trim() ||
    data.prompt.length > 12000
  )
    throw new ApiError(400, "prompt 需要 1–12000 个字符");
  if (
    typeof data.requestId !== "string" ||
    !/^[\x21-\x7e]{8,100}$/.test(data.requestId)
  )
    throw new ApiError(
      400,
      "requestId 需要 8–100 个可打印 ASCII 字符；重试时复用原值",
    );
  const referenceIds = data.referenceIds ?? [];
  if (
    !Array.isArray(referenceIds) ||
    referenceIds.length > 4 ||
    referenceIds.some((id) => typeof id !== "string" || !isId(id))
  )
    throw new ApiError(400, "referenceIds 最多包含 4 个已上传素材 ID");
  if (
    data.aspect !== undefined &&
    (typeof data.aspect !== "string" ||
      !["9:16", "16:9", "1:1"].includes(data.aspect))
  )
    throw new ApiError(400, "aspect 必须是 9:16、16:9 或 1:1");
  if (
    data.duration !== undefined &&
    (typeof data.duration !== "number" ||
      !Number.isFinite(data.duration) ||
      data.duration < 1 ||
      data.duration > 60)
  )
    throw new ApiError(
      400,
      "duration 必须在 1–60 秒内；实际时长取决于 Muse 能力",
    );
  if (
    data.conversationId !== undefined &&
    (typeof data.conversationId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,150}$/.test(data.conversationId))
  )
    throw new ApiError(400, "conversationId 格式不正确");
  if (data.kind === "edit" && !referenceIds.length)
    throw new ApiError(400, "改片需要先上传视频，并传入 referenceIds");
  if (data.kind === "extend" && !referenceIds.length && !data.conversationId)
    throw new ApiError(400, "续拍需要 referenceIds 或 conversationId");
  return {
    kind: data.kind as GenerationInput["kind"],
    prompt: data.prompt.trim(),
    requestId: data.requestId,
    referenceIds,
    ...(data.aspect !== undefined
      ? { aspect: data.aspect as GenerationInput["aspect"] }
      : {}),
    ...(data.duration !== undefined
      ? { duration: data.duration as number }
      : {}),
    ...(data.conversationId
      ? { conversationId: data.conversationId as string }
      : {}),
  };
}
export const isId = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );
export function mediaType(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString() === "ftyp")
    return { mime: "video/mp4", ext: "mp4" };
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", ext: "png" };
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return { mime: "image/jpeg", ext: "jpg" };
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return { mime: "image/webp", ext: "webp" };
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  )
    return { mime: "video/webm", ext: "webm" };
  return null;
}
export function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "请求失败")
    .replace(/(?:https?|wss?):\/\/\S+/gi, "[服务地址]")
    .replace(
      /(?:Bearer\s+|(?:auth[_-]?token|notary[_-]?token|token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;}\]]+/gi,
      "[已隐藏认证信息]",
    )
    .slice(0, 600);
}
