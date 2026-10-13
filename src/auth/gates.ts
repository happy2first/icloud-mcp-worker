import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
export function appleGates(env: RuntimeEnv) {
  const enabled = env.APPLE_LOGIN_ENABLED !== "false";
  return {
    enabled,
    liveConnectionApproved: false,
    cryptographyReviewed: false,
    loginPolicy: "device-only-v2",
    verificationMethod: "trusted-device-spake2",
    passwordLocation: "browser-only",
    sessionStorage: "owner-scoped-encrypted",
    sessionLifetimeMs: null,
    retentionDays: null,
    retentionWritesEnabled: true,
    renewalEnabled: env.APPLE_SESSION_RENEWAL_ENABLED !== "false",
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
