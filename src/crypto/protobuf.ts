import { concat } from "./bytes.ts";
import { AppError, requireValue } from "../errors.ts";
export interface ProtoField {
  number: number;
  wire: number;
  value: bigint | Uint8Array;
}
export function varint(value: bigint | number) {
  let n = BigInt(value);
  requireValue(
    n >= 0n && n <= 0xffffffffffffffffn,
    "Invalid protobuf integer.",
  );
  const parts: number[] = [];
  do {
    const b = Number(n & 127n);
    n >>= 7n;
    parts.push(b | (n ? 128 : 0));
  } while (n);
  return Uint8Array.from(parts);
}
export const uint = (number: number, value: bigint | number) =>
  concat(varint(number * 8), varint(value));
export const bytesField = (number: number, value: Uint8Array) =>
  concat(varint(number * 8 + 2), varint(value.length), value);
export function fields(bytes: Uint8Array): ProtoField[] {
  requireValue(
    bytes.length <= 262_144,
    "Protobuf data exceeded the byte budget.",
  );
  let offset = 0;
  const out: ProtoField[] = [];
  function readVarint(): bigint {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      requireValue(offset < bytes.length, "Truncated protobuf integer.");
      const b = bytes[offset++];
      if (i === 9) requireValue(b <= 1, "Oversized protobuf integer.");
      n |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return n;
    }
    throw new AppError("PROTOCOL_CHANGED", "Invalid protobuf integer.");
  }
  while (offset < bytes.length) {
    requireValue(out.length < 10_000, "Protobuf field budget exceeded.");
    const tag = readVarint();
    const wire = Number(tag & 7n);
    const number = Number(tag >> 3n);
    requireValue(
      number >= 1 && number <= 536_870_911,
      "Invalid protobuf field number.",
    );
    if (wire === 0) out.push({ number, wire, value: readVarint() });
    else if (wire === 2 || wire === 1 || wire === 5) {
      const length = wire === 2 ? Number(readVarint()) : wire === 1 ? 8 : 4;
      requireValue(
        Number.isSafeInteger(length) &&
          length >= 0 &&
          length <= bytes.length - offset,
        "Truncated protobuf field.",
      );
      out.push({ number, wire, value: bytes.slice(offset, offset + length) });
      offset += length;
    } else
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Unsupported protobuf wire format.",
      );
  }
  return out;
}
export function getBytes(values: ProtoField[], number: number) {
  return values
    .filter((f) => f.number === number && f.wire === 2)
    .map((f) => f.value as Uint8Array);
}
