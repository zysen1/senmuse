import { describe, expect, it } from "vitest";
import {
  NoiseCipher,
  NoiseXXInitiator,
  createNoiseSession,
} from "../src/api/muse/noise.ts";
import {
  MAX_WIRE_BYTES,
  decodeChunk,
  decodeResponse,
  encodeRequest,
  encodeVarint,
  fieldData,
  fieldNumber,
  packChunks,
  readFields,
  wireData,
  wireInteger,
} from "../src/api/muse/wire.ts";

const hex = (value: string) => Buffer.from(value, "hex");
const join = (...parts: Uint8Array[]) => Buffer.concat(parts);

// Published by cacophony; linked by the Noise project's test-vector index.
// https://github.com/noiseprotocol/noise_wiki/wiki/Test-vectors
// https://github.com/centromere/cacophony/blob/master/vectors/cacophony.txt
// Noise_XX_25519_AESGCM_SHA256, not produced by this implementation.
const vector = {
  staticKey: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  ephemeralKey:
    "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  prologue: "4a6f686e2047616c74",
  handshakeHash:
    "1b7aefb1125762aa21a252890d00af54519638b76437444538f9a52f21e2e0dc",
  messages: [
    [
      "4c756477696720766f6e204d69736573",
      "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79444c756477696720766f6e204d69736573",
    ],
    [
      "4d757272617920526f746862617264",
      "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843757117acceb05bd7a45733bc22015c97a9d0cbaf41b80446d5988ff5127235d76b79eade70f473d6a4ef521fdcbeda5340d01e028ba793fc059f2724a83af05f12dda0448a7621a926b379a92477fd",
    ],
    [
      "462e20412e20486179656b",
      "c90f1cf77eba4e50edb038991565e36c9758943a989229b6051244dc4fbecb6946744b401af2ee1a5881b65fbb87fd07cb6a328ececc9ce6ce84c399dc332d4fd521fa4bb7f467ce909395",
    ],
    [
      "4361726c204d656e676572",
      "bc3fa77f6aca3e8466d7dc6bea10013e88a6a29add5132b461806c",
    ],
    [
      "4a65616e2d426170746973746520536179",
      "250b01074cdfe0df2ecf8ccbf1737b15a2ddb5b52fd9a396604e9c793cee3b3bb9",
    ],
    [
      "457567656e2042f6686d20766f6e2042617765726b",
      "449d4d433b3cdc3d02bf6fc881774b9df54366ebcffb9689bb13f14709822cd7ef42bcdb4d",
    ],
  ],
};

function initiator() {
  return new NoiseXXInitiator({
    staticKey: hex(vector.staticKey),
    ephemeralKey: hex(vector.ephemeralKey),
    prologue: hex(vector.prologue),
  });
}

describe("independent Noise interoperability", () => {
  it("matches published XX handshake bytes, transcript and bidirectional transport vectors", () => {
    const client = initiator();
    const m = vector.messages;
    expect(Buffer.from(client.first(hex(m[0][0]))).toString("hex")).toBe(
      m[0][1],
    );
    expect(Buffer.from(client.accept(hex(m[1][1]))).toString("hex")).toBe(
      m[1][0],
    );
    const result = client.finish(hex(m[2][0]));
    expect(Buffer.from(result.message).toString("hex")).toBe(m[2][1]);
    expect(Buffer.from(result.handshakeHash).toString("hex")).toBe(
      vector.handshakeHash,
    );
    expect(
      Buffer.from(result.transport.decrypt(hex(m[3][1]))).toString("hex"),
    ).toBe(m[3][0]);
    expect(
      Buffer.from(result.transport.encrypt(hex(m[4][0]))).toString("hex"),
    ).toBe(m[4][1]);
    expect(
      Buffer.from(result.transport.decrypt(hex(m[5][1]))).toString("hex"),
    ).toBe(m[5][0]);
    expect(() => result.transport.decrypt(hex(m[5][1]))).toThrow("认证失败");
    result.transport.destroy();
    expect(() => result.transport.encrypt(Buffer.from("closed"))).toThrow(
      "nonce",
    );
  });

  it("rejects modified handshake authentication and does not reuse a failed state", () => {
    const client = initiator();
    client.first(hex(vector.messages[0][0]));
    const modified = hex(vector.messages[1][1]);
    modified[modified.length - 1] ^= 1;
    expect(() => client.accept(modified)).toThrow("认证失败");
    expect(() => client.accept(hex(vector.messages[1][1]))).toThrow("状态");
    expect(() => client.finish()).toThrow("状态");
  });

  it("limits transport messages before encryption and refuses short ciphertexts", () => {
    const cipher = new NoiseCipher(Buffer.alloc(32));
    expect(() => cipher.encrypt(Buffer.alloc(65_520))).toThrow("65535");
    expect(() => cipher.decrypt(Buffer.alloc(15))).toThrow("长度");
    expect(() => cipher.decrypt(Buffer.alloc(65_536))).toThrow("长度");
  });

  it("fails a truncated server handshake instead of sending an unverified final message", async () => {
    const messages: Uint8Array[] = [];
    await expect(
      createNoiseSession({
        send: (data) => {
          messages.push(data);
        },
        receive: async () => Buffer.alloc(80),
      }),
    ).rejects.toThrow("握手");
    expect(messages).toHaveLength(1);
    expect(messages[0].length).toBe(66); // 32-byte e and protobuf field 1 containing 32 bytes.
  });
});

describe("Hatch protobuf framing", () => {
  it("encodes a complete DAEMON HTTP request with known field numbers", () => {
    expect(
      Buffer.from(encodeRequest(7, { method: "GET", path: "/ok" })).toString(
        "hex",
      ),
    ).toBe("080012100807120c0a0347455412032f6f6b2801");
    const bytes = encodeRequest(3, {
      method: "POST",
      path: "/chat/stream",
      headers: { "content-type": "application/json" },
      body: '{"prompt":"你好"}',
    });
    const frame = readFields(wireData(readFields(bytes), 2)!);
    const application = readFields(wireData(frame, 2)!);
    expect(wireInteger(frame, 1)).toBe(3n);
    expect(Buffer.from(wireData(application, 4)!).toString("utf8")).toBe(
      '{"prompt":"你好"}',
    );
    expect(wireInteger(application, 5)).toBe(1n);
  });

  it("decodes response headers/body/EOF and signed reset codes", () => {
    expect(decodeResponse(hex("0a0d08071a0908c8011a024f4b2001"))).toMatchObject(
      { streamId: 7, status: 200, data: hex("4f4b"), end: true },
    );
    const body = fieldData(
      1,
      join(
        fieldNumber(1, 7),
        fieldData(4, join(fieldData(1, "next"), fieldNumber(2, 1))),
      ),
    );
    expect(decodeResponse(body)).toMatchObject({
      streamId: 7,
      data: Buffer.from("next"),
      end: true,
    });
    const reset = fieldData(
      1,
      join(
        fieldNumber(1, 7),
        fieldData(
          5,
          join(fieldNumber(1, (1n << 64n) - 3n), fieldData(2, "closed")),
        ),
      ),
    );
    expect(decodeResponse(reset)).toEqual({
      streamId: 7,
      end: true,
      reset: { code: -3, reason: "closed" },
    });
  });

  it("chunks large uploads while retaining exact bytes and uint64 message identity", () => {
    const payload = Buffer.alloc(130_000, 0xa5);
    const frames = packChunks(payload);
    expect(frames).toHaveLength(3);
    const parts = frames.map(decodeChunk);
    expect(new Set(parts.map((part) => part.messageId)).size).toBe(1);
    expect(parts.map((part) => part.index)).toEqual([0, 1, 2]);
    expect(parts.every((part) => part.count === 3)).toBe(true);
    expect(Buffer.concat(parts.map((part) => part.payload))).toEqual(payload);
    const largeId = (1n << 63n) - 1n;
    expect(
      decodeChunk(join(fieldNumber(1, largeId), fieldData(4, "x"))).messageId,
    ).toBe(largeId.toString());
  });

  it("rejects truncated/overflowing protobuf values, ambiguous fields and excessive framing", () => {
    for (const malformed of [
      "08",
      "128001",
      "0b",
      "00",
      "08ffffffffffffffffffff02",
      "1282ffffffffffffffff01",
    ]) {
      expect(() => readFields(hex(malformed))).toThrow("协议");
    }
    expect(() => readFields(Buffer.alloc(MAX_WIRE_BYTES + 1))).toThrow("过大");
    expect(() =>
      readFields(Buffer.from(Array(8193).fill([8, 0]).flat())),
    ).toThrow("数量");
    expect(() => encodeVarint(Number.MAX_SAFE_INTEGER + 1)).toThrow("范围");
    expect(() =>
      decodeChunk(
        join(fieldNumber(2, 2), fieldNumber(3, 2), fieldData(4, "x")),
      ),
    ).toThrow("分片");
    expect(() =>
      decodeChunk(join(fieldNumber(3, 4097), fieldData(4, "x"))),
    ).toThrow("分片");
    expect(() =>
      decodeChunk(
        join(fieldNumber(3, 1), fieldNumber(3, 2), fieldData(4, "x")),
      ),
    ).toThrow("重复");
    expect(() => packChunks(Buffer.alloc(10), 65_490)).toThrow("分片");
    expect(() =>
      decodeResponse(
        fieldData(
          1,
          join(
            fieldNumber(1, 1),
            fieldData(4, fieldNumber(2, 1)),
            fieldData(5, fieldNumber(1, 1)),
          ),
        ),
      ),
    ).toThrow("不明确");
    expect(() =>
      encodeRequest(1, { method: "POST", path: "/ok\r\ninvalid" }),
    ).toThrow("路径");
  });
});
