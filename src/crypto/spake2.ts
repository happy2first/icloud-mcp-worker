// Derived from pyicloud/hsa2_bridge_prover.py; see provenance/NOTICE.md.
// Trusted-device SPAKE2 primitive, covered by offline reference vectors.
import { p256 } from "@noble/curves/nist.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { AppError, requireValue } from "../errors.ts";
import {
  buffer,
  concat,
  digest,
  equal,
  hmac,
  integer,
  integerBytes,
  unb64,
  unhex,
  utf8,
} from "./bytes.ts";

const ORDER = p256.Point.Fn.ORDER;
const M = p256.Point.fromHex(
  "02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f",
);
const N = p256.Point.fromHex(
  "03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49",
);
export function lengthPrefixed(...parts: Uint8Array[]) {
  return concat(
    ...parts.flatMap((part) => {
      const length = new Uint8Array(8);
      new DataView(length.buffer).setBigUint64(0, BigInt(part.length), true);
      return [length, part];
    }),
  );
}
async function hkdf(input: Uint8Array, info: string, length: number) {
  const prk = await hmac(new Uint8Array(32), input);
  let previous = new Uint8Array(0);
  const blocks: Uint8Array[] = [];
  let material: Uint8Array | undefined;
  let combined: Uint8Array | undefined;
  try {
    for (let i = 1; i <= Math.ceil(length / 32); i++) {
      material = concat(previous, utf8(info), Uint8Array.of(i));
      previous = new Uint8Array(await hmac(prk, material));
      material.fill(0);
      blocks.push(previous);
    }
    combined = concat(...blocks);
    return combined.slice(0, length);
  } finally {
    prk.fill(0);
    material?.fill(0);
    combined?.fill(0);
    for (const block of blocks) block.fill(0);
  }
}
function multiply(point: typeof M, scalar: bigint) {
  const reduced = scalar % ORDER;
  requireValue(reduced > 0n, "Invalid SPAKE2 scalar.");
  return point.multiply(reduced);
}
export async function spakeScalars(
  code: string,
  salt: Uint8Array,
  signal?: AbortSignal,
) {
  requireValue(
    /^\d{6}$/.test(code) && salt.length >= 1 && salt.length <= 64,
    "Invalid synthetic bridge input.",
  );
  const active = () => {
    if (signal?.aborted)
      throw new AppError(
        "AUTH_EXPIRED",
        "The verification attempt was cancelled.",
        409,
      );
  };
  active();
  const codeBytes = utf8(code);
  code = "";
  let bytes: Uint8Array | undefined;
  try {
    bytes = await scryptAsync(codeBytes, salt, {
      N: 16384,
      r: 8,
      p: 1,
      dkLen: 64,
      maxmem: 32 * 1024 * 1024,
      asyncTick: 8,
      ...(signal ? { onProgress: active } : {}),
    });
    active();
    return {
      w0: integer(bytes.subarray(0, 32)),
      w1: integer(bytes.subarray(32)),
    };
  } finally {
    codeBytes.fill(0);
    bytes?.fill(0);
  }
}
export class SpakeProver {
  readonly x: bigint;
  readonly w0: bigint;
  readonly w1: bigint;
  private readonly point: typeof M;
  constructor(x: bigint, w0: bigint, w1: bigint) {
    requireValue(x > 0n && x < ORDER, "Invalid SPAKE2 ephemeral scalar.");
    this.x = x;
    this.w0 = w0;
    this.w1 = w1;
    this.point = multiply(p256.Point.BASE, x).add(multiply(M, w0));
    requireValue(!this.point.equals(p256.Point.ZERO), "Invalid SPAKE2 share.");
  }
  message(): Uint8Array {
    return this.point.toBytes(false);
  }
  async finish(serverMessage: Uint8Array) {
    requireValue(
      serverMessage.length === 65 && serverMessage[0] === 4,
      "Invalid SPAKE2 server message.",
    );
    let server: typeof M;
    try {
      server = p256.Point.fromBytes(serverMessage);
      server.assertValidity();
    } catch {
      throw new AppError("PROTOCOL_CHANGED", "Invalid SPAKE2 curve point.");
    }
    const adjusted = server.subtract(multiply(N, this.w0));
    requireValue(
      !adjusted.equals(p256.Point.ZERO),
      "Invalid SPAKE2 adjusted point.",
    );
    const z = multiply(adjusted, this.x);
    const v = multiply(adjusted, this.w1);
    const transcript = lengthPrefixed(
      utf8("SPAKE2Web"),
      utf8("com.apple.security.webprover"),
      utf8("com.apple.security.webverifier"),
      M.toBytes(false),
      N.toBytes(false),
      this.message(),
      server.toBytes(false),
      z.toBytes(false),
      v.toBytes(false),
      integerBytes(this.w0),
    );
    const hashed = await digest(transcript);
    const confirmationKeys = await hkdf(hashed, "ConfirmationKeys", 64);
    const confirmation = await hmac(
      confirmationKeys.slice(0, 32),
      serverMessage,
    );
    const expected = await hmac(confirmationKeys.slice(32), this.message());
    const key = await hkdf(hashed, "SharedKey", 32);
    hashed.fill(0);
    confirmationKeys.fill(0);
    let verified = false;
    let destroyed = false;
    return {
      transcript,
      confirmation,
      destroy() {
        destroyed = true;
        verified = false;
        transcript.fill(0);
        confirmation.fill(0);
        expected.fill(0);
        key.fill(0);
      },
      async verify(serverConfirmation: Uint8Array) {
        requireValue(!destroyed, "The bridge exchange was cleared.");
        requireValue(
          equal(expected, serverConfirmation),
          "The bridge confirmation failed verification.",
        );
        verified = true;
      },
      async decrypt(payloadBase64: string) {
        requireValue(
          verified && !destroyed,
          "The bridge has not been verified or was cleared.",
        );
        const payload = unb64(payloadBase64, 8192);
        requireValue(
          payload.length >= 29 && payload[0] === 0,
          "Unsupported bridge payload layout.",
        );
        const verifierBytes = await hkdf(key, "webVerifier", 32);
        const imported = buffer(verifierBytes);
        let plaintext: ArrayBuffer | undefined;
        try {
          requireValue(!destroyed, "The bridge exchange was cleared.");
          const verifierKey = await crypto.subtle.importKey(
            "raw",
            imported,
            "AES-GCM",
            false,
            ["decrypt"],
          );
          plaintext = await crypto.subtle.decrypt(
            {
              name: "AES-GCM",
              iv: buffer(payload.slice(1, 13)),
              additionalData: buffer(Uint8Array.of(0)),
              tagLength: 128,
            },
            verifierKey,
            buffer(concat(payload.slice(29), payload.slice(13, 29))),
          );
          requireValue(!destroyed, "The bridge exchange was cleared.");
          return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
        } catch {
          throw new AppError(
            "PROTOCOL_CHANGED",
            "The bridge payload failed verification.",
          );
        } finally {
          verifierBytes.fill(0);
          new Uint8Array(imported).fill(0);
          if (plaintext) new Uint8Array(plaintext).fill(0);
        }
      },
    };
  }
}
export function rawSignatureToDER(raw: Uint8Array) {
  return p256.Signature.fromBytes(raw, "compact").toBytes("der");
}
export function derSignatureToRaw(der: Uint8Array) {
  return p256.Signature.fromBytes(der, "der").toBytes("compact");
}
export { unhex };
