// Derived from Xzese linked-date.ts; MIT, Copyright (c) 2026
// icloud-reminders-mcp-server contributors. See LICENSE.
import { z } from "zod";
import { AppError } from "../errors.ts";
import { unb64, utf8 } from "../crypto/bytes.ts";

const TimeZone = z
  .object({
    identifier: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }),
  })
  .strict();
export const DateComponents = z
  .object({
    era: z.literal(1),
    year: z.number().int().min(1).max(9999),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    second: z.number().int().min(0).max(59),
    timeZone: TimeZone,
    nanosecond: z.literal(0).optional(),
  })
  .strict()
  .refine((value) => {
    const date = new Date(0);
    date.setUTCFullYear(value.year, value.month - 1, value.day);
    return (
      date.getUTCFullYear() === value.year &&
      date.getUTCMonth() === value.month - 1 &&
      date.getUTCDate() === value.day
    );
  }, "Date components must form a valid Gregorian date.");
export function dateComponents(
  due: string,
  timeZone: string,
  includeZeroNanosecond = false,
) {
  const date = new Date(due);
  if (
    !Number.isSafeInteger(date.getTime()) ||
    date.getUTCMilliseconds() !== 0 ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Linked dates require an explicit instant with whole-second precision in years 1-9999.",
      400,
    );
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      timeZone,
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new AppError(
      "VALIDATION_ERROR",
      "The linked date requires a valid IANA time zone.",
      400,
    );
  }
  const parts = formatter.formatToParts(date);
  if (parts.find((part) => part.type === "era")?.value !== "AD")
    throw new AppError(
      "VALIDATION_ERROR",
      "The linked date is outside the supported Gregorian calendar range.",
      400,
    );
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const result = DateComponents.safeParse({
    era: 1,
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
    timeZone: { identifier: timeZone },
    ...(includeZeroNanosecond ? { nanosecond: 0 } : {}),
  });
  if (!result.success)
    throw new AppError(
      "VALIDATION_ERROR",
      "The linked date is outside the supported Gregorian calendar range.",
      400,
    );
  // The trigger format has no UTC-offset/fold field. Refuse a repeated local
  // time rather than claim it can distinguish the two fall-back occurrences.
  const localMillis = (millis: number) => {
    const parts = formatter.formatToParts(new Date(millis));
    const value = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);
    const date = new Date(0),
      year = value("year");
    date.setUTCFullYear(
      parts.find((part) => part.type === "era")?.value === "AD"
        ? year
        : 1 - year,
      value("month") - 1,
      value("day"),
    );
    date.setUTCHours(value("hour"), value("minute"), value("second"), 0);
    return date.getTime();
  };
  const offsets = new Set<number>(),
    local = localMillis(date.getTime());
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = date.getTime() + hours * 3_600_000;
    offsets.add(localMillis(sample) - sample);
  }
  for (const offset of offsets) {
    const candidate = local - offset;
    if (candidate !== date.getTime() && localMillis(candidate) === local)
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "This local time occurs twice during a time-zone transition; the date-trigger format cannot preserve the requested offset.",
      );
  }
  return result.data;
}
export function decodeDateComponents(value: unknown) {
  if (typeof value !== "string")
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "The date trigger is not base64 JSON.",
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(unb64(value, 8192)),
    );
  } catch {
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "The date trigger is not bounded UTF-8 JSON.",
    );
  }
  const result = DateComponents.safeParse(decoded);
  if (!result.success)
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "This trigger uses unsupported date-component fields or calendar semantics.",
    );
  return result.data;
}
export function dueDateNonce(encoded: unknown) {
  if (typeof encoded !== "string" || utf8(encoded).length > 65_536)
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The due-date resolution map is invalid.",
    );
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The due-date resolution map is malformed.",
    );
  }
  const token = z
    .object({
      map: z
        .object({
          dueDate: z
            .object({
              counter: z.number().int().safe().positive(),
              modificationTime: z.number().finite(),
              replicaID: z.string().uuid(),
            })
            .passthrough(),
        })
        .passthrough(),
    })
    .passthrough()
    .safeParse(decoded);
  if (!token.success)
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "The date recipe requires a valid observed dueDate resolution token.",
    );
  const nonce =
    token.data.map.dueDate.counter * 100_000_000_000 +
    token.data.map.dueDate.modificationTime;
  if (!Number.isFinite(nonce) || Math.abs(nonce) > Number.MAX_SAFE_INTEGER)
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "The due-date nonce exceeds supported numeric precision.",
    );
  return nonce;
}
