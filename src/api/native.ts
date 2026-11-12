import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  CommandProviderConfig,
  GenerationKind,
  GenerationProvider,
  ProviderContext,
  ProviderRequest,
  ProviderResult,
  ProviderStatus,
} from "./types.ts";

const PROTOCOL = "senmuse-provider-v1";
const KINDS = new Set<GenerationKind>(["image", "video", "edit", "extend"]);
const STATES = new Set<ProviderStatus["state"]>([
  "ready",
  "login_required",
  "unconfigured",
  "error",
]);
const MAX_OUTPUT = 2 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("原生适配器必须输出 JSON 对象");
  return value as Record<string, unknown>;
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 100_000)
    throw new Error(`原生适配器的 ${label} 格式无效`);
  return value;
}
function abortError(): Error {
  const error = new Error(
    "原生任务已停止本地跟踪；远端已经提交的生成不一定随之取消",
  );
  error.name = "AbortError";
  return error;
}

/** Runs a user-installed adapter, never a shell or a guessed Muse endpoint. */
export class NativeCommandProvider implements GenerationProvider {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private closed = false;
  private readonly config: CommandProviderConfig;

  constructor(config: CommandProviderConfig) {
    this.config = config;
  }

  async status(): Promise<ProviderStatus> {
    if (!this.config.command.trim())
      return {
        state: "unconfigured",
        message: "尚未配置 Muse 原生适配器，请先运行云端组件探测",
        capabilities: [],
      };
    try {
      const output = await this.invoke("capabilities");
      if (
        !STATES.has(output.state as ProviderStatus["state"]) ||
        typeof output.message !== "string" ||
        !Array.isArray(output.capabilities)
      )
        throw new Error("原生适配器未返回有效的能力信息");
      if (
        output.capabilities.some((kind) => !KINDS.has(kind as GenerationKind))
      )
        throw new Error("原生适配器返回了不支持的能力名称");
      if (
        output.aspects !== undefined &&
        (!Array.isArray(output.aspects) ||
          output.aspects.some(
            (aspect) =>
              typeof aspect !== "string" ||
              !["9:16", "16:9", "1:1"].includes(aspect),
          ))
      )
        throw new Error("原生适配器返回了无效的画幅能力");
      const state = output.state as ProviderStatus["state"];
      return {
        state,
        message: output.message,
        capabilities:
          state === "ready"
            ? [...new Set(output.capabilities as GenerationKind[])]
            : [],
        ...(output.aspects !== undefined
          ? {
              aspects:
                state === "ready"
                  ? [
                      ...new Set(
                        output.aspects as NonNullable<
                          ProviderStatus["aspects"]
                        >,
                      ),
                    ]
                  : [],
            }
          : {}),
      };
    } catch (error) {
      return {
        state: "error",
        message: error instanceof Error ? error.message : String(error),
        capabilities: [],
      };
    }
  }

  async run(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    if (context.signal.aborted) throw abortError();
    const status = await this.status();
    if (status.state !== "ready") throw new Error(status.message);
    if (!status.capabilities.includes(request.kind))
      throw new Error(`当前原生适配器没有声明 ${request.kind} 能力`);
    const output = await this.invoke("generate", request, context);
    if (
      !Array.isArray(output.files) ||
      output.files.length < 1 ||
      output.files.length > 32
    )
      throw new Error("原生适配器没有返回实际生成文件");
    const root = await realpath(context.outputDir);
    const files: ProviderResult["files"] = [];
    for (const rawFile of output.files) {
      const file = record(rawFile);
      if (
        typeof file.path !== "string" ||
        !path.isAbsolute(file.path) ||
        typeof file.mime !== "string" ||
        !/^(image|video|audio)\/[a-z0-9.+-]+$/i.test(file.mime)
      )
        throw new Error("原生素材必须包含绝对路径和有效的媒体 MIME 类型");
      const resolved = await realpath(file.path);
      const relative = path.relative(root, resolved);
      if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        throw new Error(
          "原生素材必须位于本次 outputDir 内，请让适配器复制生成文件后返回",
        );
      const info = await stat(resolved);
      if (!info.isFile() || info.size === 0)
        throw new Error("原生适配器返回的素材不存在、为空或不是常规文件");
      files.push({
        path: resolved,
        mime: file.mime,
        name: optionalString(file.name, "file.name"),
      });
    }
    return {
      files,
      conversationId: optionalString(output.conversationId, "conversationId"),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once("close", () => resolve());
            this.stop(child);
          }),
      ),
    );
  }

  private stop(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }, 2_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }

  private async invoke(
    operation: "capabilities" | "generate",
    request?: ProviderRequest,
    context?: ProviderContext,
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error("原生适配器已关闭");
    if (context?.signal.aborted) throw abortError();
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.config.command, this.config.args, {
          cwd: this.config.cwd,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error);
        return;
      }
      this.children.add(child);
      let settled = false;
      let buffer = "";
      let bytes = 0;
      let terminal: Record<string, unknown> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context?.signal.removeEventListener("abort", onAbort);
        if (error) {
          this.stop(child);
          reject(error);
        } else if (terminal) resolve(terminal);
        else
          reject(
            new Error("原生适配器已退出，但没有返回结果；请检查适配器协议"),
          );
      };
      const onAbort = () => finish(abortError());
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              operation === "capabilities"
                ? "原生适配器能力探测超时（10 秒）"
                : "原生适配器生成超时（30 分钟）；请先检查 Muse 中的任务再决定是否重试",
            ),
          ),
        operation === "capabilities" ? 10_000 : 30 * 60_000,
      );
      const consume = (line: string) => {
        if (!line.trim() || settled) return;
        try {
          const event = record(JSON.parse(line));
          if (terminal)
            throw new Error("原生适配器在最终结果之后继续输出协议事件");
          if (event.type === "error")
            throw new Error(
              typeof event.message === "string"
                ? event.message
                : "原生适配器调用失败",
            );
          if (operation === "capabilities") {
            if (event.type !== "capabilities")
              throw new Error("能力探测必须返回 capabilities 事件");
            terminal = event;
          } else if (event.type === "submitted") {
            context?.onSubmitted(
              optionalString(event.conversationId, "conversationId"),
            );
          } else if (event.type === "progress") {
            if (
              typeof event.message !== "string" ||
              event.message.length > 10_000
            )
              throw new Error("原生适配器进度格式无效");
            context?.onProgress(event.message);
          } else if (event.type === "result") terminal = event;
          else throw new Error("原生适配器输出了未知协议事件");
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      context?.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT) {
          finish(new Error("原生适配器输出超过 2 MB，请仅返回进度和素材路径"));
          return;
        }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          consume(line);
        }
      });
      // Drain stderr without putting possibly sensitive native logs into API responses.
      child.stderr.on("data", () => {});
      child.stdin.on("error", (error) =>
        finish(new Error(`无法向原生适配器发送请求：${error.message}`)),
      );
      child.on("error", (error) =>
        finish(new Error(`无法启动原生适配器：${error.message}`)),
      );
      child.once("close", (code, signal) => {
        this.children.delete(child);
        if (settled) return;
        consume(buffer);
        if (settled) return;
        if (code !== 0) {
          finish(
            new Error(
              `原生适配器退出异常（${signal || code}）；请检查适配器本地日志`,
            ),
          );
          return;
        }
        finish();
      });
      child.once("spawn", () => {
        if (settled) return;
        try {
          // Once dispatched, a lost response must not cause an automatic billable retry.
          if (operation === "generate") context?.onSubmitted();
          child.stdin.end(
            `${JSON.stringify({ protocol: PROTOCOL, operation, ...(request ? { request, outputDir: context!.outputDir } : {}) })}\n`,
          );
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      if (context?.signal.aborted) onAbort();
    });
  }
}
