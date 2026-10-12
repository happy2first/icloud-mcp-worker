export const utf8 = (text: string) => new TextEncoder().encode(text);
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export function unhex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(value))
    throw new Error("Invalid hexadecimal encoding");
  return Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));
}
export function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
export function unb64(s: string, maxBytes = 1024 * 1024): Uint8Array {
  if (
    s.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(s) ||
    s.length % 4 === 1
  ) {
    throw new Error("Invalid or oversized base64 encoding");
  }
  const binary = atob(s);
  if (binary.length > maxBytes) throw new Error("Oversized base64 encoding");
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
export const buffer = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;
export async function digest(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes)));
}
export async function hmac(key: Uint8Array, bytes: Uint8Array) {
  const k = await crypto.subtle.importKey(
    "raw",
    buffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buffer(bytes)));
}
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export function integer(bytes: Uint8Array): bigint {
  return BigInt(`0x${hex(bytes) || "0"}`);
}
export function integerBytes(n: bigint, width?: number) {
  if (n < 0n) throw new Error("Negative integer");
  let s = n.toString(16);
  if (s.length % 2) s = `0${s}`;
  if (width) {
    if (s.length > width * 2) throw new Error("Integer overflow");
    s = s.padStart(width * 2, "0");
  }
  return unhex(s);
}
