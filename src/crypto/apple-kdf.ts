// Protocol port of pyicloud/srp_password.py at the pinned MIT revision.
// Password-dependent values stay in the browser during a future live flow.
import { buffer, digest, hex, utf8 } from "./bytes.ts";
import { requireValue } from "../errors.ts";
export type AppleProtocol = "s2k" | "s2k_fo";
export async function appleKdf(
  password: string,
  salt: Uint8Array,
  iterations: number,
  protocol: AppleProtocol,
): Promise<Uint8Array> {
  requireValue(
    protocol === "s2k" || protocol === "s2k_fo",
    "Unsupported Apple password protocol.",
  );
  requireValue(
    Number.isSafeInteger(iterations) &&
      iterations >= 1 &&
      iterations <= 1_000_000,
    "Invalid password derivation budget.",
  );
  const passwordBytes = utf8(password);
  password = "";
  let hashed: Uint8Array | undefined;
  let material: Uint8Array | undefined;
  let imported: ArrayBuffer | undefined;
  try {
    requireValue(
      salt.length >= 1 && salt.length <= 64 && passwordBytes.length <= 1024,
      "Invalid derivation input size.",
    );
    hashed = await digest(passwordBytes);
    passwordBytes.fill(0);
    material = protocol === "s2k_fo" ? utf8(hex(hashed)) : hashed;
    imported = buffer(material);
    const key = await crypto.subtle.importKey(
      "raw",
      imported,
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    return new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: buffer(salt), iterations },
        key,
        256,
      ),
    );
  } finally {
    passwordBytes.fill(0);
    hashed?.fill(0);
    material?.fill(0);
    if (imported) new Uint8Array(imported).fill(0);
  }
}
