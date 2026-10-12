import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
export function appleGates(env: RuntimeEnv) {
  const retained = env.APPLE_SESSION_RETENTION_WRITES === "absolute-30d-v1";
  const enabled = env.APPLE_LOGIN_ENABLED === "true";
  return {
    enabled,
    liveConnectionApproved: false,
    cryptographyReviewed: false,
    loginPolicy: "device-only-v2",
    verificationMethod: "trusted-device-spake2",
    passwordLocation: "browser-only",
    sessionStorage: "owner-scoped-encrypted",
    sessionLifetimeMs: retained ? 2592000000 : 86400000,
    retentionDays: retained ? 30 : 1,
    retentionWritesEnabled: retained,
    renewalEnabled: env.APPLE_SESSION_RENEWAL_ENABLED === "saved-tokens-v1",
    socketLifetimeMs: 180000,
  } as const;
}
export function appleDisabledMessage(_: unknown) {
  return "Apple login is disabled. Set APPLE_LOGIN_ENABLED=true to enable the secure management form. This implementation has not been validated against a real Apple account.";
}
export function requireAppleEnabled(env: RuntimeEnv) {
  if (!appleGates(env).enabled)
    throw new AppError("UNSUPPORTED_AUTH", appleDisabledMessage(null));
}
