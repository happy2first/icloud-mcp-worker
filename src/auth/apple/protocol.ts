import { z } from "zod";
import { AppError } from "../../errors.ts";
import { unb64, utf8 } from "../../crypto/bytes.ts";
import { SRP_N } from "../../crypto/srp.ts";
import { integer } from "../../crypto/bytes.ts";

export const APPLE_AUTH_PROTOCOL = "reminders-auth-v2";
export const AUTH_LIFETIME_MS = 180_000;
export const ACCOUNT = z
  .string()
  .min(1)
  .max(320)
  .refine(
    (value) => utf8(value).length <= 320 && !/[\x00-\x1f\x7f]/.test(value),
  );
const boundedB64 = (length: number) =>
  z
    .string()
    .min(4)
    .max(Math.ceil(length / 3) * 4)
    .refine((value) => {
      try {
        const bytes = unb64(value, length);
        return bytes.length > 0;
      } catch {
        return false;
      }
    });
export const SrpChallengeSchema = z.object({
  salt: boundedB64(64),
  b: boundedB64(256),
  c: z.string().min(1).max(2048),
  iteration: z.number().int().min(1).max(1_000_000),
  protocol: z.enum(["s2k", "s2k_fo"]),
});
export type SrpChallenge = z.infer<typeof SrpChallengeSchema>;
export function parseChallenge(value: unknown): SrpChallenge {
  const parsed = SrpChallengeSchema.safeParse(value);
  if (!parsed.success)
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned an unsupported SRP challenge.",
    );
  const publicValue = integer(unb64(parsed.data.b, 256));
  if (publicValue <= 0n || publicValue >= SRP_N)
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned an invalid SRP public value.",
    );
  return parsed.data;
}
const proof = boundedB64(32).refine((value) => unb64(value, 32).length === 32);
const binding = {
  transactionId: z.string().uuid(),
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().nonnegative().max(8),
};
export const StartMessage = z
  .object({
    type: z.literal("start"),
    ...binding,
    sequence: z.literal(0),
    accountName: ACCOUNT,
    publicA: boundedB64(256),
    consentAppleTrust: z.literal(true),
    consentPersistentSession: z.literal(true),
  })
  .strict();
export const AuthMessage = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("srp-proof"), ...binding, m1: proof, m2: proof })
    .strict(),
  z
    .object({
      type: z.literal("bridge-share"),
      ...binding,
      data: boundedB64(65).refine((value) => unb64(value, 65).length === 65),
    })
    .strict(),
  z
    .object({ type: z.literal("bridge-confirmation"), ...binding, data: proof })
    .strict(),
  z
    .object({
      type: z.literal("bridge-validation"),
      ...binding,
      code: z
        .string()
        .min(1)
        .max(128)
        .refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
    })
    .strict(),
  z.object({ type: z.literal("cancel"), ...binding }).strict(),
]);
export type AuthInput = z.infer<typeof AuthMessage>;
export type ConnectionState =
  | "DISCONNECTED"
  | "AUTH_STARTING"
  | "CHALLENGE_PENDING"
  | "DEVICE_APPROVAL_PENDING"
  | "TRUST_ESTABLISHING"
  | "READY"
  | "REAUTH_REQUIRED"
  | "RATE_LIMITED"
  | "BLOCKED_UNSUPPORTED";
