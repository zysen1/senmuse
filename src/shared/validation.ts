import { z } from "zod";
const id = z.string().uuid();
export const createJobSchema = z.object({
  kind: z.enum(["image", "video", "edit", "extend"]),
  prompt: z.string().trim().min(1).max(12000),
  referenceIds: z.array(id).max(4).default([]),
  requestId: z.string().min(8).max(100),
  conversationUrl: z.string().url().max(1000).optional(),
  projectId: id.optional(),
  shotId: id.optional(),
});
export const projectSchema = z.object({
  id,
  name: z.string().trim().min(1).max(100),
  shots: z
    .array(
      z.object({
        id,
        prompt: z.string().max(12000),
        caption: z.string().max(500),
        duration: z.number().min(1).max(30),
        assetId: id.optional(),
        jobId: id.optional(),
      }),
    )
    .max(30),
  aspect: z.enum(["9:16", "16:9", "1:1"]),
  fit: z.enum(["contain", "cover"]),
  audioAssetId: id.optional(),
  burnCaptions: z.boolean(),
  updatedAt: z.number(),
  revision: z.number().int().min(0),
  exportAssetId: id.optional(),
});
export const settingsSchema = z.object({
  outputDir: z.string().min(1).max(2000),
  proxy: z
    .string()
    .max(500)
    .refine(
      (value) =>
        !value || /^(https?|socks5):\/\/[\w.\[\]:-]+:\d{1,5}$/.test(value),
      "代理格式应为 http://127.0.0.1:7890 或 socks5://127.0.0.1:7890",
    ),
  apiEnabled: z.boolean(),
  apiPort: z.number().int().min(1024).max(65535),
});
