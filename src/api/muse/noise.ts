import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { fieldData, readFields, wireData, wireInteger } from "./wire.ts";

// Standard Noise revision 34, XX / X25519 / AES-256-GCM / SHA-256.
// https://noiseprotocol.org/noise.html (sections 5, 7.2 and 12).
const PROTOCOL = Buffer.from("Noise_XX_25519_AESGCM_SHA256", "ascii");
const EMPTY = Buffer.alloc(0);
const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const MAX_MESSAGE = 65_535;
const MAX_NONCE = (1n << 64n) - 1n;
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest();
const together = (...data: Uint8Array[]) => Buffer.concat(data);

export function noiseHKDF(
  chainingKey: Uint8Array,
  material: Uint8Array,
): [Buffer, Buffer] {
  const extracted = createHmac("sha256", chainingKey).update(material).digest();
  const first = createHmac("sha256", extracted)
    .update(Uint8Array.of(1))
    .digest();
  const second = createHmac("sha256", extracted)
    .update(first)
    .update(Uint8Array.of(2))
    .digest();
  extracted.fill(0);
  return [first, second];
}

export class NoiseCipher {
  private key: Buffer;
  private nonce = 0n;
  constructor(key: Uint8Array) {
    if (key.length !== 32) throw new Error("Noise 密钥长度错误。");
    this.key = Buffer.from(key);
  }
  private iv(): Buffer {
    if (this.nonce >= MAX_NONCE)
      throw new Error("Noise 连接已达到 nonce 上限，请重新连接。");
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(this.nonce, 4);
    return iv;
  }
  encrypt(
    plaintext: Uint8Array,
    associatedData: Uint8Array = EMPTY,
  ): Uint8Array {
    if (plaintext.length + 16 > MAX_MESSAGE)
      throw new Error("Noise 消息超过 65535 字节。");
    const cipher = createCipheriv("aes-256-gcm", this.key, this.iv());
    cipher.setAAD(associatedData);
    const result = together(
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    );
    this.nonce++;
    return result;
  }
  decrypt(
    ciphertext: Uint8Array,
    associatedData: Uint8Array = EMPTY,
  ): Uint8Array {
    if (ciphertext.length < 16 || ciphertext.length > MAX_MESSAGE)
      throw new Error("Noise 密文长度错误。");
    const decipher = createDecipheriv("aes-256-gcm", this.key, this.iv());
    decipher.setAAD(associatedData);
    decipher.setAuthTag(ciphertext.subarray(-16));
    let result: Uint8Array;
    try {
      result = together(
        decipher.update(ciphertext.subarray(0, -16)),
        decipher.final(),
      );
    } catch {
      throw new Error("Noise 消息认证失败，请重新连接。");
    }
    this.nonce++;
    return result;
  }
  destroy(): void {
    this.key.fill(0);
    this.nonce = MAX_NONCE;
  }
}

function keyPair(secret: Uint8Array): {
  privateKey: KeyObject;
  publicKey: Uint8Array;
} {
  if (secret.length !== 32) throw new Error("Noise X25519 私钥长度错误。");
  const privateKey = createPrivateKey({
    key: together(PKCS8, secret),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  return { privateKey, publicKey };
}
function shared(privateKey: KeyObject, publicBytes: Uint8Array): Buffer {
  if (publicBytes.length !== 32) throw new Error("Noise X25519 公钥长度错误。");
  try {
    return diffieHellman({
      privateKey,
      publicKey: createPublicKey({
        key: together(SPKI, publicBytes),
        format: "der",
        type: "spki",
      }),
    });
  } catch {
    throw new Error("Noise X25519 握手公钥无效。");
  }
}

export interface NoiseTransport {
  encrypt(data: Uint8Array): Uint8Array;
  decrypt(data: Uint8Array): Uint8Array;
  destroy(): void;
}

/** Deterministic keys/prologue make independent published vectors executable. */
export class NoiseXXInitiator {
  private transcript: Buffer;
  private chainingKey: Buffer;
  private cipher?: NoiseCipher;
  private ephemeral: ReturnType<typeof keyPair>;
  private identity: ReturnType<typeof keyPair>;
  private peerEphemeral?: Uint8Array;
  private phase = 0;

  constructor(
    options: {
      staticKey?: Uint8Array;
      ephemeralKey?: Uint8Array;
      prologue?: Uint8Array;
    } = {},
  ) {
    const name = Buffer.alloc(32);
    PROTOCOL.copy(name);
    this.chainingKey = Buffer.from(name);
    this.transcript = hash(together(name, options.prologue ?? EMPTY));
    this.ephemeral = keyPair(options.ephemeralKey ?? randomBytes(32));
    this.identity = keyPair(options.staticKey ?? randomBytes(32));
  }
  private mixHash(bytes: Uint8Array): void {
    this.transcript = hash(together(this.transcript, bytes));
  }
  private mixKey(secret: Buffer): void {
    const [next, key] = noiseHKDF(this.chainingKey, secret);
    this.chainingKey.fill(0);
    this.chainingKey = next;
    this.cipher?.destroy();
    this.cipher = new NoiseCipher(key);
    key.fill(0);
    secret.fill(0);
  }
  private seal(payload: Uint8Array): Uint8Array {
    const encrypted = this.cipher
      ? this.cipher.encrypt(payload, this.transcript)
      : payload;
    this.mixHash(encrypted);
    return encrypted;
  }
  private open(payload: Uint8Array): Uint8Array {
    const decrypted = this.cipher
      ? this.cipher.decrypt(payload, this.transcript)
      : payload;
    this.mixHash(payload);
    return decrypted;
  }
  first(payload: Uint8Array = EMPTY): Uint8Array {
    if (this.phase !== 0 || payload.length + 32 > MAX_MESSAGE)
      throw new Error("Noise 首个握手消息状态或长度错误。");
    this.phase = 1;
    this.mixHash(this.ephemeral.publicKey);
    return together(this.ephemeral.publicKey, this.seal(payload));
  }
  accept(message: Uint8Array): Uint8Array {
    if (this.phase !== 1 || message.length < 96 || message.length > MAX_MESSAGE)
      throw new Error("Noise 服务端握手消息状态或长度错误。");
    this.phase = -1; // A failed authentication cannot be retried with the same keys.
    this.peerEphemeral = message.subarray(0, 32);
    this.mixHash(this.peerEphemeral);
    this.mixKey(shared(this.ephemeral.privateKey, this.peerEphemeral));
    const peerIdentity = this.open(message.subarray(32, 80));
    this.mixKey(shared(this.ephemeral.privateKey, peerIdentity));
    const payload = this.open(message.subarray(80));
    this.phase = 2;
    return payload;
  }
  finish(payload: Uint8Array = EMPTY): {
    message: Uint8Array;
    transport: NoiseTransport;
    handshakeHash: Uint8Array;
  } {
    if (this.phase !== 2 || payload.length + 64 > MAX_MESSAGE)
      throw new Error("Noise 最后握手消息状态或长度错误。");
    this.phase = 3;
    const identity = this.seal(this.identity.publicKey);
    this.mixKey(shared(this.identity.privateKey, this.peerEphemeral!));
    const message = together(identity, this.seal(payload));
    const [outgoing, incoming] = noiseHKDF(this.chainingKey, EMPTY);
    const sender = new NoiseCipher(outgoing),
      receiver = new NoiseCipher(incoming);
    outgoing.fill(0);
    incoming.fill(0);
    this.chainingKey.fill(0);
    this.cipher?.destroy();
    return {
      message,
      handshakeHash: Buffer.from(this.transcript),
      transport: {
        encrypt: (data) => sender.encrypt(data),
        decrypt: (data) => receiver.decrypt(data),
        destroy: () => {
          sender.destroy();
          receiver.destroy();
        },
      },
    };
  }
}

export async function createNoiseSession(io: {
  send(data: Uint8Array): void | Promise<void>;
  receive(): Promise<Uint8Array>;
}): Promise<NoiseTransport> {
  const handshake = new NoiseXXInitiator();
  await io.send(handshake.first(fieldData(1, randomBytes(32))));
  const payload = handshake.accept(await io.receive());
  let challenge = false;
  if (payload.length) {
    try {
      const fields = readFields(payload);
      const mode = wireInteger(fields, 2);
      challenge =
        !!wireData(fields, 1) &&
        (mode === 1n || mode === 2n) &&
        wireData(fields, 3)?.length === 32;
    } catch {
      /* Other standard-mode handshake payloads are not app messages. */
    }
  }
  if (challenge)
    throw new Error(
      "Muse 要求额外身份或设备验证，请在官方 Muse 完成验证后重连。",
    );
  const result = handshake.finish();
  try {
    await io.send(result.message);
    return result.transport;
  } catch (error) {
    result.transport.destroy();
    throw error;
  }
}
