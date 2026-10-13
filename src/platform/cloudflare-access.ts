import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
  type RemoteJWKSet,
} from "jose";
import type { RuntimeEnv } from "./sites.ts";

export interface CloudflareAccessEnv extends RuntimeEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
}

export type AuthenticatedFetch = (
  request: Request,
  env: CloudflareAccessEnv,
) => Promise<Response>;

interface AccessConfig {
  issuer: string;
  audience: string;
  appOrigin: string;
  ownerId?: string;
}

const MAX_ASSERTION_BYTES = 16_384;
const MAX_JWKS_RESOLVERS = 4;
const JWKS_TIMEOUT_MS = 3_000;
const JWKS_CACHE_MAX_AGE_MS = 5 * 60_000;
const JWKS_COOLDOWN_MS = 30_000;

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function readConfig(
  env: CloudflareAccessEnv,
  request: Request,
): AccessConfig | null {
  if (
    typeof env.TEAM_DOMAIN !== "string" ||
    typeof env.POLICY_AUD !== "string" ||
    !env.POLICY_AUD ||
    env.POLICY_AUD.length > 512
  )
    return null;

  let team: URL;
  let app: URL;
  try {
    team = new URL(env.TEAM_DOMAIN);
    app = new URL(env.APP_ORIGIN ?? new URL(request.url).origin);
  } catch {
    return null;
  }

  const teamMatch =
    /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.cloudflareaccess\.com\/?$/.exec(
      env.TEAM_DOMAIN,
    );
  if (
    !teamMatch ||
    team.protocol !== "https:" ||
    team.username ||
    team.password ||
    team.port ||
    team.search ||
    team.hash ||
    team.pathname !== "/" ||
    team.origin !== `https://${teamMatch[1]}.cloudflareaccess.com`
  )
    return null;

  if (
    app.protocol !== "https:" ||
    app.username ||
    app.password ||
    app.search ||
    app.hash ||
    app.pathname !== "/" ||
    (env.APP_ORIGIN !== undefined && app.origin !== env.APP_ORIGIN) ||
    app.hostname.includes(":") ||
    !app.hostname.includes(".") ||
    app.hostname === "localhost" ||
    app.hostname.endsWith(".localhost") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(app.hostname)
  )
    return null;

  const ownerId = env.REMINDERS_OWNER_ID;
  if (
    ownerId !== undefined &&
    ownerId !== "" &&
    (typeof ownerId !== "string" || ownerId.length > 256)
  )
    return null;
  return {
    issuer: team.origin,
    audience: env.POLICY_AUD,
    appOrigin: app.origin,
    ...(ownerId ? { ownerId } : {}),
  };
}

function isRejectedAssertion(error: unknown): boolean {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    typeof error.code !== "string"
  )
    return false;
  return (
    error.code === "ERR_JOSE_ALG_NOT_ALLOWED" ||
    error.code === "ERR_JWKS_NO_MATCHING_KEY" ||
    error.code.startsWith("ERR_JWS_") ||
    error.code.startsWith("ERR_JWT_")
  );
}

function validPrincipal(
  payload: Record<string, unknown>,
): { sub: string; email?: string } | null {
  const now = Math.floor(Date.now() / 1000);
  const sub = payload.sub;
  const iat = payload.iat;
  const exp = payload.exp;
  const email = payload.email;
  if (typeof sub !== "string" || !safeHeaderValue(sub) || sub.length > 256)
    return null;
  if (typeof iat !== "number" || !Number.isFinite(iat) || iat > now)
    return null;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= now)
    return null;
  if (
    email !== undefined &&
    (typeof email !== "string" || !safeHeaderValue(email) || email.length > 320)
  )
    return null;
  return { sub, ...(typeof email === "string" ? { email } : {}) };
}

function safeHeaderValue(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    [...value].every((character) => character.charCodeAt(0) <= 0xff)
  );
}

function withVerifiedIdentity(
  request: Request,
  identity: { sub: string; email?: string },
): Request {
  const headers = new Headers(request.headers);
  const names = [...headers.keys()];
  for (const name of names) {
    const normalized = name.toLowerCase();
    if (
      normalized.startsWith("oai-authenticated-user-") ||
      normalized.startsWith("cf-access-authenticated-user-") ||
      normalized === "cf-access-jwt-assertion" ||
      normalized === "x-reminders-auth-provider"
    )
      headers.delete(name);
  }
  headers.set("oai-authenticated-user-id", identity.sub);
  if (identity.email)
    headers.set("oai-authenticated-user-email", identity.email);
  headers.set("x-reminders-auth-provider", "cloudflare-access");
  return new Request(request, { headers });
}

export function createCloudflareAccessHandler(
  jwksFetch: FetchImplementation = fetch,
) {
  const jwksByIssuer = new Map<string, RemoteJWKSet>();

  function remoteKeys(issuer: string): RemoteJWKSet {
    const cached = jwksByIssuer.get(issuer);
    if (cached) return cached;
    const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: JWKS_TIMEOUT_MS,
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      [customFetch]: jwksFetch,
    });
    jwksByIssuer.set(issuer, keys);
    if (jwksByIssuer.size > MAX_JWKS_RESOLVERS)
      jwksByIssuer.delete(jwksByIssuer.keys().next().value as string);
    return keys;
  }

  return async function cloudflareAccessFetch(
    request: Request,
    env: CloudflareAccessEnv,
    next: AuthenticatedFetch,
  ): Promise<Response> {
    const config = readConfig(env, request);
    if (!config)
      return errorResponse(
        503,
        "AUTH_CONFIGURATION_REQUIRED",
        "Cloudflare Access and the production origin must be configured.",
      );

    let requestOrigin: string;
    try {
      requestOrigin = new URL(request.url).origin;
    } catch {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Requests must use the configured application origin.",
      );
    }
    if (
      requestOrigin !== config.appOrigin ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== config.appOrigin)
    ) {
      return errorResponse(
        403,
        "FORBIDDEN",
        "Requests must use the configured application origin.",
      );
    }

    const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!assertion)
      return errorResponse(
        401,
        "UNAUTHENTICATED",
        "A valid Cloudflare Access session is required.",
      );
    if (
      assertion.length > MAX_ASSERTION_BYTES ||
      assertion.split(".").length !== 3
    )
      return errorResponse(
        403,
        "FORBIDDEN",
        "The Cloudflare Access assertion is invalid.",
      );

    let identity: { sub: string; email?: string } | null = null;
    try {
      const verified = await jwtVerify(assertion, remoteKeys(config.issuer), {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ["sub", "iat", "exp"],
      });
      identity = validPrincipal(verified.payload);
    } catch (error) {
      if (isRejectedAssertion(error))
        return errorResponse(
          403,
          "FORBIDDEN",
          "The Cloudflare Access assertion is invalid.",
        );
      return errorResponse(
        503,
        "AUTH_VERIFICATION_UNAVAILABLE",
        "Cloudflare Access verification is temporarily unavailable.",
      );
    }
    if (!identity)
      return errorResponse(
        403,
        "FORBIDDEN",
        "The Cloudflare Access assertion is invalid.",
      );

    if (config.ownerId && identity.sub !== config.ownerId) {
      return errorResponse(
        403,
        "FORBIDDEN",
        "This application is restricted to its configured owner.",
      );
    }

    // Per-request context, derived only after signature/issuer/audience validation.
    // Never mutate the shared Workers env or accept caller identity headers.
    const identityContext = {
      APP_ORIGIN: config.appOrigin,
      REMINDERS_OWNER_ID: identity.sub,
    };
    // A spread only copies enumerable own properties. Runtime bindings may be
    // inherited or getter-backed; forward reads to the original env receiver.
    // The separate target also works with frozen/non-configurable env bindings.
    const requestEnv = new Proxy(identityContext as CloudflareAccessEnv, {
      get(target, property) {
        if (property === "APP_ORIGIN" || property === "REMINDERS_OWNER_ID")
          return Reflect.get(target, property, target);
        return Reflect.get(env, property, env);
      },
    });
    return next(withVerifiedIdentity(request, identity), requestEnv);
  };
}

export const cloudflareAccessFetch = createCloudflareAccessHandler();
