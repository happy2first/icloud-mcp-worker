import { AppError, requireValue } from "../errors.ts";
export interface RuntimeEnv {
  APPLE_LOGIN_ENABLED?: string;
  DB?: D1Database;
  REMINDERS_OWNER_ID?: string;
  APP_ORIGIN?: string;
  ENCRYPTION_KEY_ID?: string;
  ENCRYPTION_KEYS_JSON?: string;
  LIVE_APPLE_CONNECTION_APPROVED?: string;
  APPLE_CRYPTO_REVIEW_APPROVED?: string;
  APPLE_SESSION_RETENTION_WRITES?: string;
  APPLE_SESSION_RETENTION_MIGRATION_JSON?: string;
  APPLE_SESSION_RENEWAL_ENABLED?: string;
  APPLE_SESSION_CHECK_INTERVAL_MS?: string;
}
export function requireOwner(request: Request, env: RuntimeEnv): string {
  // The Sites dispatcher or standalone Access adapter must authenticate and
  // replace these headers before any request reaches this shared application.
  const owner = request.headers.get("oai-authenticated-user-id");
  if (!owner || owner.length > 256)
    throw new AppError(
      "UNAUTHENTICATED",
      "Sign in with ChatGPT to continue.",
      401,
    );
  if (!env.REMINDERS_OWNER_ID || !env.APP_ORIGIN)
    throw new AppError(
      "OWNER_NOT_CONFIGURED",
      "The site owner and trusted origin must be explicitly configured before this prototype can run.",
      503,
    );
  let expected: URL;
  try {
    expected = new URL(env.APP_ORIGIN);
  } catch {
    throw new AppError(
      "CONFIGURATION_REQUIRED",
      "The trusted Site origin is invalid.",
      503,
    );
  }
  const actual = new URL(request.url);
  requireValue(
    expected.origin === env.APP_ORIGIN &&
      (expected.protocol === "https:" ||
        ["localhost", "127.0.0.1"].includes(expected.hostname)),
    "Invalid Site origin configuration.",
  );
  if (actual.origin !== expected.origin)
    throw new AppError(
      "FORBIDDEN",
      "Requests must pass through the configured private Site.",
      403,
    );
  if (owner !== env.REMINDERS_OWNER_ID)
    throw new AppError(
      "FORBIDDEN",
      "This site is restricted to its configured owner.",
      403,
    );
  return owner;
}
export function requireSameOrigin(request: Request, env: RuntimeEnv) {
  if (
    request.headers.get("origin") !== env.APP_ORIGIN ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError(
      "FORBIDDEN",
      "Use this site's setup page for this action.",
      403,
    );
  if (
    !(request.headers.get("content-type") ?? "").startsWith("application/json")
  )
    throw new AppError("VALIDATION_ERROR", "A JSON request is required.", 415);
}
