import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { ApiError, object } from "./validation.ts";
import type { ApiConfig } from "./types.ts";
export function dataDirectory(value?: string): string {
  return path.resolve(
    value ??
      process.env.SENMUSE_API_DATA ??
      fileURLToPath(new URL("../../.senmuse-api", import.meta.url)),
  );
}
export function initConfig(dir: string, native = false): ApiConfig {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const configFile = path.join(dir, "config.json");
  if (fs.existsSync(configFile))
    throw new ApiError(
      409,
      "配置已存在，保留原配置；请使用 doctor 检查或编辑 config.json",
    );
  const config: ApiConfig = {
    version: 1,
    host: "127.0.0.1",
    port: 47831,
    tokenFile: path.join(dir, "api-token"),
    provider: native
      ? {
          type: "command",
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("../../scripts/muse-native.mjs", import.meta.url),
            ),
          ],
        }
      : { type: "muse", profileDir: path.join(dir, "browser"), headless: true },
  };
  fs.writeFileSync(
    config.tokenFile,
    `sm_${randomBytes(32).toString("hex")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return config;
}
export function readConfig(dir: string): ApiConfig {
  const data = object(
    JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")),
  );
  if (
    data.version !== 1 ||
    typeof data.host !== "string" ||
    (!isIP(data.host) && data.host !== "localhost") ||
    typeof data.port !== "number" ||
    !Number.isInteger(data.port) ||
    data.port < 0 ||
    data.port > 65535 ||
    typeof data.tokenFile !== "string"
  )
    throw new Error("config.json 的监听地址、端口或版本不正确");
  if (data.publicUrl !== undefined) {
    const url = new URL(String(data.publicUrl));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error(
        "publicUrl 需要 HTTPS 根地址，例如 https://video.example.com",
      );
    data.publicUrl = url.origin;
  }
  const provider = object(data.provider);
  if (provider.type === "muse") {
    if (
      typeof provider.profileDir !== "string" ||
      !path.isAbsolute(provider.profileDir)
    )
      throw new Error("Muse profileDir 必须是专用浏览器目录的绝对路径");
    if (
      provider.headless !== undefined &&
      typeof provider.headless !== "boolean"
    )
      throw new Error("headless 必须是布尔值");
    if (provider.cdpUrl !== undefined && typeof provider.cdpUrl !== "string")
      throw new Error("cdpUrl 必须是字符串");
    if (provider.proxy !== undefined && typeof provider.proxy !== "string")
      throw new Error("proxy 必须是字符串");
  } else if (provider.type === "command") {
    if (
      typeof provider.command !== "string" ||
      !Array.isArray(provider.args) ||
      provider.args.some((v) => typeof v !== "string") ||
      (provider.cwd !== undefined && typeof provider.cwd !== "string")
    )
      throw new Error("原生适配器需要 command、args，可选 cwd");
  } else throw new Error("provider.type 必须是 muse 或 command");
  return data as unknown as ApiConfig;
}
export function readToken(config: ApiConfig): string {
  const token =
    process.env.SENMUSE_API_TOKEN ??
    fs.readFileSync(config.tokenFile, "utf8").trim();
  if (!/^[\x21-\x7e]{32,200}$/.test(token))
    throw new Error("API token 需要 32–200 个可打印 ASCII 字符");
  return token;
}
export function lockData(dir: string): () => void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "service.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid))
            fs.unlinkSync(file);
        } catch {
          /* already removed */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(pid) || pid < 1)
        throw new Error("服务锁无法识别；检查并移除 service.lock 后重试");
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") {
          fs.unlinkSync(file);
          continue;
        }
        throw e;
      }
      throw new Error("此数据目录已有 API 服务运行，不能同时启动第二个服务");
    }
  }
  throw new Error("无法取得服务锁");
}
