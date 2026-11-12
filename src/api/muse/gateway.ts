import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createNoiseSession, type NoiseTransport } from "./noise.ts";
import {
  encodeRequest,
  packChunks,
  decodeChunk,
  decodeResponse,
} from "./wire.ts";
import {
  apiDependency,
  checkedProxy,
  type GatewayCredentials,
} from "./auth.ts";

export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}
export interface GatewayReply {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}
export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onHeaders?: (status: number, headers: Record<string, string>) => void;
  onData?: (data: Uint8Array) => Promise<void> | void;
}
interface Pending {
  status?: number;
  headers: Record<string, string>;
  parts: Uint8Array[];
  bytes: number;
  options: RequestOptions;
  finish: (error?: Error) => void;
}
interface Assembly {
  count: number;
  chunks: Map<number, Uint8Array>;
  size: number;
  at: number;
}

export class MuseGateway {
  private socket: WebSocket;
  private crypto?: NoiseTransport;
  private pending = new Map<number, Pending>();
  private assemblies = new Map<string, Assembly>();
  private nextStream = 1;
  private sending: Promise<void> = Promise.resolve();
  private receiving: Promise<void> = Promise.resolve();
  private handshakeFrames: Uint8Array[] = [];
  private handshakeWaiter?: {
    resolve: (value: Uint8Array) => void;
    reject: (error: Error) => void;
  };
  private failure?: Error;
  private dispatcher?: { close(): Promise<void>; destroy?(): Promise<void> };

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("error", () =>
      this.fail(new GatewayError("Muse 网关连接异常。")),
    );
    socket.addEventListener("close", () =>
      this.fail(
        new GatewayError("Muse 网关连接已关闭；已提交的任务不会自动重发。"),
      ),
    );
    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        this.fail(new GatewayError("Muse 网关返回了未知的消息格式。"));
        return;
      }
      const data = new Uint8Array(event.data);
      if (data.length > 65535) {
        this.fail(new GatewayError("Muse 网关帧超过协议上限。"));
        return;
      }
      if (!this.crypto) {
        if (this.handshakeWaiter) {
          const waiter = this.handshakeWaiter;
          this.handshakeWaiter = undefined;
          waiter.resolve(data);
        } else if (this.handshakeFrames.length < 4)
          this.handshakeFrames.push(data);
        else this.fail(new GatewayError("Muse 网关握手响应异常。"));
        return;
      }
      this.receiving = this.receiving
        .then(() => this.receive(data))
        .catch(() =>
          this.fail(new GatewayError("Muse 网关协议不兼容或连接数据损坏。")),
        );
    });
  }

  static async connect(
    credentials: GatewayCredentials,
    options: { proxy?: string; signal?: AbortSignal } = {},
  ): Promise<MuseGateway> {
    options.signal?.throwIfAborted();
    const query = new URLSearchParams({
      vm_id: credentials.vmId,
      auth_token: credentials.token,
      app_id: "hatch-web",
      request_id: randomUUID(),
    });
    if (credentials.notaryToken)
      query.set("notary_token", credentials.notaryToken);
    const proxy = checkedProxy(options.proxy);
    let dispatcher:
      { close(): Promise<void>; destroy?(): Promise<void> } | undefined;
    if (proxy) dispatcher = new (apiDependency("undici").ProxyAgent)(proxy);
    // Node's built-in WebSocket supports Undici's WebSocketInit extension.
    const NativeSocket = WebSocket as unknown as new (
      url: string,
      options: object,
    ) => WebSocket;
    const socket = new NativeSocket(
      `wss://hatch.metaaivm.com/v1/noise?${query}`,
      {
        headers: { Origin: "https://muse.ai" },
        ...(dispatcher ? { dispatcher } : {}),
      },
    );
    const gateway = new MuseGateway(socket);
    gateway.dispatcher = dispatcher;
    try {
      await gateway.initialize(options.signal);
      return gateway;
    } catch {
      await gateway.close();
      options.signal?.throwIfAborted();
      throw new GatewayError(
        "Muse 加密网关连接失败，可能需要重新登录、人工验证或更新协议适配。",
      );
    }
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    const connectionSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    if (this.socket.readyState !== WebSocket.OPEN)
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.socket.removeEventListener("open", open);
          this.socket.removeEventListener("close", closed);
          this.socket.removeEventListener("error", closed);
          connectionSignal.removeEventListener("abort", abort);
        };
        const open = () => {
          cleanup();
          resolve();
        };
        const closed = () => {
          cleanup();
          reject(new GatewayError("Muse 网关无法建立连接。"));
        };
        const abort = () => {
          cleanup();
          reject(new GatewayError("Muse 网关连接超时或已取消。"));
        };
        this.socket.addEventListener("open", open, { once: true });
        this.socket.addEventListener("close", closed, { once: true });
        this.socket.addEventListener("error", closed, { once: true });
        connectionSignal.addEventListener("abort", abort, { once: true });
        if (connectionSignal.aborted) abort();
      });
    this.crypto = await createNoiseSession({
      send: (frame) => {
        connectionSignal.throwIfAborted();
        if (this.failure) throw this.failure;
        this.socket.send(new Uint8Array(frame).buffer);
      },
      receive: async () => {
        if (this.failure) throw this.failure;
        if (this.handshakeFrames.length) return this.handshakeFrames.shift()!;
        return await new Promise<Uint8Array>((resolve, reject) => {
          const abort = () => {
            this.handshakeWaiter = undefined;
            reject(new GatewayError("Muse 网关握手超时或已取消。"));
          };
          this.handshakeWaiter = {
            resolve: (data) => {
              connectionSignal.removeEventListener("abort", abort);
              resolve(data);
            },
            reject: (error) => {
              connectionSignal.removeEventListener("abort", abort);
              reject(error);
            },
          };
          connectionSignal.addEventListener("abort", abort, { once: true });
          if (connectionSignal.aborted) abort();
        });
      },
    });
    for (const frame of this.handshakeFrames.splice(0))
      this.receiving = this.receiving.then(() => this.receive(frame));
    await this.receiving;
  }

  isOpen(): boolean {
    return (
      !this.failure &&
      !!this.crypto &&
      this.socket.readyState === WebSocket.OPEN
    );
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.handshakeWaiter?.reject(error);
    this.handshakeWaiter = undefined;
    for (const state of [...this.pending.values()]) state.finish(error);
    this.assemblies.clear();
    this.crypto?.destroy();
    this.crypto = undefined;
    this.socket.close();
  }

  private async receive(encrypted: Uint8Array): Promise<void> {
    if (!this.crypto) return;
    const part = decodeChunk(this.crypto.decrypt(encrypted));
    for (const [id, assembly] of this.assemblies)
      if (Date.now() - assembly.at > 60_000) this.assemblies.delete(id);
    let assembly = this.assemblies.get(part.messageId);
    if (!assembly) {
      if (this.assemblies.size >= 64)
        throw new Error("Too many incomplete gateway messages");
      assembly = {
        count: part.count,
        chunks: new Map(),
        size: 0,
        at: Date.now(),
      };
      this.assemblies.set(part.messageId, assembly);
    }
    if (assembly.count !== part.count || assembly.chunks.has(part.index))
      throw new Error("Inconsistent gateway chunk");
    assembly.chunks.set(part.index, part.payload);
    assembly.size += part.payload.length;
    if (
      assembly.size > 16 * 1024 * 1024 ||
      [...this.assemblies.values()].reduce((sum, item) => sum + item.size, 0) >
        32 * 1024 * 1024
    )
      throw new Error("Gateway message too large");
    if (assembly.chunks.size !== assembly.count) return;
    this.assemblies.delete(part.messageId);
    const bytes = Buffer.concat(
      Array.from({ length: assembly.count }, (_, index) =>
        Buffer.from(assembly!.chunks.get(index)!),
      ),
      assembly.size,
    );
    const response = decodeResponse(bytes);
    const state = this.pending.get(response.streamId);
    if (!state) return; // A timed-out read can still have buffered responses.
    if (response.reset) {
      state.finish(
        new GatewayError(`Muse 请求中断（${response.reset.code}）。`),
      );
      return;
    }
    try {
      if (response.status !== undefined) {
        state.status = response.status;
        state.headers = response.headers ?? {};
        state.options.onHeaders?.(state.status, state.headers);
      }
      if (response.data?.length) {
        state.bytes += response.data.length;
        if (state.bytes > (state.options.maxBytes ?? 8 * 1024 * 1024))
          throw new GatewayError("Muse 返回内容超过当前请求的大小上限。");
        if (state.options.onData) await state.options.onData(response.data);
        else state.parts.push(response.data);
      }
      if (response.end)
        state.finish(
          state.status === undefined
            ? new GatewayError("Muse 响应缺少状态码。")
            : undefined,
        );
    } catch (error) {
      state.finish(
        error instanceof GatewayError
          ? error
          : new GatewayError("无法处理 Muse 响应内容。"),
      );
    }
  }

  request(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<GatewayReply> {
    options.signal?.throwIfAborted();
    if (!this.isOpen())
      return Promise.reject(new GatewayError("Muse 网关尚未连接。"));
    if (!route.startsWith("/") || route.includes("\0") || /[\r\n]/.test(route))
      return Promise.reject(new GatewayError("无效的 Muse 请求路径。"));
    const content = body === undefined ? undefined : JSON.stringify(body);
    if (content && Buffer.byteLength(content) > 2 * 1024 * 1024)
      return Promise.reject(new GatewayError("Muse 单次请求内容过大。"));
    const streamId = this.nextStream++;
    const frame = encodeRequest(streamId, {
      method,
      path: route,
      headers: {
        "x-app-id": "hatch-web",
        "accept-encoding": "identity",
        ...(content ? { "content-type": "application/json" } : {}),
      },
      ...(content ? { body: content } : {}),
    });
    return new Promise<GatewayReply>((resolve, reject) => {
      let done = false;
      const abort = () =>
        finish(new GatewayError("Muse 请求已取消；已提交的生成可能仍在运行。"));
      const timer = setTimeout(
        () =>
          finish(
            new GatewayError("等待 Muse 响应超时；不会自动重复提交生成。"),
          ),
        options.timeoutMs ?? 30_000,
      );
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        this.pending.delete(streamId);
        if (error) reject(error);
        else
          resolve({
            status: state.status!,
            headers: state.headers,
            body: options.onData
              ? new Uint8Array()
              : Buffer.concat(state.parts, state.bytes),
          });
      };
      const state: Pending = {
        headers: {},
        parts: [],
        bytes: 0,
        options,
        finish,
      };
      this.pending.set(streamId, state);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      const sending = this.sending.then(async () => {
        for (const chunk of packChunks(frame)) {
          if (done) return;
          while (this.socket.bufferedAmount > 2 * 1024 * 1024) {
            if (done || !this.isOpen()) return;
            await delay(10);
          }
          if (!this.isOpen() || !this.crypto)
            throw new GatewayError("Muse 网关连接已中断。");
          this.socket.send(new Uint8Array(this.crypto.encrypt(chunk)).buffer);
        }
      });
      this.sending = sending.catch(() => undefined);
      void sending.catch(() =>
        finish(new GatewayError("Muse 请求发送未能确认；不会自动重发。")),
      );
    });
  }

  async json(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ status: number; data: unknown }> {
    const response = await this.request(method, route, body, options);
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(response.body));
    } catch {
      throw new GatewayError("Muse 返回的 JSON 结构无法识别。");
    }
    return { status: response.status, data };
  }

  async close(): Promise<void> {
    this.fail(new GatewayError("Muse 网关已关闭。"));
    const closing = this.dispatcher?.destroy
      ? this.dispatcher.destroy()
      : this.dispatcher?.close();
    await closing?.catch(() => undefined);
    this.dispatcher = undefined;
  }
}
