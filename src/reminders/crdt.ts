// Narrow wire codec documented against the pinned MIT _protocol.py.
// No generated Apple-extracted .proto schema is copied into this project.
// Bounded text codec; mutation callers enforce owner, session and version checks.
import { Gunzip, Unzlib, zlibSync } from "fflate";
import { b64, concat, unb64, unhex, utf8 } from "../crypto/bytes.ts";
import { bytesField, fields, getBytes, uint } from "../crypto/protobuf.ts";
import { AppError, requireValue } from "../errors.ts";
const LIMIT = 262_144;
function decompress(input: Uint8Array) {
  requireValue(
    input.length <= LIMIT,
    "The document exceeds the compressed byte budget.",
  );
  const gzip = input[0] === 31 && input[1] === 139;
  const zlib =
    input.length >= 2 &&
    (input[0] & 15) === 8 &&
    ((input[0] << 8) + input[1]) % 31 === 0;
  if (!gzip && !zlib) return input;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const ondata = (data: Uint8Array) => {
    total += data.length;
    requireValue(
      total <= LIMIT,
      "The document exceeds the decompressed byte budget.",
    );
    chunks.push(data);
  };
  const stream = gzip ? new Gunzip(ondata) : new Unzlib(ondata);
  try {
    for (let offset = 0; offset < input.length; offset += 128)
      stream.push(
        input.subarray(offset, offset + 128),
        offset + 128 >= input.length,
      );
  } catch {
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The compressed reminder document is invalid or oversized.",
    );
  }
  return concat(...chunks);
}
function stringText(data: Uint8Array): string | null {
  const text = getBytes(fields(data), 2);
  if (text.length !== 1) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(text[0]);
  } catch {
    return null;
  }
}
export function decodeDocument(base64: string) {
  const original = unb64(base64, LIMIT);
  const decoded = decompress(original);
  const top = fields(decoded);
  for (const version of getBytes(top, 2)) {
    try {
      const inner = getBytes(fields(version), 3);
      if (inner.length === 1) {
        const text = stringText(inner[0]);
        if (text !== null)
          return { text, raw: original, wrapper: "document" as const };
      }
    } catch {
      /* Bare String also uses field 2. */
    }
  }
  for (const inner of getBytes(top, 3)) {
    try {
      const text = stringText(inner);
      if (text !== null)
        return { text, raw: original, wrapper: "version" as const };
    } catch {
      /* Try supported bare wrapper. */
    }
  }
  const text = stringText(decoded);
  if (text !== null) return { text, raw: original, wrapper: "string" as const };
  throw new AppError(
    "PROTOCOL_CHANGED",
    "This reminder document cannot be decoded safely.",
  );
}
export function encodeDocument(text: string) {
  requireValue(
    utf8(text).length <= 64_000,
    "The reminder text exceeds the supported budget.",
  );
  const id = (replica: number, clock: number) =>
    concat(uint(1, replica), uint(2, clock));
  const substring = (
    replica: number,
    clock: number,
    length: number,
    child?: number,
  ) =>
    concat(
      bytesField(1, id(replica, clock)),
      uint(2, length),
      bytesField(3, id(replica, clock)),
      ...(child === undefined ? [] : [uint(5, child)]),
    );
  const content = text.length
    ? [bytesField(3, substring(1, 0, text.length, 2))]
    : [];
  const replicaClock = (clock: number) => bytesField(2, uint(1, clock));
  const clock = concat(
    bytesField(1, unhex("d46bcae41b8766c18d75efe35c9145c3")),
    replicaClock(text.length),
    replicaClock(1),
  );
  const string = concat(
    bytesField(2, utf8(text)),
    bytesField(3, substring(0, 0, 0, 1)),
    ...content,
    bytesField(3, substring(0, 0xffffffff, 0)),
    bytesField(4, bytesField(1, clock)),
    ...(text.length ? [bytesField(5, uint(1, text.length))] : []),
  );
  const version = concat(uint(1, 0), uint(2, 0), bytesField(3, string));
  return b64(zlibSync(concat(uint(1, 0), bytesField(2, version))));
}
