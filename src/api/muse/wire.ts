import { randomBytes } from "node:crypto";

// Wire field numbers describe the observed Hatch transport. This is an independent
// bounded protobuf codec, not generated from or copied from another client.
export const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_FRAME_BYTES = 65_519;
const MAX_CHUNKS = 4096;
const MAX_UINT64 = (1n << 64n) - 1n;
const utf8 = new TextDecoder("utf-8", { fatal: true });
export type WireValue = bigint | Uint8Array;
export type WireFields = Map<number, WireValue[]>;

function invalid(detail: string): never {
  throw new Error(`Muse 协议数据无效：${detail}`);
}
function join(parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts);
}

export function encodeVarint(value: bigint | number): Uint8Array {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    invalid("整数超出范围");
  let remaining = BigInt(value);
  if (remaining < 0n || remaining > MAX_UINT64) invalid("整数超出范围");
  const out: number[] = [];
  do {
    const part = Number(remaining & 127n);
    remaining >>= 7n;
    out.push(part | (remaining ? 128 : 0));
  } while (remaining);
  return Uint8Array.from(out);
}

export function fieldNumber(field: number, value: bigint | number): Uint8Array {
  return join([encodeVarint(BigInt(field) * 8n), encodeVarint(value)]);
}
export function fieldData(
  field: number,
  value: Uint8Array | string,
): Uint8Array {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (data.length > MAX_WIRE_BYTES) invalid("字段过大");
  return join([
    encodeVarint(BigInt(field) * 8n + 2n),
    encodeVarint(data.length),
    data,
  ]);
}

export function readFields(input: Uint8Array): WireFields {
  if (input.length > MAX_WIRE_BYTES) invalid("消息过大");
  const fields: WireFields = new Map();
  let offset = 0;
  let total = 0;
  const number = (): bigint => {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= input.length) invalid("整数被截断");
      const byte = input[offset++];
      if (i === 9 && byte > 1) invalid("整数溢出");
      result |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return result;
    }
    return invalid("整数过长");
  };
  while (offset < input.length) {
    if (++total > 8192) invalid("字段数量过多");
    const tag = number();
    const id = Number(tag >> 3n);
    const kind = Number(tag & 7n);
    if (id < 1 || id > 0x1fffffff) invalid("字段编号错误");
    let value: WireValue;
    if (kind === 0) value = number();
    else {
      let length: number;
      if (kind === 2) {
        const size = number();
        if (size > BigInt(input.length - offset)) invalid("字段长度越界");
        length = Number(size);
      } else if (kind === 1) length = 8;
      else if (kind === 5) length = 4;
      else return invalid("不支持的字段类型");
      if (length > input.length - offset) invalid("字段被截断");
      value = input.subarray(offset, offset + length);
      offset += length;
    }
    const previous = fields.get(id);
    if (previous) previous.push(value);
    else fields.set(id, [value]);
  }
  return fields;
}

function single(fields: WireFields, id: number): WireValue | undefined {
  const values = fields.get(id);
  if (values && values.length !== 1) invalid("单值字段重复");
  return values?.[0];
}
export function wireInteger(
  fields: WireFields,
  id: number,
  fallback = 0n,
): bigint {
  const value = single(fields, id);
  if (value === undefined) return fallback;
  if (typeof value !== "bigint") invalid("字段应为整数");
  return value;
}
export function wireData(
  fields: WireFields,
  id: number,
): Uint8Array | undefined {
  const value = single(fields, id);
  if (value === undefined) return undefined;
  if (typeof value === "bigint") invalid("字段应为字节");
  return value;
}
function textField(fields: WireFields, id: number, limit: number): string {
  const value = wireData(fields, id) ?? new Uint8Array();
  if (value.length > limit) invalid("文本字段过长");
  try {
    return utf8.decode(value);
  } catch {
    return invalid("文本编码错误");
  }
}
function flag(fields: WireFields, id: number): boolean {
  const value = wireInteger(fields, id);
  if (value !== 0n && value !== 1n) invalid("布尔字段错误");
  return value === 1n;
}

export interface GatewayRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}
export function encodeRequest(
  streamId: number,
  request: GatewayRequest,
): Uint8Array {
  if (!Number.isSafeInteger(streamId) || streamId < 1 || streamId > 0x7fffffff)
    invalid("流编号错误");
  if (
    !/^[A-Z]{3,10}$/.test(request.method) ||
    !request.path.startsWith("/") ||
    request.path.length > 8192 ||
    /[\r\n\0]/.test(request.path)
  )
    invalid("请求路径或方法错误");
  const parts = [fieldData(1, request.method), fieldData(2, request.path)];
  const entries = Object.entries(request.headers ?? {});
  if (entries.length > 100) invalid("请求头过多");
  for (const [key, value] of entries) {
    if (
      !key ||
      key.length > 256 ||
      value.length > 8192 ||
      /[\r\n\0]/.test(key + value)
    )
      invalid("请求头错误");
    parts.push(fieldData(3, join([fieldData(1, key), fieldData(2, value)])));
  }
  if (request.body !== undefined) parts.push(fieldData(4, request.body));
  parts.push(fieldNumber(5, 1));
  const application = join(parts);
  const frame = join([fieldNumber(1, streamId), fieldData(2, application)]);
  const result = join([fieldNumber(1, 0), fieldData(2, frame)]); // DAEMON service
  if (result.length > MAX_WIRE_BYTES) invalid("请求过大");
  return result;
}

export function packChunks(
  payload: Uint8Array,
  maxPayload = 48_000,
): Uint8Array[] {
  if (
    payload.length > MAX_WIRE_BYTES ||
    !Number.isSafeInteger(maxPayload) ||
    maxPayload < 1 ||
    maxPayload > 65_489
  )
    invalid("分片大小错误");
  const count = Math.max(1, Math.ceil(payload.length / maxPayload));
  if (count > MAX_CHUNKS) invalid("分片数量过多");
  const id = randomBytes(8).readBigUInt64BE() & ((1n << 63n) - 1n);
  return Array.from({ length: count }, (_, index) =>
    join([
      fieldNumber(1, id),
      fieldNumber(2, index),
      fieldNumber(3, count),
      fieldData(
        4,
        payload.subarray(index * maxPayload, (index + 1) * maxPayload),
      ),
    ]),
  );
}

export function decodeChunk(input: Uint8Array): {
  messageId: string;
  index: number;
  count: number;
  payload: Uint8Array;
} {
  if (input.length > MAX_FRAME_BYTES) invalid("传输帧过大");
  const fields = readFields(input);
  const id = wireInteger(fields, 1);
  const index = wireInteger(fields, 2);
  const count = wireInteger(fields, 3, 1n);
  const payload = wireData(fields, 4);
  if (count < 1n || count > BigInt(MAX_CHUNKS) || index >= count || !payload)
    invalid("分片序号或内容错误");
  return {
    messageId: id.toString(),
    index: Number(index),
    count: Number(count),
    payload,
  };
}

export interface GatewayResponse {
  streamId: number;
  status?: number;
  headers?: Record<string, string>;
  data?: Uint8Array;
  end: boolean;
  reset?: { code: number; reason: string };
}
export function decodeResponse(input: Uint8Array): GatewayResponse {
  const wrapped = wireData(readFields(input), 1);
  if (!wrapped) invalid("缺少响应帧");
  const frame = readFields(wrapped);
  const streamId = wireInteger(frame, 1);
  if (streamId < 1n || streamId > 0x7fffffffn) invalid("响应流编号错误");
  const head = wireData(frame, 3),
    body = wireData(frame, 4),
    reset = wireData(frame, 5);
  if ([head, body, reset].filter((value) => value !== undefined).length !== 1)
    invalid("响应类型不明确");
  const result: GatewayResponse = { streamId: Number(streamId), end: false };
  if (head) {
    const values = readFields(head);
    const status = wireInteger(values, 1);
    if (status < 100n || status > 599n) invalid("HTTP 状态错误");
    result.status = Number(status);
    result.headers = Object.create(null) as Record<string, string>;
    const headers = values.get(2) ?? [];
    if (headers.length > 100) invalid("响应头过多");
    for (const header of headers) {
      if (typeof header === "bigint") invalid("响应头类型错误");
      const parsed = readFields(header);
      const key = textField(parsed, 1, 256).toLowerCase();
      const value = textField(parsed, 2, 8192);
      if (!key || /[\r\n\0]/.test(key + value)) invalid("响应头错误");
      result.headers[key] = value;
    }
    result.data = wireData(values, 3);
    result.end = flag(values, 4);
  } else if (body) {
    const values = readFields(body);
    result.data = wireData(values, 1);
    result.end = flag(values, 2);
  } else {
    const values = readFields(reset!);
    result.reset = {
      code: Number(BigInt.asIntN(32, wireInteger(values, 1))),
      reason: textField(values, 2, 4096),
    };
    result.end = true;
  }
  return result;
}
