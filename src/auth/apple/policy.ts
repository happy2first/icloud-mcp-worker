import { z } from "zod";
import { AppError } from "../../errors.ts";

export const APPLE_LOGIN_POLICY = "device-only-v2";
export const LEGACY_SESSION_RETENTION_MS = 86_400_000;
export const SESSION_RETENTION_MS = 2_592_000_000;
export const RETENTION_POLICY = "absolute-30d-v1";
// Numeric sentinel preserves bounded lease/download arithmetic in legacy code.
// Version 4 never applies this value as a local session deadline; public expiry is null.
export const NO_LOCAL_EXPIRY = 8_640_000_000_000_000;
const timestamp = z.number().int().positive().safe().max(8_640_000_000_000_000);
const evidence = {
  policy: z.literal(APPLE_LOGIN_POLICY),
  factor: z.literal("trusted-device-spake2"),
  verifiedAt: timestamp,
  expiresAt: timestamp,
  consentAppleTrust: z.literal(true),
  consentPersistentSession: z.literal(true),
};
export const LegacyLoginAssuranceSchema = z
  .object({ ...evidence, version: z.literal(2) })
  .strict()
  .refine(
    (value) =>
      value.expiresAt === value.verifiedAt + LEGACY_SESSION_RETENTION_MS,
    "Invalid legacy retention deadline.",
  );
const retained = {
  ...evidence,
  version: z.literal(3),
  retentionPolicy: z.literal(RETENTION_POLICY),
};
export const RetainedLoginAssuranceSchema = z
  .union([
    z
      .object({
        ...retained,
        retentionSource: z.literal("interactive-consent"),
      })
      .strict(),
    z
      .object({
        ...retained,
        retentionSource: z.literal("owner-authorised-migration"),
        migratedAt: timestamp,
        previousExpiresAt: timestamp,
        migrationId: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/),
      })
      .strict()
      .refine(
        (value) =>
          value.previousExpiresAt ===
            value.verifiedAt + LEGACY_SESSION_RETENTION_MS &&
          value.migratedAt >= value.verifiedAt &&
          value.migratedAt < value.expiresAt,
        "Invalid retention migration evidence.",
      ),
  ])
  .refine(
    (value) => value.expiresAt === value.verifiedAt + SESSION_RETENTION_MS,
    "Invalid session retention deadline.",
  );
export const LoginAssuranceSchema = z.union([
  z
    .object({
      ...evidence,
      version: z.literal(4),
      retentionPolicy: z.literal("until-disconnected-v1"),
      retentionSource: z.literal("interactive-consent"),
      expiresAt: z.literal(NO_LOCAL_EXPIRY),
    })
    .strict(),
  LegacyLoginAssuranceSchema,
  RetainedLoginAssuranceSchema,
]);
export type LoginAssurance = z.infer<typeof LoginAssuranceSchema>;
export function loginAssurance(
  now = Date.now(),
  thirtyDays?: boolean,
): LoginAssurance {
  const common = {
    policy: APPLE_LOGIN_POLICY,
    factor: "trusted-device-spake2",
    verifiedAt: now,
    consentAppleTrust: true,
    consentPersistentSession: true,
  } as const;
  if (thirtyDays === undefined)
    return {
      ...common,
      version: 4,
      retentionPolicy: "until-disconnected-v1",
      retentionSource: "interactive-consent",
      expiresAt: NO_LOCAL_EXPIRY,
    };
  return thirtyDays
    ? {
        ...common,
        version: 3,
        retentionPolicy: RETENTION_POLICY,
        retentionSource: "interactive-consent",
        expiresAt: now + SESSION_RETENTION_MS,
      }
    : { ...common, version: 2, expiresAt: now + LEGACY_SESSION_RETENTION_MS };
}
export function requireCurrentLogin(login: LoginAssurance, now = Date.now()) {
  if (
    login.verifiedAt > now + 5000 ||
    (login.version !== 4 && now >= login.expiresAt)
  )
    throw new AppError(
      "AUTH_EXPIRED",
      "This connection's retained session has expired. Reconnect and verify your Apple device again.",
      409,
    );
}

// Apple has endpoint-specific success conventions. In particular, a bridge
// validation 409 is accepted by the pinned protocol. Explicit rejection is
// never overridden by an otherwise supported HTTP status.
export function requireNoAppleRejection(
  body: Record<string, unknown> | null,
  stage = "authentication",
) {
  if (!body) return;
  const securityCode = body.securityCode;
  const rejected =
    body.success === false ||
    body.valid === false ||
    body.verified === false ||
    body.authenticated === false ||
    (body.error !== undefined && body.error !== null) ||
    (body.errorCode !== undefined &&
      body.errorCode !== 0 &&
      body.errorCode !== "0") ||
    (Array.isArray(body.serviceErrors) && body.serviceErrors.length > 0) ||
    (securityCode !== null &&
      typeof securityCode === "object" &&
      !Array.isArray(securityCode) &&
      (securityCode as Record<string, unknown>).valid === false);
  if (rejected)
    throw new AppError(
      "VERIFICATION_REQUIRED",
      `Apple ${stage}: authentication result rejected (success=${flag(body.success)}; valid=${flag(body.valid)}; verified=${flag(body.verified)}; authenticated=${flag(body.authenticated)}; error=${body.error == null ? "absent" : "present"}; errorCode=${typeof body.errorCode === "number" && Number.isFinite(body.errorCode) ? body.errorCode : "unspecified"}; serviceErrors=${Array.isArray(body.serviceErrors) ? body.serviceErrors.length : 0}).`,
      409,
    );
}

function flag(value: unknown) {
  return value === true
    ? "true"
    : value === false
      ? "false"
      : value === undefined
        ? "missing"
        : "invalid";
}
