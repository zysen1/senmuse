import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { AppState, Job } from "../shared/types";

interface Handlers {
  state(): AppState;
  createJob(input: unknown): Job;
  cancelJob(id: string): void;
  retryJob(id: string): Job;
  exportProject(id: string): Promise<void>;
}

export class LocalApi {
  private server?: http.Server;
  private info: AppState["api"] = { running: false, port: 47831 };
  constructor(
    private token: string,
    private handlers: Handlers,
  ) {}
  status(): AppState["api"] {
    return { ...this.info };
  }

  async configure(enabled: boolean, port: number): Promise<void> {
    if (this.server)
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        this.server!.closeAllConnections();
      });
    this.server = undefined;
    this.info = { running: false, port };
    if (!enabled) return;
    const server = http.createServer(
      (request, response) => void this.handle(request, response),
    );
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 40;
    this.server = server;
    await new Promise<void>((resolve) => {
      server.once("error", (error) => {
        this.info.error = `本地接口启动失败：${error.message}`;
        resolve();
      });
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address !== "string")
          this.info.port = address.port;
        this.info.running = true;
        resolve();
      });
    });
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify(body));
    };
    const auth = Buffer.from(
      (request.headers.authorization ?? "").replace(/^Bearer /, ""),
    );
    const expected = Buffer.from(this.token);
    if (
      request.headers.origin ||
      (request.headers.host !== `127.0.0.1:${this.info.port}` &&
        request.headers.host !== `localhost:${this.info.port}`)
    ) {
      reply(403, { error: "Only local agent clients are accepted" });
      return;
    }
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      reply(401, { error: "Invalid API token" });
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    try {
      if (request.method === "GET" && pathname === "/v1/status") {
        const state = this.handlers.state();
        reply(200, {
          version: state.version,
          muse: state.muse,
          queuePaused: state.queuePaused,
        });
        return;
      }
      if (request.method === "GET" && pathname === "/v1/jobs") {
        reply(200, this.handlers.state().jobs);
        return;
      }
      if (request.method === "GET" && pathname === "/v1/assets") {
        reply(
          200,
          this.handlers
            .state()
            .assets.map(({ path, ...asset }) => ({
              ...asset,
              downloadUrl: `http://127.0.0.1:${this.info.port}/v1/assets/${asset.id}/file`,
            })),
        );
        return;
      }
      const assetRoute = /^\/v1\/assets\/([a-f0-9-]{36})\/file$/.exec(pathname);
      if (assetRoute && request.method === "GET") {
        const asset = this.handlers
          .state()
          .assets.find((item) => item.id === assetRoute[1]);
        if (!asset || !fs.existsSync(asset.path)) {
          reply(404, { error: "Asset not found" });
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": fs.statSync(asset.path).size,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
          "X-Content-Type-Options": "nosniff",
        });
        const stream = fs.createReadStream(asset.path);
        stream.on("error", () => response.destroy());
        response.on("close", () => stream.destroy());
        stream.pipe(response);
        return;
      }
      if (request.method === "GET" && pathname === "/v1/projects") {
        reply(200, this.handlers.state().projects);
        return;
      }
      const jobRoute =
        /^\/v1\/jobs\/([a-f0-9-]{36})(?:\/(cancel|retry))?$/.exec(pathname);
      if (jobRoute && request.method === "GET" && !jobRoute[2]) {
        const job = this.handlers
          .state()
          .jobs.find((item) => item.id === jobRoute[1]);
        reply(job ? 200 : 404, job ?? { error: "Job not found" });
        return;
      }
      if (jobRoute && request.method === "POST" && jobRoute[2]) {
        reply(
          200,
          jobRoute[2] === "retry"
            ? this.handlers.retryJob(jobRoute[1])
            : (this.handlers.cancelJob(jobRoute[1]) ?? { ok: true }),
        );
        return;
      }
      const exportRoute = /^\/v1\/projects\/([a-f0-9-]{36})\/export$/.exec(
        pathname,
      );
      if (exportRoute && request.method === "POST") {
        await this.handlers.exportProject(exportRoute[1]);
        reply(202, { accepted: true });
        return;
      }
      if (request.method === "POST" && pathname === "/v1/jobs") {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 65536) {
            reply(413, { error: "Request too large" });
            return;
          }
          chunks.push(chunk);
        }
        reply(
          202,
          this.handlers.createJob(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          ),
        );
        return;
      }
      reply(404, { error: "Endpoint not found" });
    } catch (error) {
      reply(400, {
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  }
}
