import { AppError, requireValue } from "../errors.ts";
import { b64, buffer, unb64, utf8 } from "./bytes.ts";

export interface EnvelopeContext {
  ownerId: string;
  accountId: string;
  generation: number;
  recordId: string;
  schemaVersion: 1;
}
export interface Envelope {
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
}
function aad(context: EnvelopeContext) {
  return buffer(
    utf8(
      JSON.stringify([
        "reminders-envelope",
        1,
        context.ownerId,
        context.accountId,
        context.generation,
        context.recordId,
        context.schemaVersion,
      ]),
    ),
  );
}
export class Envelopes {
  readonly active: string;
  readonly keys: Readonly<Record<string, string>>;
  private readonly singleKeyMode: boolean;
  constructor(
    active: string,
    keys: Record<string, string>,
    singleKeyMode = false,
  ) {
    function configured(
      condition: unknown,
      message: string,
    ): asserts condition {
      if (!condition)
        throw new AppError("CONFIGURATION_REQUIRED", message, 503);
    }
    configured(
      typeof keys === "object" &&
        keys !== null &&
        !Array.isArray(keys) &&
        Object.getPrototypeOf(keys) === Object.prototype,
      "The encryption key ring must be a plain object.",
    );
    const entries = Object.entries(keys);
    configured(
      entries.length >= 1 &&
        entries.length <= 8 &&
        entries.every(
          ([id, value]) =>
            /^[A-Za-z0-9_-]{1,64}$/.test(id) && typeof value === "string",
        ),
      "Invalid encryption key ring entries.",
    );
    for (const [, value] of entries) {
      let valid = false;
      try {
        valid = unb64(value, 32).length === 32;
      } catch {
        /* reject configuration before acquiring a lease */
      }
      configured(valid, "Each encryption key must contain exactly 32 bytes.");
    }
    configured(
      typeof active === "string" && Object.hasOwn(keys, active),
      "The active encryption key is unavailable.",
    );
    this.active = active;
    this.keys = Object.freeze({ ...keys });
    configured(
      !singleKeyMode || entries.length === 1,
      "Single-key mode requires exactly one key.",
    );
    this.singleKeyMode = singleKeyMode;
  }
  async key(keyId: string) {
    // A raw Secret has one key, independent of the identifier stored by older releases.
    // AES-GCM still authenticates the ciphertext and the full owner/account context.
    if (this.singleKeyMode) keyId = this.active;
    if (!Object.hasOwn(this.keys, keyId))
      throw new AppError(
        "CONFIGURATION_REQUIRED",
        "An encryption key needed for this record is unavailable.",
        503,
      );
    const bytes = unb64(this.keys[keyId], 32);
    requireValue(bytes.length === 32, "Invalid encryption key configuration.");
    return crypto.subtle.importKey("raw", buffer(bytes), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
  async encrypt(value: unknown, context: EnvelopeContext): Promise<Envelope> {
    const plaintext = utf8(JSON.stringify(value));
    requireValue(
      plaintext.length <= 512_000,
      "The encrypted record exceeds the storage budget.",
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: buffer(iv),
        additionalData: aad(context),
        tagLength: 128,
      },
      await this.key(this.active),
      buffer(plaintext),
    );
    return {
      version: 1,
      keyId: this.active,
      iv: b64(iv),
      ciphertext: b64(new Uint8Array(ciphertext)),
    };
  }
  async decrypt<T>(envelope: Envelope, context: EnvelopeContext): Promise<T> {
    requireValue(
      envelope.version === 1,
      "Unsupported encrypted envelope version.",
    );
    const iv = unb64(envelope.iv, 12);
    requireValue(iv.length === 12, "Invalid encrypted envelope.");
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buffer(iv),
          additionalData: aad(context),
          tagLength: 128,
        },
        await this.key(envelope.keyId),
        buffer(unb64(envelope.ciphertext, 512_016)),
      );
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      ) as T;
    } catch {
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Encrypted state failed verification. Access remains closed.",
        503,
      );
    }
  }
}

// Operators paste only Base64. Legacy JSON remains accepted for existing deployments.
export function envelopesFromSecret(secret?: string): Envelopes {
  const value = secret?.trim() ?? "";
  if (!value.startsWith("{")) {
    try {
      const bytes = unb64(value, 32);
      if (bytes.length !== 32 || b64(bytes) !== value)
        throw new Error("Invalid key");
      return new Envelopes("v1", { v1: value }, true);
    } catch {
      throw new AppError(
        "CONFIGURATION_REQUIRED",
        "ENCRYPTION_KEYS_JSON must contain a 32-byte key encoded as Base64, without JSON or quotes.",
        503,
      );
    }
  }
  let keys: unknown;
  try {
    keys = JSON.parse(value);
  } catch {
    throw new AppError(
      "CONFIGURATION_REQUIRED",
      "ENCRYPTION_KEYS_JSON must be valid JSON.",
      503,
    );
  }
  if (
    !keys ||
    typeof keys !== "object" ||
    Array.isArray(keys) ||
    Object.keys(keys).length !== 1
  )
    throw new AppError(
      "CONFIGURATION_REQUIRED",
      "ENCRYPTION_KEYS_JSON must contain exactly one 32-byte encryption key.",
      503,
    );
  return new Envelopes(Object.keys(keys)[0], keys as Record<string, string>);
}
