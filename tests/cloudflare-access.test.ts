import test from "node:test";
import assert from "node:assert/strict";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type FetchImplementation,
} from "jose";
import { applicationRoute } from "../src/api/router.ts";
import {
  createCloudflareAccessHandler,
  type CloudflareAccessEnv,
} from "../src/platform/cloudflare-access.ts";

const teamDomain = "https://synthetic-team.cloudflareaccess.com";
const issuer = teamDomain;
const audience = "synthetic-access-policy-audience";
const origin = "https://private.example.test";
const keyId = "synthetic-access-key";
const now = Math.floor(Date.now() / 1000);
const primaryKeys = await generateKeyPair("RS256", { modulusLength: 2048 });
const otherKeys = await generateKeyPair("RS256", { modulusLength: 2048 });
const publicJwk = await exportJWK(primaryKeys.publicKey);
Object.assign(publicJwk, { kid: keyId, alg: "RS256", use: "sig" });
const jwks = { keys: [publicJwk] };

function accessEnv(ownerId?: string): CloudflareAccessEnv {
  return {
    TEAM_DOMAIN: teamDomain,
    POLICY_AUD: audience,
    APP_ORIGIN: origin,
    ...(ownerId ? { REMINDERS_OWNER_ID: ownerId } : {}),
  };
}

function harness() {
  let jwksRequests = 0;
  const fetchJWKS: FetchImplementation = async (url, options) => {
    jwksRequests++;
    assert.equal(url, `${issuer}/cdn-cgi/access/certs`);
    assert.equal(options.method, "GET");
    return Response.json(jwks);
  };
  return {
    handle: createCloudflareAccessHandler(fetchJWKS),
    jwksRequests: () => jwksRequests,
  };
}

async function token(
  options: {
    sub?: string;
    email?: unknown;
    exp?: number;
    iat?: number;
    omitExp?: boolean;
    omitIat?: boolean;
    tokenIssuer?: string;
    tokenAudience?: string | string[];
    alg?: "RS256" | "HS256";
    signingKey?: CryptoKey | Uint8Array;
  } = {},
) {
  const payload: Record<string, unknown> = {
    sub: options.sub ?? "synthetic-access-sub",
    email: options.email ?? "operator@example.test",
  };
  let jwt = new SignJWT(payload).setProtectedHeader({
    alg: options.alg ?? "RS256",
    kid: keyId,
  });
  jwt = jwt
    .setIssuer(options.tokenIssuer ?? issuer)
    .setAudience(options.tokenAudience ?? audience);
  if (!options.omitIat) jwt = jwt.setIssuedAt(options.iat ?? now);
  if (!options.omitExp) jwt = jwt.setExpirationTime(options.exp ?? now + 300);
  return jwt.sign(options.signingKey ?? primaryKeys.privateKey);
}

function request(path: string, assertion?: string, headers: HeadersInit = {}) {
  const requestHeaders = new Headers(headers);
  if (assertion) requestHeaders.set("Cf-Access-Jwt-Assertion", assertion);
  return new Request(`${origin}${path}`, { headers: requestHeaders });
}

test("verified Access identity bootstraps an owner and replaces all caller-supplied identity headers", async () => {
  const { handle } = harness();
  const assertion = await token();
  let downstreamHeaders: Headers | undefined;
  const response = await handle(
    request("/api/bootstrap/identity", assertion, {
      origin,
      authorization: `Bearer ${assertion}`,
      "oai-authenticated-user-id": "forged-owner",
      "oai-authenticated-user-email": "forged@example.test",
      "oai-authenticated-user-name": "forged name",
      "cf-access-authenticated-user-email": "forged-cloudflare@example.test",
      "x-reminders-auth-provider": "forged-provider",
    }),
    accessEnv(),
    async (authenticatedRequest) => {
      downstreamHeaders = authenticatedRequest.headers;
      return (await applicationRoute(authenticatedRequest, accessEnv()))!;
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    authenticatedUserId: "synthetic-access-sub",
    ownerBound: false,
    automaticOwnerClaim: false,
  });
  assert.equal(
    downstreamHeaders?.get("oai-authenticated-user-id"),
    "synthetic-access-sub",
  );
  assert.equal(
    downstreamHeaders?.get("oai-authenticated-user-email"),
    "operator@example.test",
  );
  assert.equal(
    downstreamHeaders?.get("x-reminders-auth-provider"),
    "cloudflare-access",
  );
  assert.equal(downstreamHeaders?.get("cf-access-jwt-assertion"), null);
  assert.equal(downstreamHeaders?.get("oai-authenticated-user-name"), null);
  assert.equal(
    downstreamHeaders?.get("cf-access-authenticated-user-email"),
    null,
  );
  const identityHeaders = [...downstreamHeaders!.keys()].filter(
    (name) =>
      name.startsWith("oai-authenticated-user-") ||
      name.startsWith("cf-access-authenticated-user-") ||
      name === "x-reminders-auth-provider",
  );
  assert.deepEqual(identityHeaders.sort(), [
    "oai-authenticated-user-email",
    "oai-authenticated-user-id",
    "x-reminders-auth-provider",
  ]);

  let called = false;
  const otherRoute = await handle(
    request("/api/auth/config", assertion),
    accessEnv(),
    async () => {
      called = true;
      return new Response("unexpected");
    },
  );
  assert.equal(otherRoute.status, 200);
  assert.equal(called, true);
});

test("minimal Access config derives isolated identity and origin without trusting forwarded headers", async () => {
  const { handle } = harness();
  const minimal = { TEAM_DOMAIN: teamDomain, POLICY_AUD: audience };
  const seen: string[] = [];
  for (const sub of ["first-user", "second-user"]) {
    const response = await handle(
      request("/api/auth/config", await token({ sub }), {
        "oai-authenticated-user-id": "forged-owner",
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "http",
      }),
      minimal,
      async (authenticated, runtime) => {
        assert.equal(runtime.APP_ORIGIN, origin);
        assert.equal(runtime.REMINDERS_OWNER_ID, sub);
        assert.equal(
          authenticated.headers.get("oai-authenticated-user-id"),
          sub,
        );
        seen.push(runtime.REMINDERS_OWNER_ID!);
        return applicationRoute(authenticated, runtime) as Promise<Response>;
      },
    );
    assert.equal(response.status, 200);
  }
  assert.deepEqual(seen, ["first-user", "second-user"]);
  assert.deepEqual(Object.keys(minimal).sort(), ["POLICY_AUD", "TEAM_DOMAIN"]);
  const rejected = await handle(
    request("/api/auth/config", await token(), {
      origin: "https://evil.example.test",
    }),
    minimal,
    async () => {
      throw new Error("CSRF reached application");
    },
  );
  assert.equal(rejected.status, 403);
  const insecure = await handle(
    new Request("http://private.example.test/admin", {
      headers: { "cf-access-jwt-assertion": await token() },
    }),
    minimal,
    async () => {
      throw new Error("HTTP reached application");
    },
  );
  assert.equal(insecure.status, 503);
});

test("only the configured owner reaches ordinary routes, and signed JWT claims are checked", async () => {
  const { handle, jwksRequests } = harness();
  const ownerEnv = accessEnv("synthetic-access-sub");
  const ownerAssertion = await token();
  const ownerResponse = await handle(
    request("/api/auth/config", ownerAssertion),
    ownerEnv,
    (authenticatedRequest) =>
      applicationRoute(authenticatedRequest, ownerEnv) as Promise<Response>,
  );
  assert.equal(ownerResponse.status, 200);
  assert.equal(jwksRequests(), 1);

  const alternate = await generateKeyPair("RS256", { modulusLength: 2048 });
  const badAssertions = [
    await token({ signingKey: otherKeys.privateKey }),
    await token({ exp: now - 1, iat: now - 301 }),
    await token({ tokenIssuer: "https://attacker.cloudflareaccess.com" }),
    await token({ tokenAudience: "another-policy-audience" }),
    await token({
      alg: "HS256",
      signingKey: new TextEncoder().encode("synthetic-shared-key"),
    }),
    await token({ omitIat: true }),
    await token({ omitExp: true }),
    await token({ sub: "" }),
    await token({ sub: "s".repeat(257) }),
    await token({ email: "x".repeat(321) }),
    await new SignJWT({
      sub: "synthetic-access-sub",
      email: "operator@example.test",
    })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(alternate.privateKey),
  ];

  for (const assertion of badAssertions) {
    let called = false;
    const response = await handle(
      request("/api/auth/config", assertion),
      ownerEnv,
      async () => {
        called = true;
        return new Response("unexpected");
      },
    );
    assert.equal(response.status, 403);
    assert.equal(called, false);
  }

  let wrongOwnerCalled = false;
  const wrongOwner = await handle(
    request("/api/auth/config", await token({ sub: "another-signed-sub" })),
    ownerEnv,
    async () => {
      wrongOwnerCalled = true;
      return new Response("unexpected");
    },
  );
  assert.equal(wrongOwner.status, 403);
  assert.equal(wrongOwnerCalled, false);
});

test("missing assertions, raw Authorization tokens, invalid config and wrong origins fail closed", async () => {
  const { handle, jwksRequests } = harness();
  const assertion = await token();
  let called = false;
  const noAssertion = await handle(
    request("/api/auth/config", undefined, {
      authorization: `Bearer ${assertion}`,
    }),
    accessEnv("synthetic-access-sub"),
    async () => {
      called = true;
      return new Response("unexpected");
    },
  );
  assert.equal(noAssertion.status, 401);
  assert.equal(called, false);

  const badConfig = await handle(
    request("/api/auth/config", assertion),
    {
      ...accessEnv("synthetic-access-sub"),
      TEAM_DOMAIN: "https://nested.team.cloudflareaccess.com/path",
    },
    async () => new Response("unexpected"),
  );
  assert.equal(badConfig.status, 503);

  const wrongUrl = await handle(
    new Request("https://wrong.example.test/api/auth/config", {
      headers: { "Cf-Access-Jwt-Assertion": assertion },
    }),
    accessEnv("synthetic-access-sub"),
    async () => {
      called = true;
      return new Response("unexpected");
    },
  );
  assert.equal(wrongUrl.status, 403);
  const wrongOriginHeader = await handle(
    request("/api/auth/config", assertion, {
      origin: "https://attacker.example.test",
    }),
    accessEnv("synthetic-access-sub"),
    async () => {
      called = true;
      return new Response("unexpected");
    },
  );
  assert.equal(wrongOriginHeader.status, 403);

  const websocket = new Request(`${origin}/api/auth/socket`, {
    headers: {
      "Cf-Access-Jwt-Assertion": assertion,
      origin,
      upgrade: "websocket",
    },
  });
  const websocketForwarded = await handle(
    websocket,
    accessEnv("synthetic-access-sub"),
    async (authenticatedRequest) => {
      assert.equal(authenticatedRequest.headers.get("upgrade"), "websocket");
      return new Response("forwarded");
    },
  );
  assert.equal(websocketForwarded.status, 200);
  const wrongWebsocketOrigin = new Request(`${origin}/api/auth/socket`, {
    headers: {
      "Cf-Access-Jwt-Assertion": assertion,
      origin: "https://attacker.example.test",
      upgrade: "websocket",
    },
  });
  const websocketRejected = await handle(
    wrongWebsocketOrigin,
    accessEnv("synthetic-access-sub"),
    async () => {
      called = true;
      return new Response("unexpected");
    },
  );
  assert.equal(websocketRejected.status, 403);
  assert.equal(called, false);
  assert.equal(jwksRequests(), 1);
});

test("JWKS fetch failures return a safe unavailable response", async () => {
  const unavailable = createCloudflareAccessHandler(async () => {
    throw new Error("synthetic private fetch detail");
  });
  const response = await unavailable(
    request("/api/auth/config", await token()),
    accessEnv("synthetic-access-sub"),
    async () => new Response("unexpected"),
  );
  assert.equal(response.status, 503);
  assert.ok(
    !(await response.text()).includes("synthetic private fetch detail"),
  );
});
