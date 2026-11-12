import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  GenerationProvider,
  MuseProviderConfig,
  ProviderContext,
  ProviderRequest,
  ProviderResult,
  ProviderStatus,
} from "../types.ts";
import {
  MuseBrowserAuth,
  MuseAuthError,
  type GatewayCredentials,
} from "./auth.ts";
import {
  MuseGateway,
  GatewayError,
  type GatewayReply,
  type RequestOptions,
} from "./gateway.ts";

const MAX_MEDIA = 200 * 1024 * 1024;
const CAPABILITIES = ["video", "image", "edit", "extend"] as const;
const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "error",
]);
const object = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : undefined;

interface RemoteFile {
  path: string;
  mime: string;
  name: string;
}
interface Turn {
  text: string;
  createdAt?: number;
  files: RemoteFile[];
  inputs: string[];
  terminal?: string;
  taskStatus?: string;
}
interface Channel {
  isOpen(): boolean;
  request(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<GatewayReply>;
  json(
    method: "GET" | "POST",
    route: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<{ status: number; data: unknown }>;
  close(): Promise<void>;
}
interface Auth {
  credentials(signal: AbortSignal): Promise<GatewayCredentials>;
  close(): Promise<void>;
}
export interface ProviderDependencies {
  auth?: Auth;
  connect?: (
    credentials: GatewayCredentials,
    signal: AbortSignal,
  ) => Promise<Channel>;
  pollMs?: number;
  runTimeoutMs?: number;
}

export function workspaceFile(value: string): string | null {
  let result = value;
  if (result.startsWith("sandbox://"))
    result = result.slice("sandbox://".length);
  else if (/^https?:\/\//.test(result)) {
    try {
      const url = new URL(result);
      if (url.origin !== "https://muse.ai") return null;
      result = url.pathname;
    } catch {
      return null;
    }
  }
  result = result.replace(/^\/(?:fs|media)\/raw\//, "/");
  if (!result.startsWith("/")) result = "/" + result;
  try {
    result = decodeURIComponent(result);
  } catch {
    return null;
  }
  if (
    !result.startsWith("/workspace/") ||
    result.length > 2000 ||
    /[\\\u0000-\u001f?#]/.test(result) ||
    result.split("/").some((part) => part === ".." || part === ".")
  )
    return null;
  return result;
}

function collectFiles(value: unknown): RemoteFile[] {
  const found = new Map<string, RemoteFile>();
  let visited = 0;
  const visit = (input: unknown, depth: number) => {
    if (++visited > 50_000 || depth > 14)
      throw new GatewayError("Muse 历史记录结构超出限制。");
    if (Array.isArray(input)) {
      for (const item of input) visit(item, depth + 1);
      return;
    }
    const record = object(input);
    if (!record) return;
    if (typeof record.path === "string") {
      const file = workspaceFile(record.path);
      if (file && !found.has(file))
        found.set(file, {
          path: file,
          mime:
            typeof (record.mime_type ?? record.mime) === "string"
              ? (record.mime_type ?? record.mime).slice(0, 100)
              : "",
          name: path.posix
            .basename(String(record.filename ?? record.name ?? file))
            .slice(0, 200),
        });
    }
    for (const nested of Object.values(record))
      if (nested && typeof nested === "object") visit(nested, depth + 1);
  };
  visit(value, 0);
  return [...found.values()];
}

export function historyTurns(data: unknown): Turn[] {
  const events = object(object(data)?.result)?.chat_events;
  if (!Array.isArray(events) || events.length > 20_000)
    throw new GatewayError("Muse 会话历史格式尚未适配。");
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const item of events) {
    const event = object(item);
    if (!event) throw new GatewayError("Muse 会话事件格式无效。");
    const name = event.event_name ?? event.event;
    if (name === "message.user") {
      const text =
        typeof event.display_text === "string" ? event.display_text : "";
      const created = event.created_at_ms ?? event.display_text_updated_at_ms;
      current = {
        text,
        files: [],
        inputs: collectFiles(event).map((file) => file.path),
        ...(typeof created === "number" && Number.isFinite(created)
          ? { createdAt: created }
          : {}),
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    const payload = object(event.payload);
    const status = payload?.status ?? event.status;
    if (name === "task.status")
      current.taskStatus = current.terminal =
        typeof status === "string" ? status : undefined;
    if (name === "message.assistant") {
      const metadata = object(payload?.metadata ?? event.metadata);
      if (
        metadata?.message_kind !== "commentary" &&
        event.display_text_ready === true &&
        TERMINAL.has(status)
      )
        current.terminal = status;
    }
    for (const file of collectFiles(event))
      if (!current.files.some((other) => other.path === file.path))
        current.files.push(file);
  }
  for (const turn of turns)
    if (turn.taskStatus) turn.terminal = turn.taskStatus;
  return turns;
}

function samePrompt(actual: string, expected: string): boolean {
  const withoutMarkers = actual.replace(
    /^(?:\[[A-Za-z][A-Za-z_-]*:[^\]\r\n]+\]\r?\n)+/,
    "",
  );
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return normalize(withoutMarkers) === normalize(expected);
}

export function mediaFormat(
  bytes: Uint8Array,
): { mime: string; extension: string } | undefined {
  const prefix = Buffer.from(bytes);
  if (prefix.subarray(4, 8).toString("ascii") === "ftyp")
    return { mime: "video/mp4", extension: "mp4" };
  if (prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return { mime: "video/webm", extension: "webm" };
  if (
    prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { mime: "image/png", extension: "png" };
  if (prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff)
    return { mime: "image/jpeg", extension: "jpg" };
  if (
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { mime: "image/webp", extension: "webp" };
  return undefined;
}

export class MuseGatewayProvider implements GenerationProvider {
  private config: MuseProviderConfig;
  private auth: Auth;
  private connect: NonNullable<ProviderDependencies["connect"]>;
  private channel?: Channel;
  private opening?: Promise<Channel>;
  private active = false;
  private closed = false;
  private shutdown = new AbortController();
  private pollMs: number;
  private timeoutMs: number;
  constructor(
    config: MuseProviderConfig,
    dependencies: ProviderDependencies = {},
  ) {
    this.config = config;
    this.auth = dependencies.auth ?? new MuseBrowserAuth(config);
    this.connect =
      dependencies.connect ??
      ((credentials, signal) =>
        MuseGateway.connect(credentials, { proxy: config.proxy, signal }));
    this.pollMs = dependencies.pollMs ?? 3000;
    this.timeoutMs = dependencies.runTimeoutMs ?? 25 * 60_000;
  }

  private async connected(signal: AbortSignal): Promise<Channel> {
    if (this.closed) throw new GatewayError("Muse 服务已关闭。");
    signal = AbortSignal.any([signal, this.shutdown.signal]);
    if (this.channel?.isOpen()) return this.channel;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      await this.channel?.close();
      const credentials = await this.auth.credentials(signal);
      signal.throwIfAborted();
      const channel = await this.connect(credentials, signal);
      if (this.closed || signal.aborted) {
        await channel.close();
        throw new GatewayError("Muse 服务已关闭。");
      }
      this.channel = channel;
      return channel;
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  async status(signal?: AbortSignal): Promise<ProviderStatus> {
    try {
      signal = AbortSignal.any([
        signal ?? AbortSignal.timeout(180_000),
        this.shutdown.signal,
      ]);
      const channel = await this.connected(signal);
      const reply = await channel.json(
        "GET",
        "/api/session/list?limit=1",
        undefined,
        { signal },
      );
      if (
        reply.status !== 200 ||
        !Array.isArray(object(object(reply.data)?.result)?.sessions)
      )
        throw new GatewayError("Muse 会话查询未返回可识别的数据。");
      return {
        state: "ready",
        message:
          "Muse 已登录，加密网关与会话查询可用。画幅和时长通过提示词提出，实际生成结果由 Muse 决定。",
        capabilities: [...CAPABILITIES],
        aspects: ["9:16", "16:9", "1:1"],
      };
    } catch (error) {
      return {
        state: error instanceof MuseAuthError ? error.state : "error",
        message:
          error instanceof MuseAuthError || error instanceof GatewayError
            ? error.message
            : "Muse 连接检查失败。",
        capabilities: [],
      };
    }
  }

  private async history(
    channel: Channel,
    id: string,
    signal: AbortSignal,
    allowMissing = false,
  ): Promise<Turn[]> {
    const reply = await channel.json(
      "GET",
      `/chat/history?session_id=${encodeURIComponent(id)}&limit=200`,
      undefined,
      { signal },
    );
    if (reply.status === 404 && allowMissing) return [];
    if (reply.status !== 200)
      throw new GatewayError(
        `无法读取 Muse 会话历史（HTTP ${reply.status}）。`,
      );
    return historyTurns(reply.data);
  }

  private async upload(
    channel: Channel,
    reference: ProviderRequest["references"][number],
    context: ProviderContext,
  ): Promise<Record<string, string>> {
    const stat = await fs.stat(reference.path);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MEDIA)
      throw new Error("参考素材不可读取或超过 200 MB。");
    const file = await fs.open(reference.path, "r");
    let remotePart: string | undefined;
    try {
      const head = Buffer.alloc(64);
      const read = await file.read(head, 0, head.length, 0);
      const format = mediaFormat(head.subarray(0, read.bytesRead));
      if (!format || format.mime !== reference.mime)
        throw new Error(
          "参考素材内容与声明格式不一致；支持 PNG、JPEG、WebP、MP4 和 WebM。",
        );
      if (format.mime.startsWith("image/") && stat.size <= 256 * 1024) {
        return {
          type: "image",
          mime_type: format.mime,
          filename: reference.name.slice(0, 120),
          data_base64: (await fs.readFile(reference.path)).toString("base64"),
        };
      }
      const identifier = randomUUID();
      remotePart = `workspace/user/files/senmuse-${identifier}.part`;
      const destination = `workspace/user/files/senmuse-${identifier}.${format.extension}`;
      let offset = 0;
      const buffer = Buffer.alloc(384 * 1024);
      while (offset < stat.size) {
        context.signal.throwIfAborted();
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, stat.size - offset),
          offset,
        );
        if (!bytesRead) throw new Error("参考素材在上传期间发生变化。");
        await this.fsOperation(
          channel,
          "write",
          {
            path: remotePart,
            data_base64: buffer.subarray(0, bytesRead).toString("base64"),
            overwrite: offset === 0,
            append: offset !== 0,
            create_parent: offset === 0,
          },
          context.signal,
        );
        offset += bytesRead;
        context.onProgress(
          `正在上传参考素材：${Math.round((offset / stat.size) * 100)}%`,
        );
      }
      const remote = await this.fsOperation(
        channel,
        "stat",
        { path: remotePart },
        context.signal,
      );
      if (remote.size !== stat.size || remote.kind !== "file")
        throw new GatewayError("Muse 收到的参考素材大小不一致。");
      await this.fsOperation(
        channel,
        "rename",
        {
          source: remotePart,
          destination,
          create_parent: true,
          overwrite: false,
        },
        context.signal,
      );
      remotePart = undefined;
      return {
        type: "file_ref",
        mime_type: format.mime,
        filename: reference.name.slice(0, 120),
        path: destination,
      };
    } finally {
      await file.close();
      if (remotePart)
        await this.fsOperation(
          channel,
          "delete",
          { path: remotePart, recursive: false },
          AbortSignal.timeout(5000),
        ).catch(() => undefined);
    }
  }

  private async fsOperation(
    channel: Channel,
    operation: string,
    body: object,
    signal: AbortSignal,
  ): Promise<Record<string, any>> {
    const reply = await channel.json("POST", `/fs/${operation}`, body, {
      signal,
      timeoutMs: 120_000,
    });
    if (reply.status !== 200 || object(reply.data)?.ok !== true)
      throw new GatewayError(
        `Muse 文件操作 ${operation} 未成功（HTTP ${reply.status}）。`,
      );
    return object(object(reply.data)?.result) ?? {};
  }

  private prompt(request: ProviderRequest): string {
    const instruction =
      request.kind === "image"
        ? "请生成图片，并返回可下载的图片文件。"
        : request.kind === "edit"
          ? "请修改附上的 MP4 源视频，并返回修改后的完整 MP4 文件。"
          : request.kind === "extend"
            ? "请在本会话最新视频结尾继续拍摄，保持人物、场景连贯，返回包含原片与续拍内容的完整 MP4 文件。"
            : "请生成视频，并返回可下载的 MP4 文件；如有附图，请用作画面参考。";
    const parameters = [
      request.aspect ? `目标画幅：${request.aspect}。` : "",
      request.duration ? `目标时长：${request.duration} 秒。` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return `${instruction}\n${parameters ? parameters + "\n" : ""}创作要求：${request.prompt}`;
  }

  async run(
    request: ProviderRequest,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    if (this.closed) throw new GatewayError("Muse 服务已关闭。");
    context = {
      ...context,
      signal: AbortSignal.any([context.signal, this.shutdown.signal]),
    };
    if (this.active) throw new Error("当前 Muse 账号已有生成任务运行。");
    if (
      !CAPABILITIES.includes(request.kind) ||
      !request.prompt.trim() ||
      request.prompt.length > 12000
    )
      throw new Error("生成类型或提示词无效。");
    if (request.references.length > 4)
      throw new Error("每次最多上传 4 个参考素材。");
    const videos = request.references.filter((file) =>
      file.mime.startsWith("video/"),
    );
    if (
      request.kind === "edit" &&
      (videos.length !== 1 || videos[0].mime !== "video/mp4")
    )
      throw new Error("视频修改必须提供一个 MP4 源视频。");
    if (
      ["image", "video"].includes(request.kind) &&
      request.references.some((file) => !file.mime.startsWith("image/"))
    )
      throw new Error("文生与图生任务只接受图片参考。");
    if (
      request.references.some(
        (file) =>
          !/^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm))$/.test(file.mime),
      )
    )
      throw new Error("Muse 生成参考素材格式不支持。");
    if (
      request.kind === "extend" &&
      !/^[A-Za-z0-9_-]{1,128}$/.test(request.conversationId ?? "")
    )
      throw new Error("续拍必须提供原 Muse conversationId。");
    this.active = true;
    const output: ProviderResult["files"] = [];
    try {
      context.signal.throwIfAborted();
      const channel = await this.connected(context.signal);
      let conversationId =
        request.kind === "extend" ? request.conversationId! : randomUUID();
      const baseline = await this.history(
        channel,
        conversationId,
        context.signal,
        request.kind !== "extend",
      );
      if (
        request.kind === "extend" &&
        !baseline
          .at(-1)
          ?.files.some(
            (file) =>
              file.mime.startsWith("video/") ||
              /\.(?:mp4|webm)$/i.test(file.path),
          )
      )
        throw new Error("原会话最新一轮没有可确认的视频，不能安全续拍。");
      const existingPaths = new Set(
        baseline.flatMap((turn) => turn.files.map((file) => file.path)),
      );
      const items: Record<string, string>[] = [];
      for (const reference of request.references)
        items.push(await this.upload(channel, reference, context));
      for (const item of items) {
        const uploaded =
          item.type === "file_ref" ? workspaceFile(item.path) : null;
        if (uploaded) existingPaths.add(uploaded);
      }
      const prompt = this.prompt(request);
      items.push({ type: "text", text: prompt });
      context.signal.throwIfAborted();
      context.onSubmitted(conversationId);
      context.onProgress("已记录提交意图，正在向 Muse 发送生成请求。");
      // No retry surrounds this mutation. A lost acknowledgement requires review.
      const sent = await channel.request(
        "POST",
        "/chat/stream",
        {
          session_id: conversationId,
          node_id: "senmuse",
          items,
          capabilities: [
            "chat_cancel",
            "delta_stream",
            "custom_reactions",
            "custom_reactions_facebook_thumbs_up_v1",
          ],
          timezone: "UTC",
        },
        { signal: context.signal, timeoutMs: 120_000 },
      );
      if (sent.status !== 200)
        throw new GatewayError(
          `Muse 未确认生成请求（HTTP ${sent.status}）；请检查原会话。`,
        );
      const lines = new TextDecoder()
        .decode(sent.body)
        .split(/\r?\n/)
        .filter((line) => line.trim());
      let ack: Record<string, any> | undefined;
      for (const line of lines) {
        let record: Record<string, any> | undefined;
        try {
          record = object(JSON.parse(line));
        } catch {
          throw new GatewayError("Muse 提交确认格式无法识别，请检查原会话。");
        }
        if (record?.error || record?.ok === false)
          throw new GatewayError(
            "Muse 拒绝或未能完成此生成请求，请检查原会话。",
          );
        if (typeof record?.session_id === "string") ack = record;
      }
      if (!ack || !/^[A-Za-z0-9_-]{1,128}$/.test(ack.session_id))
        throw new GatewayError(
          "Muse 没有返回可确认的会话标识，请检查提交状态。",
        );
      if (request.kind === "extend" && ack.session_id !== conversationId)
        throw new GatewayError("Muse 返回的续拍会话发生变化，请人工检查。");
      conversationId = ack.session_id;
      context.onSubmitted(conversationId);
      context.onProgress("Muse 已接收请求，正在等待真实生成文件。");
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        await delay(this.pollMs, undefined, { signal: context.signal });
        const turns = await this.history(
          channel,
          conversationId,
          context.signal,
        );
        if (turns.length <= baseline.length) continue;
        if (
          turns.length !== baseline.length + 1 ||
          !samePrompt(turns[baseline.length].text, prompt)
        )
          throw new GatewayError(
            "Muse 会话出现其他用户消息，无法安全归属结果，请检查原会话。",
          );
        const turn = turns[baseline.length];
        let terminal = turn.terminal;
        if (!TERMINAL.has(terminal ?? "") && turn.createdAt !== undefined) {
          const list = await channel.json(
            "GET",
            "/api/session/list?limit=50",
            undefined,
            { signal: context.signal },
          );
          const sessions = object(object(list.data)?.result)?.sessions;
          if (list.status !== 200 || !Array.isArray(sessions))
            throw new GatewayError("Muse 会话状态格式无法识别。");
          const session = sessions
            .map(object)
            .find((item) => item?.session_id === conversationId);
          if (
            session &&
            typeof session.updated_at_ms === "number" &&
            session.updated_at_ms >= Math.floor(turn.createdAt / 1000) * 1000 &&
            (session.status !== "completed" || turn.files.length)
          )
            terminal = session.status;
        }
        if (!TERMINAL.has(terminal ?? "")) continue;
        if (terminal !== "completed")
          throw new GatewayError(
            "Muse 报告本次生成未完成，请检查会话中的说明。",
          );
        const prefix = request.kind === "image" ? "image/" : "video/";
        const extensions =
          request.kind === "image"
            ? /\.(?:png|jpe?g|webp)$/i
            : /\.(?:mp4|webm)$/i;
        const files = turn.files.filter(
          (file) =>
            !existingPaths.has(file.path) &&
            !turn.inputs.includes(file.path) &&
            (file.mime.startsWith(prefix) || extensions.test(file.path)),
        );
        if (!files.length || files.length > 4)
          throw new GatewayError(
            "Muse 已结束回复，但未返回 1–4 个可确认的新生成素材。",
          );
        context.onProgress("正在从 Muse 下载生成文件。");
        for (const file of files)
          output.push(await this.download(channel, file, prefix, context));
        return { conversationId, files: output };
      }
      throw new GatewayError(
        "等待 Muse 生成超过 25 分钟；请检查原会话，任务不会自动重发。",
      );
    } catch (error) {
      for (const file of output)
        await fs.unlink(file.path).catch(() => undefined);
      throw error;
    } finally {
      this.active = false;
    }
  }

  private async download(
    channel: Channel,
    remote: RemoteFile,
    expectedPrefix: string,
    context: ProviderContext,
  ): Promise<ProviderResult["files"][number]> {
    const temporary = path.join(context.outputDir, `.${randomUUID()}.download`);
    const file = await fs.open(temporary, "wx", 0o600);
    let prefix = Buffer.alloc(0);
    let total = 0;
    try {
      const response = await channel.request(
        "GET",
        "/fs/raw" + remote.path.split("/").map(encodeURIComponent).join("/"),
        undefined,
        {
          signal: context.signal,
          timeoutMs: 5 * 60_000,
          maxBytes: MAX_MEDIA,
          onHeaders(status, headers) {
            if (
              status !== 200 ||
              Number(headers["content-length"] ?? 0) > MAX_MEDIA
            )
              throw new GatewayError("Muse 下载响应无效或文件超过 200 MB。");
          },
          async onData(chunk) {
            total += chunk.length;
            if (total > MAX_MEDIA)
              throw new GatewayError("Muse 生成文件超过 200 MB。");
            if (prefix.length < 64)
              prefix = Buffer.concat([prefix, chunk]).subarray(0, 64);
            await file.writeFile(chunk);
          },
        },
      );
      const size = Number(response.headers["content-length"]);
      if (!total || (Number.isFinite(size) && size !== total))
        throw new GatewayError("Muse 生成文件下载不完整。");
      const format = mediaFormat(prefix);
      if (!format || !format.mime.startsWith(expectedPrefix))
        throw new GatewayError("Muse 返回文件没有通过媒体格式检查。");
      await file.close();
      const destination = path.join(
        context.outputDir,
        `${randomUUID()}.${format.extension}`,
      );
      await fs.rename(temporary, destination);
      return {
        path: destination,
        mime: format.mime,
        name: remote.name || path.basename(destination),
      };
    } finally {
      await file.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort(new Error("Muse 服务已关闭。"));
    const opening = this.opening;
    await Promise.allSettled([this.channel?.close(), this.auth.close()]);
    await opening?.catch(() => undefined);
    await this.channel?.close();
    this.channel = undefined;
  }
}
