import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { ApiConfig } from "./types.ts";
import type { ApiEngine } from "./engine.ts";
import { ApiError, object, safeMessage } from "./validation.ts";
import { handleRpc } from "./mcp.ts";
import { openApi } from "./spec.ts";
const LIMIT = 200 * 1024 * 1024;
export class ApiServer {
  private server: http.Server;
  private config: ApiConfig;
  private token: Buffer;
  private engine: ApiEngine;
  port = 0;
  constructor(config: ApiConfig, token: string, engine: ApiEngine) {
    this.config = config;
    this.token = Buffer.from(token);
    this.engine = engine;
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 120000;
    this.server.maxHeadersCount = 50;
  }
  get baseUrl() {
    return this.config.publicUrl ?? `http://127.0.0.1:${this.port}`;
  }
  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (address && typeof address !== "string") this.port = address.port;
        resolve();
      });
    });
    this.engine.pump();
  }
  async close() {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    await this.engine.close();
  }
  private async json(request: http.IncomingMessage): Promise<unknown> {
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers["content-type"] ?? "",
      )
    )
      throw new ApiError(415, "请使用 application/json");
    if (Number(request.headers["content-length"] ?? 0) > 65536) {
      request.resume();
      throw new ApiError(413, "JSON 请求超过 64 KiB");
    }
    const chunks = await new Promise<Buffer[]>((resolve, reject) => {
      const parts: Buffer[] = [];
      let length = 0;
      let failed = false;
      request.on("data", (value: Buffer) => {
        length += value.length;
        if (length > 65536) {
          if (!failed) {
            failed = true;
            reject(new ApiError(413, "JSON 请求超过 64 KiB"));
          }
        } else if (!failed) parts.push(value);
      });
      request.on("end", () => {
        if (!failed) resolve(parts);
      });
      request.on("error", reject);
      request.on("aborted", () => reject(new ApiError(400, "请求已中断")));
    });
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new ApiError(400, "JSON 格式错误");
    }
  }
  private async upload(request: http.IncomingMessage) {
    const name =
      typeof request.headers["x-filename"] === "string"
        ? decodeURIComponent(request.headers["x-filename"])
        : "reference";
    if (Number(request.headers["content-length"] ?? 0) > LIMIT)
      throw new ApiError(413, "素材超过 200 MiB");
    const file = path.join(
      this.engine.dir,
      "work",
      `upload-${randomUUID()}.part`,
    );
    let length = 0;
    const guard = new Transform({
      transform(chunk, _encoding, callback) {
        length += chunk.length;
        callback(
          length > LIMIT ? new ApiError(413, "素材超过 200 MiB") : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        request,
        guard,
        fs.createWriteStream(file, { flags: "wx", mode: 0o600 }),
      );
      return this.engine.importFile(file, name);
    } finally {
      fs.rmSync(file, { force: true });
    }
  }
  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) {
    const reply = (status: number, body?: unknown) => {
      if (response.destroyed || response.headersSent) return;
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    try {
      const hosts = new Set([
        `127.0.0.1:${this.port}`,
        `localhost:${this.port}`,
        `[::1]:${this.port}`,
        ...(this.config.host !== "0.0.0.0" && this.config.host !== "::"
          ? [
              `${this.config.host.includes(":") ? `[${this.config.host}]` : this.config.host}:${this.port}`,
            ]
          : []),
        ...(this.config.publicUrl ? [new URL(this.config.publicUrl).host] : []),
      ]);
      if (!request.headers.host || !hosts.has(request.headers.host))
        throw new ApiError(403, "Host 不在已配置的 API 地址中");
      if (request.headers.origin) {
        const origins = new Set([
          `http://127.0.0.1:${this.port}`,
          `http://localhost:${this.port}`,
          ...(this.config.publicUrl ? [this.config.publicUrl] : []),
        ]);
        if (!origins.has(request.headers.origin))
          throw new ApiError(403, "不接受此 Origin");
      }
      const route = new URL(request.url ?? "/", "http://localhost").pathname;
      const publicFiles: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/app.css": ["app.css", "text/css; charset=utf-8"],
      };
      const publicFile = publicFiles[route];
      if (request.method === "GET" && publicFile) {
        const body = fs.readFileSync(
          new URL(`../../api/public/${publicFile[0]}`, import.meta.url),
        );
        response.writeHead(200, {
          "Content-Type": publicFile[1],
          "Content-Length": body.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
        });
        response.end(body);
        return;
      }
      if (request.method === "GET" && route === "/healthz") {
        reply(200, { service: "senmuse-api", alive: true });
        return;
      }
      const auth = Buffer.from(
        (request.headers.authorization ?? "").replace(/^Bearer /, ""),
      );
      if (
        auth.length !== this.token.length ||
        !timingSafeEqual(auth, this.token)
      ) {
        reply(401, { error: "请提供 Authorization: Bearer <API token>" });
        return;
      }
      if (route === "/mcp") {
        const version = request.headers["mcp-protocol-version"];
        if (
          version &&
          !["2025-11-25", "2025-06-18", "2025-03-26"].includes(String(version))
        )
          throw new ApiError(400, "不支持的 MCP 协议版本");
        if (request.method !== "POST") {
          response.setHeader("Allow", "POST");
          reply(405, {
            error: "此 MCP 服务返回 JSON；不提供 SSE 流或持久会话",
          });
          return;
        }
        const accept = request.headers.accept ?? "";
        if (
          !accept.includes("application/json") ||
          !accept.includes("text/event-stream")
        )
          throw new ApiError(
            406,
            "MCP Accept 需要 application/json, text/event-stream",
          );
        const result = await handleRpc(
          await this.json(request),
          this.engine,
          this.baseUrl,
        );
        reply(result === null ? 202 : 200, result ?? undefined);
        return;
      }
      if (request.method === "GET" && route === "/v1/status") {
        reply(200, {
          service: "senmuse-api",
          version: "0.3.0-preview.1",
          muse: await this.engine.status(),
          queuePaused: this.engine.data.paused,
        });
        return;
      }
      if (request.method === "GET" && route === "/v1/openapi.json") {
        reply(200, openApi(this.baseUrl));
        return;
      }
      if (route === "/v1/jobs" && request.method === "POST") {
        reply(202, this.engine.create(await this.json(request)));
        return;
      }
      if (route === "/v1/jobs" && request.method === "GET") {
        reply(200, this.engine.data.jobs.slice(0, 100));
        return;
      }
      const jobRoute =
        /^\/v1\/jobs\/([0-9a-f-]{36})(?:\/(cancel|resolve))?$/.exec(route);
      if (jobRoute) {
        if (request.method === "GET" && !jobRoute[2]) {
          reply(200, this.engine.job(jobRoute[1]));
          return;
        }
        if (request.method === "POST" && jobRoute[2] === "cancel") {
          reply(200, this.engine.cancel(jobRoute[1]));
          return;
        }
        if (request.method === "POST" && jobRoute[2] === "resolve") {
          reply(
            200,
            this.engine.resolve(
              jobRoute[1],
              object(await this.json(request)).action,
            ),
          );
          return;
        }
      }
      if (route === "/v1/queue" && request.method === "POST") {
        const data = object(await this.json(request));
        if (typeof data.paused !== "boolean")
          throw new ApiError(400, "paused 必须为布尔值");
        this.engine.pause(data.paused);
        reply(200, { paused: this.engine.data.paused });
        return;
      }
      if (route === "/v1/assets" && request.method === "GET") {
        reply(
          200,
          this.engine.data.assets.slice(0, 100).map((asset) => ({
            ...this.engine.publicAsset(asset),
            downloadUrl: `${this.baseUrl}/v1/assets/${asset.id}/file`,
          })),
        );
        return;
      }
      if (route === "/v1/assets" && request.method === "POST") {
        const asset = await this.upload(request);
        reply(201, {
          ...this.engine.publicAsset(asset),
          downloadUrl: `${this.baseUrl}/v1/assets/${asset.id}/file`,
        });
        return;
      }
      const assetRoute = /^\/v1\/assets\/([0-9a-f-]{36})\/file$/.exec(route);
      if (
        assetRoute &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        const asset = this.engine.asset(assetRoute[1]);
        const stat = fs.statSync(asset.path);
        response.writeHead(200, {
          "Content-Type": asset.mime,
          "Content-Length": stat.size,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        await pipeline(fs.createReadStream(asset.path), response);
        return;
      }
      reply(404, { error: "接口不存在；请查看 /v1/openapi.json" });
    } catch (error) {
      reply(error instanceof ApiError ? error.status : 500, {
        error: safeMessage(error),
      });
    }
  }
}
