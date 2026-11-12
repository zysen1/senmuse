import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MuseGatewayProvider,
  historyTurns,
  workspaceFile,
} from "../src/api/muse/provider.ts";
import { checkedCdp, checkedProxy } from "../src/api/muse/auth.ts";
import type { ProviderRequest, ProviderContext } from "../src/api/types.ts";
import {
  MuseGateway,
  type GatewayReply,
  type RequestOptions,
} from "../src/api/muse/gateway.ts";
import { fieldData, fieldNumber, packChunks } from "../src/api/muse/wire.ts";

// These tests isolate gateway framing/multiplexing. Real cryptography has separate
// published interoperability-vector tests in gateway-crypto.test.ts.
vi.mock("../src/api/muse/noise.ts", () => ({
  createNoiseSession: async () => ({
    encrypt: (data: Uint8Array) => data,
    decrypt: (data: Uint8Array) => data,
    destroy() {},
  }),
}));

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom"),
  Buffer.alloc(32),
]);
const input = (changes: Partial<ProviderRequest> = {}): ProviderRequest => ({
  kind: "video",
  prompt: "一只猫向镜头挥手",
  requestId: "test-request",
  referenceIds: [],
  jobId: "job",
  references: [],
  ...changes,
});
async function context(): Promise<ProviderContext> {
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "senmuse-gateway-"),
  );
  directories.push(outputDir);
  return {
    outputDir,
    signal: AbortSignal.timeout(10_000),
    onSubmitted: vi.fn(),
    onProgress: vi.fn(),
  };
}
function fakeChannel(
  options: {
    ackLost?: boolean;
    extraUser?: boolean;
    content?: Buffer;
    incomplete?: boolean;
    failUpload?: boolean;
  } = {},
) {
  let prompt = "";
  let conversation = "";
  let submissions = 0;
  let uploaded = 0;
  const operations: string[] = [];
  return {
    operations,
    get submissions() {
      return submissions;
    },
    isOpen: () => true,
    close: async () => {},
    async request(
      _method: string,
      route: string,
      body?: any,
      settings?: RequestOptions,
    ): Promise<GatewayReply> {
      operations.push(route);
      if (route === "/chat/stream") {
        submissions++;
        prompt = body.items.find((item: any) => item.type === "text").text;
        conversation = body.session_id;
        if (options.ackLost) throw new Error("Disconnected after submission");
        return {
          status: 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify({
              session_id: conversation,
              is_thread: true,
              ok: true,
            }) + "\n",
          ),
        };
      }
      if (route.startsWith("/fs/raw/")) {
        const content = options.content ?? mp4;
        const headers = {
          "content-length": String(
            content.length + (options.incomplete ? 1 : 0),
          ),
        };
        settings?.onHeaders?.(200, headers);
        await settings?.onData?.(content.subarray(0, 9));
        await settings?.onData?.(content.subarray(9));
        return { status: 200, headers, body: new Uint8Array() };
      }
      throw new Error("Unexpected route " + route);
    },
    async json(_method: string, route: string, body?: any) {
      operations.push(route);
      if (route.startsWith("/chat/history")) {
        if (!submissions) return { status: 404, data: {} };
        const events: object[] = [
          {
            event_name: "message.user",
            display_text: prompt,
            created_at_ms: 1000,
          },
          {
            event_name: "message.assistant",
            display_text: "视频已生成",
            display_text_ready: true,
            status: "completed",
            payload: {
              videos: [
                {
                  path: "sandbox://workspace/user/generated/result.mp4",
                  mime_type: "video/mp4",
                },
              ],
            },
          },
        ];
        if (options.extraUser)
          events.push({ event_name: "message.user", display_text: "其他任务" });
        return { status: 200, data: { result: { chat_events: events } } };
      }
      if (route.startsWith("/api/session/list"))
        return {
          status: 200,
          data: {
            result: {
              sessions: [
                {
                  session_id: conversation,
                  status: "completed",
                  updated_at_ms: 2000,
                },
              ],
            },
          },
        };
      if (route === "/fs/write") {
        uploaded += Buffer.from(body.data_base64, "base64").length;
        return {
          status: options.failUpload ? 500 : 200,
          data: { ok: !options.failUpload },
        };
      }
      if (route === "/fs/stat")
        return {
          status: 200,
          data: { ok: true, result: { size: uploaded, kind: "file" } },
        };
      if (["/fs/rename", "/fs/delete"].includes(route))
        return { status: 200, data: { ok: true } };
      throw new Error("Unexpected JSON route " + route);
    },
  };
}
function provider(channel: ReturnType<typeof fakeChannel>) {
  return new MuseGatewayProvider(
    { type: "muse", profileDir: "/unused" },
    {
      auth: {
        credentials: async () => ({ vmId: "vm", token: "not-a-real-token" }),
        close: async () => {},
      },
      connect: async () => channel,
      pollMs: 1,
      runTimeoutMs: 200,
    },
  );
}

describe("Muse generation protocol orchestration", () => {
  it("records intent before submission, attributes the new turn and streams validated output to disk", async () => {
    const channel = fakeChannel();
    const ctx = await context();
    ctx.onSubmitted = vi.fn(() => {
      if (channel.submissions === 0)
        expect(
          channel.operations.some((route) => route === "/chat/stream"),
        ).toBe(false);
    });
    const result = await provider(channel).run(input(), ctx);
    expect(channel.submissions).toBe(1);
    expect(ctx.onSubmitted).toHaveBeenCalledTimes(2);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].mime).toBe("video/mp4");
    expect(await fs.readFile(result.files[0].path)).toEqual(mp4);
    expect(
      (await fs.readdir(ctx.outputDir)).some((name) =>
        name.endsWith(".download"),
      ),
    ).toBe(false);
  });

  it("does not automatically resend when submission acknowledgement is lost", async () => {
    const channel = fakeChannel({ ackLost: true });
    const ctx = await context();
    await expect(provider(channel).run(input(), ctx)).rejects.toThrow(
      "Disconnected",
    );
    expect(channel.submissions).toBe(1);
    expect(ctx.onSubmitted).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(ctx.outputDir)).toEqual([]);
  });

  it("refuses results from a conversation with another new user turn", async () => {
    const channel = fakeChannel({ extraUser: true });
    await expect(
      provider(channel).run(input(), await context()),
    ).rejects.toThrow("其他用户消息");
    expect(
      channel.operations.some((route) => route.startsWith("/fs/raw/")),
    ).toBe(false);
  });

  it.each([
    { content: Buffer.from("<html>not video</html>") },
    { incomplete: true },
  ])("cleans rejected media downloads (%j)", async (options) => {
    const ctx = await context();
    await expect(
      provider(fakeChannel(options)).run(input(), ctx),
    ).rejects.toThrow(/检查|不完整/);
    expect(await fs.readdir(ctx.outputDir)).toEqual([]);
  });

  it("uploads an MP4 in bounded workspace writes and verifies its size before an edit request", async () => {
    const ctx = await context();
    const source = path.join(ctx.outputDir, "source.mp4");
    await fs.writeFile(source, Buffer.concat([mp4, Buffer.alloc(800_000)]));
    const channel = fakeChannel();
    await provider(channel).run(
      input({
        kind: "edit",
        references: [{ path: source, mime: "video/mp4", name: "source.mp4" }],
      }),
      ctx,
    );
    expect(
      channel.operations.filter((route) => route === "/fs/write"),
    ).toHaveLength(3);
    expect(channel.operations.indexOf("/fs/stat")).toBeLessThan(
      channel.operations.indexOf("/chat/stream"),
    );
    expect(channel.operations.indexOf("/fs/rename")).toBeLessThan(
      channel.operations.indexOf("/chat/stream"),
    );
  });

  it("does not submit after a failed attachment upload and removes its partial workspace file", async () => {
    const ctx = await context();
    const source = path.join(ctx.outputDir, "source.mp4");
    await fs.writeFile(source, mp4);
    const channel = fakeChannel({ failUpload: true });
    await expect(
      provider(channel).run(
        input({
          kind: "edit",
          references: [{ path: source, mime: "video/mp4", name: "source.mp4" }],
        }),
        ctx,
      ),
    ).rejects.toThrow("write");
    expect(channel.submissions).toBe(0);
    expect(ctx.onSubmitted).not.toHaveBeenCalled();
    expect(channel.operations).toContain("/fs/delete");
  });

  it("reports readiness only after an authenticated gateway session-list response", async () => {
    expect(await provider(fakeChannel()).status()).toMatchObject({
      state: "ready",
      aspects: ["9:16", "16:9", "1:1"],
      message: expect.stringContaining("提示词"),
    });
    const channel = fakeChannel();
    channel.json = async () => ({ status: 401, data: {} });
    expect(await provider(channel).status()).toMatchObject({
      state: "error",
      capabilities: [],
    });
  });

  it("aborts a pending bootstrap when closing and never submits after closure", async () => {
    const ctx = await context();
    const channel = fakeChannel();
    let started!: () => void;
    const entering = new Promise<void>((resolve) => {
      started = resolve;
    });
    const instance = new MuseGatewayProvider(
      { type: "muse", profileDir: "/unused" },
      {
        auth: {
          credentials: async (signal) => {
            started();
            return await new Promise((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              }),
            );
          },
          close: async () => {},
        },
        connect: async () => channel,
      },
    );
    const job = instance.run(input(), ctx);
    const rejected = expect(job).rejects.toThrow("关闭");
    await entering;
    await instance.close();
    await rejected;
    expect(ctx.onSubmitted).not.toHaveBeenCalled();
    await expect(instance.run(input(), ctx)).rejects.toThrow("关闭");
  });
});

class TestSocket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  sent: ArrayBuffer[] = [];
  send(data: ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  emit(data: Uint8Array) {
    this.dispatchEvent(
      new MessageEvent("message", { data: new Uint8Array(data).buffer }),
    );
  }
}
function responseFrame(stream: number, body: string): Uint8Array {
  return fieldData(
    1,
    Buffer.concat([
      fieldNumber(1, stream),
      fieldData(
        3,
        Buffer.concat([
          fieldNumber(1, 200),
          fieldData(3, body),
          fieldNumber(4, 1),
        ]),
      ),
    ]),
  );
}
describe("gateway bounded stream transport", () => {
  it("reassembles fragmented responses and routes concurrently active stream ids", async () => {
    const socket = new TestSocket();
    const gateway = new MuseGateway(socket as unknown as WebSocket);
    await gateway.initialize();
    const one = gateway.json("GET", "/first");
    const two = gateway.json("GET", "/second");
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const piece of packChunks(
      responseFrame(2, '{"value":2}'),
      7,
    ).reverse())
      socket.emit(piece);
    for (const piece of packChunks(responseFrame(1, '{"value":1}'), 7))
      socket.emit(piece);
    expect(await one).toEqual({ status: 200, data: { value: 1 } });
    expect(await two).toEqual({ status: 200, data: { value: 2 } });
    await gateway.close();
  });

  it("streams bytes without retaining a second file-sized response buffer", async () => {
    const socket = new TestSocket();
    const gateway = new MuseGateway(socket as unknown as WebSocket);
    await gateway.initialize();
    const received: Uint8Array[] = [];
    const result = gateway.request("GET", "/file", undefined, {
      onData: (data) => {
        received.push(data);
      },
    });
    socket.emit(packChunks(responseFrame(1, "file-content"))[0]);
    expect((await result).body.length).toBe(0);
    expect(Buffer.concat(received).toString()).toBe("file-content");
    await gateway.close();
  });

  it("closes the connection and fails pending streams after corrupt protocol data", async () => {
    const socket = new TestSocket();
    const gateway = new MuseGateway(socket as unknown as WebSocket);
    await gateway.initialize();
    const result = expect(gateway.json("GET", "/pending")).rejects.toThrow(
      "协议",
    );
    socket.emit(Uint8Array.of(0xff));
    await result;
    expect(gateway.isOpen()).toBe(false);
    expect(socket.readyState).toBe(3);
    await gateway.close();
  });
});

describe("provider boundaries", () => {
  it("does not treat uploaded user files or a commentary preamble as a completed generation", () => {
    const turns = historyTurns({
      result: {
        chat_events: [
          {
            event_name: "message.user",
            display_text: "go",
            payload: { files: [{ path: "/workspace/input.mp4" }] },
          },
          {
            event_name: "message.assistant",
            status: "completed",
            display_text_ready: true,
            payload: { metadata: { message_kind: "commentary" } },
          },
        ],
      },
    });
    expect(turns[0]).toMatchObject({ files: [] });
    expect(turns[0].terminal).toBeUndefined();
    expect(turns[0].inputs).toEqual(["/workspace/input.mp4"]);
  });
  it("keeps a running task unfinished even if an assistant text block is already complete", () => {
    const turns = historyTurns({
      result: {
        chat_events: [
          { event_name: "message.user", display_text: "generate video" },
          { event_name: "task.status", payload: { status: "running" } },
          {
            event_name: "message.assistant",
            display_text_ready: true,
            status: "completed",
          },
        ],
      },
    });
    expect(turns[0].terminal).toBe("running");
  });
  it("rejects paths outside the workspace and plaintext remote CDP endpoints", () => {
    for (const invalid of [
      "/etc/passwd",
      "/workspace/../secret",
      "sandbox://workspace/%2e%2e/secret",
      "https://evil.example/workspace/video.mp4",
      "/workspace/a?secret",
    ])
      expect(workspaceFile(invalid)).toBeNull();
    expect(workspaceFile("sandbox://workspace/user/a.mp4")).toBe(
      "/workspace/user/a.mp4",
    );
    expect(() => checkedCdp("http://remote.example:9222")).toThrow("CDP");
    expect(checkedCdp("http://127.0.0.1:9222")).toContain("127.0.0.1");
    expect(() => checkedProxy("socks5://127.0.0.1:1080")).toThrow("SOCKS");
  });
});
