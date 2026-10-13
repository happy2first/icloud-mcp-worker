import { z } from "zod";
import { AUTH_LIFETIME_MS, SrpChallengeSchema } from "./protocol.ts";
import { AppError } from "../../errors.ts";

const binding = {
  direction: z.literal("server"),
  transactionId: z.string().uuid(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().min(0).max(12),
};
const text = (max: number) => z.string().min(1).max(max);
export const ServerAuthEvent = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      ...binding,
      sequence: z.literal(0),
      generation: z.number().int().positive().safe(),
      expiresAt: z.number().int().positive().safe(),
      lifetimeMs: z.literal(AUTH_LIFETIME_MS),
    })
    .strict(),
  z
    .object({
      type: z.literal("srp-challenge"),
      ...binding,
      challenge: SrpChallengeSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("bridge-challenge"), ...binding, salt: text(88) })
    .strict(),
  z
    .object({
      type: z.literal("bridge-response"),
      ...binding,
      serverShare: text(88),
      serverConfirmation: text(44),
    })
    .strict(),
  z
    .object({
      type: z.literal("bridge-encrypted"),
      ...binding,
      encryptedCode: text(11_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("complete"),
      ...binding,
      state: z.enum(["READY", "DEVICE_APPROVAL_PENDING"]),
      action: z
        .enum(["approve-device-consent", "wait-for-reminders-keys"])
        .optional(),
      nextAttemptAt: z.number().int().nonnegative().safe(),
      expiresAt: z.number().int().positive().safe().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      ...binding,
      error: z
        .object({
          code: text(64),
          message: text(1024),
          requestId: z.string().uuid(),
          retryable: z.boolean(),
          retryAfterSeconds: z.number().finite().min(0).max(86400).optional(),
        })
        .strict(),
    })
    .strict(),
]);
export class AuthResponseSequence {
  private binding: { transactionId: string; nonce: string } | null = null;
  private next = 0;
  readonly generation: number;
  constructor(generation: number) {
    this.generation = generation;
  }
  consume(input: unknown) {
    const result = ServerAuthEvent.safeParse(input);
    if (!result.success)
      throw new AppError(
        "RESTART_REQUIRED",
        "The sign-in response was invalid. Restart sign-in.",
        409,
      );
    const event = result.data;
    if (event.sequence !== this.next)
      throw new AppError(
        "RESTART_REQUIRED",
        "The sign-in response was replayed or out of order. Restart sign-in.",
        409,
      );
    if (!this.binding) {
      if (event.type !== "hello" || event.generation !== this.generation + 1)
        throw new AppError(
          "RESTART_REQUIRED",
          "The sign-in transaction changed. Refresh connection.",
          409,
        );
      this.binding = { transactionId: event.transactionId, nonce: event.nonce };
    } else if (
      event.type === "hello" ||
      event.transactionId !== this.binding.transactionId ||
      event.nonce !== this.binding.nonce
    ) {
      throw new AppError(
        "RESTART_REQUIRED",
        "The response belongs to another sign-in attempt. Restart sign-in.",
        409,
      );
    }
    if (
      event.type === "complete" &&
      (event.state === "READY"
        ? event.action !== undefined
        : event.action === undefined)
    )
      throw new AppError(
        "RESTART_REQUIRED",
        "Apple login and data-consent state were inconsistent. Restart sign-in.",
        409,
      );
    this.next++;
    return event;
  }
}
