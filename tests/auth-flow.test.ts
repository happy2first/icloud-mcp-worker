import test from "node:test";
import assert from "node:assert/strict";
import fixtures from "./fixtures/protocol.json" with { type: "json" };
import { b64, concat, hex, unb64, unhex, utf8 } from "../src/crypto/bytes.ts";
import { bytesField, uint } from "../src/crypto/protobuf.ts";
import { AppleSignInFlow } from "../src/auth/apple/flow.ts";
import { AppleAuthHTTP } from "../src/auth/apple/http.ts";
import {
  AuthResponseSequence,
  ServerAuthEvent,
} from "../src/auth/apple/events.ts";
import { publicError, UpstreamRateLimitedError } from "../src/errors.ts";
import {
  APPLE_AUTH_PROTOCOL,
  AUTH_LIFETIME_MS,
} from "../src/auth/apple/protocol.ts";
import { advancePcs, freshPcsCheckpoint } from "../src/auth/apple/pcs.ts";
import { appleAuthSocket } from "../src/auth/socket.ts";
import {
  BrowserBridgeProof,
  BrowserSrpProof,
} from "../src/auth/browser-proof.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import {
  encodePushAcknowledgement,
  encodeSyntheticPushFrame,
  encodeTopicFilter,
} from "../src/transport/apple-push.ts";

type RecordedRequest = {
  url: URL;
  method: string;
  path: string;
  body?: unknown;
  headers: Headers;
};
type Reply = {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: HeadersInit;
  cookies?: string[];
};
type ReplyPlan =
  | Reply
  | ((request: RecordedRequest) => Response | Promise<Response>);

function response(value: Reply): Response {
  const headers = new Headers(value.headers);
  if (value.cookies)
    for (const cookie of value.cookies) headers.append("set-cookie", cookie);
  const body =
    value.text !== undefined ? value.text : JSON.stringify(value.body ?? {});
  if (value.text !== undefined)
    headers.set("content-type", "text/html; charset=utf-8");
  else headers.set("content-type", "application/json");
  const status = value.status ?? 200;
  return new Response([204, 205, 304].includes(status) ? null : body, {
    status,
    headers,
  });
}

function scriptedHTTP(
  plans: ReplyPlan[],
  signal = new AbortController().signal,
) {
  const requests: RecordedRequest[] = [];
  const pending = [...plans];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      path: url.pathname,
      ...(raw ? { body: JSON.parse(raw) as unknown } : {}),
      headers: new Headers(init?.headers),
    };
    requests.push(request);
    const next = pending.shift();
    if (!next)
      throw new Error(
        `Unexpected mocked Apple request: ${request.method} ${url.pathname}`,
      );
    return typeof next === "function" ? await next(request) : response(next);
  }) as typeof fetch;
  const http = new AppleAuthHTTP(
    new AppleHTTP(new CookieJar(), send),
    undefined,
    signal,
  );
  return { http, requests, remaining: () => pending.length };
}

const srp = fixtures.srp[0];
const challenge = {
  salt: b64(unhex(srp.salt)),
  b: b64(unhex(srp.B)),
  c: "synthetic-challenge-context",
  iteration: srp.iterations,
  protocol: srp.protocol,
};
const binding = {
  transactionId: "e706b087-1111-4111-8111-111111111111",
  nonce: "a".repeat(64),
};
test("login error frames accept bounded public retry metadata without accepting secret fields", () => {
  const event = {
    type: "failed",
    direction: "server",
    ...binding,
    sequence: 1,
    error: publicError(new UpstreamRateLimitedError(7), crypto.randomUUID()),
  };
  const parsed = ServerAuthEvent.parse(event);
  assert.equal(parsed.type, "failed");
  if (parsed.type === "failed") assert.equal(parsed.error.retryAfterSeconds, 7);
  assert.equal(
    ServerAuthEvent.safeParse({
      ...event,
      error: { ...event.error, cookie: "synthetic-secret" },
    }).success,
    false,
  );
  assert.equal(
    ServerAuthEvent.safeParse({
      ...event,
      error: { ...event.error, retryAfterSeconds: -1 },
    }).success,
    false,
  );
});
const startMessage = {
  ...binding,
  sequence: 0 as const,
  consentAppleTrust: true as const,
  type: "start" as const,
  accountName: srp.account,
  publicA: b64(unhex(srp.A)),
  consentPersistentSession: true as const,
};
const proofMessage = {
  type: "srp-proof" as const,
  ...binding,
  sequence: 1,
  m1: b64(unhex(srp.M1)),
  m2: b64(unhex(srp.M2)),
};
const authenticatedHeaders = {
  "X-Apple-Session-Token": "synthetic-session-token",
  "X-Apple-ID-Account-Country": "US",
  "X-Apple-TwoSV-Trust-Token": "synthetic-trust-token",
};
const accountReply = {
  hsaTrustedBrowser: true,
  dsInfo: { dsid: "123456789" },
  webservices: {
    ckdatabasews: { url: "https://p123-ckdatabasews.icloud.com" },
  },
};
const bootHTML = (value: unknown) =>
  `<html><script class="boot_args">${JSON.stringify(value)}</script></html>`;
const hsa2Prefix = (htmlBoot: unknown, jsonBoot: unknown = {}) => [
  { cookies: ["authseed=synthetic-cookie; Path=/; Secure"] },
  { body: challenge },
  { status: 409, body: { authType: "hsa2" } },
  { text: bootHTML(htmlBoot) },
  { body: jsonBoot },
];

async function beginHsa2(flow: AppleSignInFlow) {
  const first = await flow.start(startMessage);
  assert.equal(first.type, "srp-challenge");
  return flow.advance(proofMessage);
}

test("phone, voice and legacy trusted-device routes stop before verification, trust or persistence", async () => {
  for (const route of ["auth/verify/phone", "auth/verify/trusteddevice"]) {
    const harness = scriptedHTTP(
      hsa2Prefix(
        {
          direct: {
            authInitialRoute: route,
            hasTrustedDevices: true,
            twoSV: {
              phoneNumberVerification: {
                trustedPhoneNumber: { id: 7, pushMode: "sms" },
              },
            },
          },
        },
        { phoneNumberVerification: { mode: "voice" } },
      ),
    );
    let persisted = false;
    const flow = new AppleSignInFlow(
      harness.http,
      new AbortController().signal,
      async () => {
        persisted = true;
      },
    );
    await assert.rejects(
      beginHsa2(flow),
      (error: any) => error.code === "UNSUPPORTED_AUTH",
    );
    assert.equal(harness.requests.length, 5);
    assert.equal(persisted, false);
  }
  const harness = scriptedHTTP([
    { body: {} },
    { body: challenge },
    { status: 200, headers: authenticatedHeaders },
  ]);
  let persisted = false;
  const flow = new AppleSignInFlow(
    harness.http,
    new AbortController().signal,
    async () => {
      persisted = true;
    },
  );
  await assert.rejects(
    beginHsa2(flow),
    (error: any) => error.code === "UNSUPPORTED_AUTH",
  );
  assert.equal(harness.requests.length, 3);
  assert.equal(persisted, false);
});

function bridgeHarness(
  options: {
    region?: "cn" | "international";
    validation?: Reply;
    trust?: ReplyPlan[];
    account?: Reply;
    stepZero?: ReplyPlan;
    pushIdentity?: string;
    pushAlias?: string | "echo-request";
    serverFlowId?: string;
    laterIdentity?: string;
  } = {},
) {
  const topic = "synthetic.topic";
  const topicHash = unhex(fixtures.push.topicHash);
  const otherTopic = new Uint8Array(20).fill(9);
  const tokenHex = "a1b2c3";
  const events: string[] = [];
  const sent: Uint8Array[] = [];
  const requests: RecordedRequest[] = [];
  const connectionFrame = bytesField(
    1,
    concat(bytesField(1, utf8(b64(unhex(tokenHex)))), uint(2, 0)),
  );
  let receives = 0;
  const push = (payload: unknown, id: number, hash = topicHash) =>
    encodeSyntheticPushFrame(hash, utf8(JSON.stringify(payload)), id);
  const channel = {
    send(bytes: Uint8Array) {
      sent.push(bytes.slice());
      events.push("send");
    },
    async receive() {
      receives++;
      if (receives === 1) {
        events.push("receive-token");
        return connectionFrame;
      }
      if (receives === 2) {
        events.push("receive-other-topic");
        return push(
          { sessionUUID: "ignored", nextStep: 2, salt: "ignored" },
          700,
          otherTopic,
        );
      }
      const stepZero = requests.find(
        (request) => request.path === "/appleauth/auth/bridge/step/0",
      );
      const sessionUUID =
        options.pushIdentity ??
        (stepZero?.body as { sessionUUID?: string } | undefined)?.sessionUUID;
      assert.ok(sessionUUID);
      const identity = options.serverFlowId
        ? {
            flowid:
              receives > 3
                ? (options.laterIdentity ?? options.serverFlowId)
                : options.serverFlowId,
          }
        : {
            sessionUUID,
            ...(options.pushAlias
              ? {
                  flowid:
                    options.pushAlias === "echo-request"
                      ? (stepZero?.body as { sessionUUID: string }).sessionUUID
                      : options.pushAlias,
                }
              : {}),
          };
      if (receives === 3) {
        events.push("receive-step-2");
        return push(
          { ...identity, nextStep: 2, salt: b64(unhex(fixtures.bridge.salt)) },
          701,
        );
      }
      if (receives === 4) {
        events.push("receive-step-4");
        const serverShare = b64(unhex(fixtures.bridge.serverMessage));
        const serverConfirmation = b64(
          unhex(fixtures.bridge.serverConfirmation),
        );
        return push(
          {
            ...identity,
            nextStep: 4,
            data: b64(utf8(`${serverShare}_${serverConfirmation}`)),
          },
          702,
        );
      }
      events.push("receive-step-6");
      return push(
        { ...identity, nextStep: 6, encryptedCode: fixtures.bridge.ciphertext },
        703,
      );
    },
    close() {
      events.push("close");
    },
  };
  const fetchPlans: ReplyPlan[] = [
    ...hsa2Prefix(
      {
        direct: {
          authInitialRoute: "auth/bridge/step",
          hasTrustedDevices: true,
          twoSV: {
            bridgeInitiateData: { apnsEnvironment: "prod", apnsTopic: topic },
            sourceAppId: "com.synthetic.test",
          },
        },
      },
      { phoneNumberVerification: { trustedPhoneNumber: { id: 99 } } },
    ),
    options.stepZero ?? { status: 204 },
    { status: 204 },
    { status: 204 },
    options.validation ?? { status: 200, headers: authenticatedHeaders }, // bridge/code/validate
    { status: 204 }, // bridge/step/6 with "done"
    ...(options.trust ?? [{ status: 204 }]), // trust browser
    options.account ?? { body: accountReply },
  ];
  const signal = new AbortController().signal;
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      path: url.pathname,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as unknown }
        : {}),
      headers: new Headers(init?.headers),
    };
    requests.push(request);
    const plan = fetchPlans.shift();
    if (!plan)
      throw new Error(`Unexpected bridge Apple request ${url.pathname}`);
    if (
      url.pathname.includes("/bridge/step/") ||
      url.pathname.endsWith("/bridge/code/validate")
    )
      events.push(`http-${url.pathname.split("/").at(-1)}`);
    return typeof plan === "function" ? await plan(request) : response(plan);
  }) as typeof fetch;
  const http = new AppleAuthHTTP(
    new AppleHTTP(new CookieJar(), send),
    undefined,
    signal,
    options.region,
  );
  const connect = async (url: string, connectSignal: AbortSignal) => {
    events.push("connect");
    assert.equal(connectSignal, signal);
    assert.match(url, /^wss:\/\/websocket\.push\.apple\.com\/v2\/[0-9a-f]+$/);
    return channel;
  };
  let saved: any = null;
  const flow = new AppleSignInFlow(
    http,
    signal,
    async (session, result) => {
      saved = { session, result };
    },
    connect,
  );
  return {
    flow,
    requests,
    sent,
    events,
    fetchPlans,
    topic,
    topicHash,
    otherTopic,
    tokenHex,
    saved: () => saved,
  };
}

test("HSA2 bridge orders step 0 before pushes and step 2/4/validate/done, filtering and acknowledging pushes", async () => {
  const {
    flow,
    requests,
    sent,
    events,
    fetchPlans,
    topic,
    topicHash,
    otherTopic,
    tokenHex,
    saved,
  } = bridgeHarness();
  const bridgeChallenge = await beginHsa2(flow);
  assert.equal(bridgeChallenge.type, "bridge-challenge");
  const outOfOrder = {
    type: "bridge-confirmation" as const,
    ...binding,
    sequence: 1,
    data: b64(unhex(fixtures.bridge.confirmation)),
  };
  await assert.rejects(
    flow.advance(outOfOrder),
    (error: any) => error.code === "RESTART_REQUIRED",
  );

  const bridgeShare = await flow.advance({
    type: "bridge-share",
    ...binding,
    sequence: 1,
    data: b64(unhex(fixtures.bridge.clientMessage)),
  });
  assert.equal(bridgeShare.type, "bridge-response");
  assert.equal(
    bridgeShare.serverShare,
    b64(unhex(fixtures.bridge.serverMessage)),
  );
  const encrypted = await flow.advance({
    type: "bridge-confirmation",
    ...binding,
    sequence: 2,
    data: b64(unhex(fixtures.bridge.confirmation)),
  });
  assert.deepEqual(encrypted, {
    type: "bridge-encrypted",
    encryptedCode: fixtures.bridge.ciphertext,
  });
  const complete = await flow.advance({
    type: "bridge-validation",
    ...binding,
    sequence: 3,
    code: fixtures.bridge.plaintext,
  });
  assert.equal(complete.type, "complete");
  assert.equal(complete.state, "DEVICE_APPROVAL_PENDING");
  assert.equal(saved().result.state, "DEVICE_APPROVAL_PENDING");
  assert.equal(
    requests.some((r) => /requestPCS|requestWebAccessState/.test(r.path)),
    false,
    "Service PCS cannot prevent saving verified account credentials",
  );
  assert.equal(requests[0].url.searchParams.get("authVersion"), "latest");
  assert.equal(saved().session.login.factor, "trusted-device-spake2");
  assert.equal(complete.expiresAt, null);
  assert.equal(saved().session.login.version, 4);

  const bridgeRequests = requests.filter(
    (request) =>
      request.path.includes("/bridge/step/") ||
      request.path.endsWith("/bridge/code/validate"),
  );
  assert.deepEqual(
    bridgeRequests.map((request) => request.path),
    [
      "/appleauth/auth/bridge/step/0",
      "/appleauth/auth/bridge/step/2",
      "/appleauth/auth/bridge/step/4",
      "/appleauth/auth/bridge/code/validate",
      "/appleauth/auth/bridge/step/6",
    ],
  );
  assert.equal((bridgeRequests[0].body as { ptkn: string }).ptkn, tokenHex);
  assert.ok(
    bridgeRequests.every(
      (request) =>
        request.headers.get("x-apple-app-id") === "com.synthetic.test",
    ),
  );
  const sessionUUID = (bridgeRequests[0].body as { sessionUUID: string })
    .sessionUUID;
  assert.match(
    sessionUUID,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[0-9]{10}$/,
  );
  assert.ok(
    Math.abs(Number(sessionUUID.slice(-10)) - Math.floor(Date.now() / 1000)) <
      60,
  );
  assert.ok(
    bridgeRequests.every(
      (request) =>
        (request.body as { sessionUUID: string }).sessionUUID === sessionUUID,
    ),
  );
  assert.equal(
    (bridgeRequests[1].body as { data: string }).data,
    b64(unhex(fixtures.bridge.clientMessage)),
  );
  assert.equal(
    (bridgeRequests[2].body as { data: string }).data,
    b64(unhex(fixtures.bridge.confirmation)),
  );
  assert.deepEqual(bridgeRequests[3].body, {
    sessionUUID,
    code: fixtures.bridge.plaintext,
  });
  assert.equal(
    (bridgeRequests[4].body as { data: string }).data,
    b64(utf8("done")),
  );

  const filter = encodeTopicFilter([topic]);
  assert.equal(hex(sent[0]), hex(filter));
  assert.deepEqual(sent.slice(1).map(hex), [
    hex(encodePushAcknowledgement(otherTopic, 700)),
    hex(encodePushAcknowledgement(topicHash, 701)),
    hex(encodePushAcknowledgement(topicHash, 702)),
    hex(encodePushAcknowledgement(topicHash, 703)),
  ]);
  assert.ok(events.indexOf("send") < events.indexOf("http-0"));
  assert.ok(events.indexOf("http-0") < events.indexOf("receive-other-topic"));
  assert.equal(fetchPlans.length, 0);
});

test("a security-key requirement found only in JSON stops before any verification or persistence", async () => {
  const harness = scriptedHTTP(
    hsa2Prefix(
      {
        direct: {
          authInitialRoute: "auth/verify/phone",
          hasTrustedDevices: true,
          twoSV: { phoneNumberVerification: { trustedPhoneNumber: { id: 7 } } },
        },
      },
      { keyNames: ["fido-security-key"] },
    ),
  );
  let persisted = false;
  const flow = new AppleSignInFlow(
    harness.http,
    new AbortController().signal,
    async () => {
      persisted = true;
    },
  );

  await flow.start(startMessage);
  await assert.rejects(
    flow.advance(proofMessage),
    (error: any) => error.code === "UNSUPPORTED_AUTH",
  );
  assert.equal(harness.requests.length, 5);
  assert.equal(persisted, false);
});

async function bridgeUntilValidation(flow: AppleSignInFlow) {
  await beginHsa2(flow);
  await flow.advance({
    type: "bridge-share",
    ...binding,
    sequence: 2,
    data: b64(unhex(fixtures.bridge.clientMessage)),
  });
  await flow.advance({
    type: "bridge-confirmation",
    ...binding,
    sequence: 3,
    data: b64(unhex(fixtures.bridge.confirmation)),
  });
}
test("verified device login survives four browser-trust redirects and preserves intermediate session tokens", async () => {
  const h = bridgeHarness({
    trust: [
      {
        status: 302,
        headers: {
          location: "/appleauth/auth/2sv/trust?step=1",
          "X-Apple-Session-Token": "redirect-session-token",
          "set-cookie": "trust=synthetic-cookie; Path=/; Secure",
        },
      },
      {
        status: 303,
        headers: {
          location: "/appleauth/auth/2sv/trust?step=2",
          scnt: "redirect-scnt",
        },
      },
      {
        status: 302,
        headers: { location: "/appleauth/auth/2sv/trust?step=3" },
      },
      {
        status: 302,
        headers: { location: "/appleauth/auth/2sv/trust?step=4" },
      },
      { status: 204 },
    ],
  });
  await bridgeUntilValidation(h.flow);
  const done = await h.flow.advance({
    type: "bridge-validation",
    ...binding,
    sequence: 4,
    code: fixtures.bridge.plaintext,
  });
  assert.equal(done.type, "complete");
  assert.ok(h.saved());
  const trust = h.requests.filter((r) => r.path.endsWith("/2sv/trust"));
  assert.equal(trust.length, 5);
  assert.equal(trust[2].headers.get("scnt"), "redirect-scnt");
  assert.ok(trust[1].headers.get("cookie")?.includes("trust=synthetic-cookie"));
  const account = h.requests.find((r) => r.path.endsWith("/accountLogin"));
  assert.equal((account!.body as any).dsWebAuthToken, "redirect-session-token");
  assert.equal(h.saved()!.session.auth.headers.scnt, "redirect-scnt");
});

test("accountLogin accepts a Location-less 302 only with a complete trusted account result", async () => {
  const h = bridgeHarness({ account: { status: 302, body: accountReply } });
  await bridgeUntilValidation(h.flow);
  const done = await h.flow.advance({
    type: "bridge-validation",
    ...binding,
    sequence: 4,
    code: fixtures.bridge.plaintext,
  });
  assert.equal(done.type, "complete");
  assert.ok(h.saved());
  assert.equal(
    h.requests.filter((r) => r.path.endsWith("/accountLogin")).length,
    1,
  );
});

test("Location-less accountLogin 302 cannot save empty, untrusted or incomplete responses", async () => {
  for (const account of [
    { status: 302 },
    { status: 302, text: "<html>Redirecting</html>" },
    { status: 302, body: { ...accountReply, hsaTrustedBrowser: false } },
    { status: 302, body: { ...accountReply, hsaChallengeRequired: true } },
    { status: 302, body: { ...accountReply, termsUpdateNeeded: true } },
    { status: 302, body: { hsaTrustedBrowser: true } },
    {
      status: 302,
      body: {
        ...accountReply,
        webservices: { ckdatabasews: { url: "https://untrusted.invalid" } },
      },
    },
  ]) {
    const h = bridgeHarness({ account });
    await bridgeUntilValidation(h.flow);
    await assert.rejects(
      h.flow.advance({
        type: "bridge-validation",
        ...binding,
        sequence: 4,
        code: fixtures.bridge.plaintext,
      }),
    );
    assert.equal(h.saved(), null);
  }
});

test("account trust diagnostics distinguish missing flags without exposing Apple body values", async () => {
  const h = bridgeHarness({
    account: {
      status: 302,
      body: {
        domainToUse: "icloud.com.cn",
        dsInfo: { dsid: "private-sentinel" },
        secret: "private-sentinel",
        webservices: {},
      },
    },
  });
  await bridgeUntilValidation(h.flow);
  await assert.rejects(
    h.flow.advance({
      type: "bridge-validation",
      ...binding,
      sequence: 4,
      code: fixtures.bridge.plaintext,
    }),
    (e: any) => {
      assert.equal(e.code, "VERIFICATION_REQUIRED");
      assert.match(e.message, /hsaTrustedBrowser=missing/);
      assert.match(e.message, /hsaChallengeRequired=missing/);
      assert.match(e.message, /domainToUse=icloud.com.cn/);
      assert.ok(!e.message.includes("private-sentinel"));
      return true;
    },
  );
  assert.equal(h.saved(), null);
});

test("mainland device login uses China setup and persists region for restoration", async () => {
  const h = bridgeHarness({
    region: "cn",
    account: {
      body: {
        ...accountReply,
        webservices: {
          ckdatabasews: { url: "https://p123-ckdatabasews.icloud.com.cn" },
        },
      },
      cookies: [
        "X-APPLE-WEBAUTH-TOKEN=synthetic; Domain=.icloud.com.cn; Path=/; Secure",
      ],
    },
  });
  await bridgeUntilValidation(h.flow);
  const done = await h.flow.advance({
    type: "bridge-validation",
    ...binding,
    sequence: 4,
    code: fixtures.bridge.plaintext,
  });
  assert.equal(done.type, "complete");
  const account = h.requests.find((r) => r.path.endsWith("/accountLogin"))!;
  assert.equal(account.url.hostname, "setup.icloud.com.cn");
  assert.equal(account.headers.get("origin"), "https://www.icloud.com.cn");
  assert.equal(
    h.requests[0].url.searchParams.get("redirect_uri"),
    "https://www.icloud.com.cn",
  );
  assert.equal(h.saved().session.auth.region, "cn");
  assert.match(h.saved().session.connection.cloudKitURL, /icloud.com.cn/);
  const restored = AppleAuthHTTP.restore(h.saved().session.auth);
  assert.equal(restored.setupRoot, "https://setup.icloud.com.cn/setup/ws/1");
  assert.match(
    restored.http.jar.header(new URL(restored.setupRoot)),
    /WEBAUTH-TOKEN=synthetic/,
  );
  assert.equal(
    restored.http.jar.header(new URL("https://setup.icloud.com/setup/ws/1")),
    "",
  );
});

test("missing browser-trust redirect destination never saves a verified-device session as logged in", async () => {
  const h = bridgeHarness({ trust: [{ status: 302 }] });
  await bridgeUntilValidation(h.flow);
  await assert.rejects(
    h.flow.advance({
      type: "bridge-validation",
      ...binding,
      sequence: 4,
      code: fixtures.bridge.plaintext,
    }),
    (error: any) =>
      error.code === "APPLE_REDIRECT_ERROR" &&
      /browser-trust.*no Location/.test(error.message),
  );
  assert.equal(h.saved(), null);
  assert.ok(!h.requests.some((r) => r.path.endsWith("/accountLogin")));
});

test("bridge failures and Apple terms cannot be treated as successful device verification", async () => {
  for (const validation of [
    { status: 412 },
    { status: 409, body: { securityCode: { valid: false } } },
    { status: 200, body: { serviceErrors: [{ code: "rejected" }] } },
  ]) {
    const h = bridgeHarness({ validation });
    await bridgeUntilValidation(h.flow);
    await assert.rejects(
      h.flow.advance({
        type: "bridge-validation",
        ...binding,
        sequence: 4,
        code: fixtures.bridge.plaintext,
      }),
    );
    assert.equal(h.saved(), null);
    assert.ok(!h.requests.some((r) => /2sv\/trust|accountLogin/.test(r.path)));
    assert.equal(
      h.requests.filter((r) => r.path.endsWith("/bridge/step/6")).length,
      0,
    );
  }
  const terms = bridgeHarness({
    account: { body: { termsUpdateNeeded: true } },
  });
  await bridgeUntilValidation(terms.flow);
  await assert.rejects(
    terms.flow.advance({
      type: "bridge-validation",
      ...binding,
      sequence: 4,
      code: fixtures.bridge.plaintext,
    }),
    (e: any) => e.code === "TERMS_ACTION_REQUIRED",
  );
  assert.equal(terms.saved(), null);
  assert.equal(
    terms.requests.some((r) => /terms|accept/i.test(r.path)),
    false,
  );
  const supported409 = bridgeHarness({
    validation: { status: 409, headers: authenticatedHeaders },
  });
  await bridgeUntilValidation(supported409.flow);
  assert.equal(
    (
      await supported409.flow.advance({
        type: "bridge-validation",
        ...binding,
        sequence: 4,
        code: fixtures.bridge.plaintext,
      })
    ).type,
    "complete",
  );
});
test("canonical sessionUUID takes precedence over secondary flowid, while mismatched explicit echoes fail", async () => {
  const alias = bridgeHarness({ pushAlias: "secondary-apple-flow" });
  await bridgeUntilValidation(alias.flow);
  assert.equal(
    (
      await alias.flow.advance({
        type: "bridge-validation",
        ...binding,
        sequence: 4,
        code: fixtures.bridge.plaintext,
      })
    ).type,
    "complete",
  );
  const mixed = bridgeHarness({
    pushIdentity: "another-attempt",
    pushAlias: "echo-request",
  });
  await assert.rejects(beginHsa2(mixed.flow));
  assert.equal(mixed.saved(), null);
});

test("Apple's first server-assigned flowid opens device verification and remains pinned through completion", async () => {
  const flowId = "apple-assigned-synthetic-flow";
  const h = bridgeHarness({ serverFlowId: flowId });
  const challenge = await beginHsa2(h.flow);
  assert.equal(challenge.type, "bridge-challenge");
  await h.flow.advance({
    type: "bridge-share",
    ...binding,
    sequence: 2,
    data: b64(unhex(fixtures.bridge.clientMessage)),
  });
  await h.flow.advance({
    type: "bridge-confirmation",
    ...binding,
    sequence: 3,
    data: b64(unhex(fixtures.bridge.confirmation)),
  });
  assert.equal(
    (
      await h.flow.advance({
        type: "bridge-validation",
        ...binding,
        sequence: 4,
        code: fixtures.bridge.plaintext,
      })
    ).type,
    "complete",
  );
  const requests = h.requests.filter((r) => /\/bridge\//.test(r.path));
  assert.notEqual(
    (requests[0].body as { sessionUUID: string }).sessionUUID,
    flowId,
  );
  assert.ok(
    requests
      .slice(1)
      .every((r) => (r.body as { sessionUUID: string }).sessionUUID === flowId),
  );
  assert.equal(h.saved().session.login.factor, "trusted-device-spake2");

  const mixed = bridgeHarness({
    serverFlowId: flowId,
    laterIdentity: flowId.toUpperCase(),
  });
  assert.equal((await beginHsa2(mixed.flow)).type, "bridge-challenge");
  await assert.rejects(
    mixed.flow.advance({
      type: "bridge-share",
      ...binding,
      sequence: 2,
      data: b64(unhex(fixtures.bridge.clientMessage)),
    }),
    (e: any) => e.code === "PROTOCOL_CHANGED",
  );
  assert.equal(mixed.saved(), null);
  assert.ok(
    !mixed.requests.some((r) => /2sv\/trust|accountLogin/.test(r.path)),
  );
});

test("cancelling during deferred Apple proof submission prevents the late response from persisting", async () => {
  const controller = new AbortController();
  let enter!: () => void;
  const fetchEntered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: (value: Response) => void;
  const deferred = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const plans: ReplyPlan[] = [
    { status: 200 },
    { body: challenge },
    () => {
      enter();
      return deferred;
    },
  ];
  const harness = scriptedHTTP(plans, controller.signal);
  let persists = 0;
  const flow = new AppleSignInFlow(
    harness.http,
    controller.signal,
    async () => {
      persists++;
    },
  );
  await flow.start(startMessage);

  const pendingProof = flow.advance(proofMessage);
  await fetchEntered;
  await assert.rejects(
    flow.advance({ type: "cancel", ...binding, sequence: 1 }),
    (error: any) => error.code === "RESTART_REQUIRED",
  );
  release(response({ status: 409, body: { authType: "hsa2" } }));
  await assert.rejects(
    pendingProof,
    (error: any) => error.code === "RESTART_REQUIRED",
  );
  assert.equal(persists, 0);
});

test("the auth socket rejects a valid message bound to another transaction before advancing the flow", async () => {
  class SetupD1 {
    generation = 0;
    version = 0;
    initialized = false;
    withSession() {
      return this;
    }
    prepare(sql: string) {
      const database = this;
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) {
          values = input;
          return statement;
        },
        async run() {
          if (sql.startsWith("INSERT OR IGNORE INTO apple_session_state"))
            database.initialized = true;
          return { success: true, meta: { changes: 1 } };
        },
        async first<T>() {
          if (sql.startsWith("SELECT version FROM apple_session_state")) {
            return (
              database.initialized && Number(values[2]) === database.generation
                ? { version: database.version }
                : null
            ) as T | null;
          }
          if (
            sql.startsWith(
              "UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'CONNECTING'",
            )
          ) {
            if (
              Number(values[5]) !== database.generation ||
              Number(values[6]) !== database.version
            )
              return null;
            database.generation++;
            database.version++;
            return {
              generation: database.generation,
              version: database.version,
            } as T;
          }
          if (
            sql.startsWith(
              "UPDATE apple_session_state SET generation = generation + 1, version = version + 1, state = 'DISCONNECTED'",
            )
          )
            return null;
          throw new Error(`Unexpected setup-fence query: ${sql}`);
        },
      };
      return statement;
    }
  }
  class FakeSocket {
    readonly listeners = new Map<string, ((event: any) => void)[]>();
    readonly sent: string[] = [];
    addEventListener(name: string, listener: (event: any) => void) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    accept() {}
    send(value: string) {
      this.sent.push(value);
      const message = JSON.parse(value);
      if (message.type === "failed") failureResolve(message);
      if (message.type === "srp-challenge") challengeResolve();
    }
    close() {
      for (const listener of this.listeners.get("close") ?? []) listener({});
    }
    message(data: string) {
      for (const listener of this.listeners.get("message") ?? [])
        listener({ data });
    }
  }

  let failureResolve!: (value: any) => void;
  const failed = new Promise<any>((resolve) => {
    failureResolve = resolve;
  });
  let challengeResolve!: () => void;
  const challengeSent = new Promise<void>((resolve) => {
    challengeResolve = resolve;
  });
  const client = new FakeSocket();
  const server = new FakeSocket();
  const NativeResponse = globalThis.Response;
  const responseDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "Response",
  );
  const pairDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "WebSocketPair",
  );
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const ResponseShim = class {
    constructor(
      body: BodyInit | null,
      init?: ResponseInit & { webSocket?: unknown },
    ) {
      if (init?.status === 101)
        return {
          status: 101,
          webSocket: init.webSocket,
          headers: new Headers(init.headers),
        };
      return new NativeResponse(body, init);
    }
  };
  const PairShim = class {
    constructor() {
      return { client, server };
    }
  };
  const appleRequests: string[] = [];
  const appleReplies: ReplyPlan[] = [{ status: 200 }, { body: challenge }];
  const fetchShim = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    appleRequests.push(url.pathname);
    const next = appleReplies.shift();
    if (!next || typeof next === "function")
      throw new Error("Unexpected Apple request in transaction-fence test.");
    return response(next);
  };
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    writable: true,
    value: ResponseShim,
  });
  Object.defineProperty(globalThis, "WebSocketPair", {
    configurable: true,
    writable: true,
    value: PairShim,
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: fetchShim,
  });
  try {
    const db = new SetupD1();
    const env = {
      DB: db as unknown as D1Database,
      APP_ORIGIN: "https://site.example.test",
      APPLE_LOGIN_ENABLED: "true",
      LIVE_APPLE_CONNECTION_APPROVED: "controlled-device-v2",
      APPLE_CRYPTO_REVIEW_APPROVED: "device-proof-v2",
      ENCRYPTION_KEYS_JSON: JSON.stringify({
        synthetic: b64(new Uint8Array(32)),
      }),
    };
    const request = new Request(
      "https://site.example.test/api/auth/apple/socket?generation=0",
      {
        method: "GET",
        headers: {
          upgrade: "websocket",
          origin: env.APP_ORIGIN,
          "sec-websocket-protocol": APPLE_AUTH_PROTOCOL,
        },
      },
    );
    const accepted = await appleAuthSocket(request, env, "synthetic-owner");
    assert.equal(accepted.status, 101);
    const hello = JSON.parse(server.sent[0]);
    assert.equal(hello.type, "hello");
    server.message(
      JSON.stringify({
        ...startMessage,
        transactionId: hello.transactionId,
        nonce: hello.nonce,
      }),
    );
    await challengeSent;
    assert.equal(appleRequests.length, 2);
    const differentTransaction = crypto.randomUUID();
    assert.notEqual(differentTransaction, hello.transactionId);
    server.message(
      JSON.stringify({
        type: "cancel",
        transactionId: differentTransaction,
        nonce: hello.nonce,
        sequence: 1,
      }),
    );
    const rejected = await failed;
    assert.equal(rejected.type, "failed");
    assert.equal(rejected.error.code, "RESTART_REQUIRED");
    assert.equal(server.sent.length, 3); // hello, SRP challenge, then the transaction-fence failure
    assert.equal(appleRequests.length, 2);
    assert.equal(db.version, 1); // only the start fence was acquired; no auth session commit ran
  } finally {
    if (responseDescriptor)
      Object.defineProperty(globalThis, "Response", responseDescriptor);
    else delete (globalThis as any).Response;
    if (pairDescriptor)
      Object.defineProperty(globalThis, "WebSocketPair", pairDescriptor);
    else delete (globalThis as any).WebSocketPair;
    if (fetchDescriptor)
      Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    else delete (globalThis as any).fetch;
  }
});

test("PCS checkpoints cap each call, prompt once, respect cooldown, and clear user-action after the first request", async () => {
  const harness = scriptedHTTP([
    { body: { isICDRSDisabled: true, isDeviceConsentedForPCS: false } },
    { body: { isDeviceConsentNotificationSent: true } },
    { body: { isICDRSDisabled: true, isDeviceConsentedForPCS: false } },
    { body: { isICDRSDisabled: true, isDeviceConsentedForPCS: true } },
    { body: { message: "Requested the device to upload cookies." } },
    { body: { isICDRSDisabled: true, isDeviceConsentedForPCS: true } },
    { body: { status: "success" } },
  ]);
  const initial = freshPcsCheckpoint(10_000);
  const firstStart = harness.requests.length;
  const first = await advancePcs(harness.http, "123456789", initial, 10_000);
  assert.equal(first.state, "DEVICE_APPROVAL_PENDING");
  assert.equal(first.checkpoint.consentRequested, true);
  assert.equal(harness.requests.length - firstStart, 2);
  await assert.rejects(
    advancePcs(harness.http, "123456789", first.checkpoint, 14_999),
    (error: any) => error.code === "RATE_LIMITED",
  );
  assert.equal(harness.requests.length, firstStart + 2);

  const promptStart = harness.requests.length;
  const afterPrompt = await advancePcs(
    harness.http,
    "123456789",
    first.checkpoint,
    15_000,
  );
  assert.equal(afterPrompt.checkpoint.consentRequested, true);
  assert.equal(harness.requests.length - promptStart, 1);

  const userActionStart = harness.requests.length;
  const uploadRequested = await advancePcs(
    harness.http,
    "123456789",
    { ...afterPrompt.checkpoint, nextAttemptAt: 0 },
    20_000,
  );
  assert.equal(uploadRequested.state, "DEVICE_APPROVAL_PENDING");
  assert.equal(uploadRequested.action, "wait-for-reminders-keys");
  assert.equal(harness.requests.length - userActionStart, 2);
  const firstPcsBody = harness.requests.find((request) =>
    request.path.endsWith("/requestPCS"),
  )?.body;
  assert.deepEqual(firstPcsBody, {
    appName: "reminders",
    derivedFromUserAction: true,
  });

  const nextPcsStart = harness.requests.length;
  const ready = await advancePcs(
    harness.http,
    "123456789",
    uploadRequested.checkpoint,
    uploadRequested.checkpoint.nextAttemptAt,
  );
  assert.equal(ready.state, "READY");
  assert.equal(harness.requests.length - nextPcsStart, 2);
  const pcsBodies = harness.requests
    .filter((request) => request.path.endsWith("/requestPCS"))
    .map((request) => request.body);
  assert.deepEqual(pcsBodies, [
    { appName: "reminders", derivedFromUserAction: true },
    { appName: "reminders", derivedFromUserAction: false },
  ]);
  const countAtExpiry = harness.requests.length;
  await assert.rejects(
    advancePcs(
      harness.http,
      "123456789",
      ready.checkpoint,
      ready.checkpoint.expiresAt,
    ),
    (error: any) => error.code === "AUTH_EXPIRED",
  );
  assert.equal(harness.requests.length, countAtExpiry);
  assert.equal(harness.remaining(), 0);
});

test("browser SRP proofs are one-use and clearing an async HSA2 decrypt invalidates its result", async () => {
  const browserSrp = new BrowserSrpProof(srp.account);
  const publicA = browserSrp.publicA();
  assert.ok(publicA.length >= 4);
  const proof = await browserSrp.prove(srp.password, challenge);
  assert.equal(unb64(proof.m1).length, 32);
  assert.equal(unb64(proof.m2).length, 32);
  assert.ok(!JSON.stringify(proof).includes(srp.password));
  assert.throws(
    () => browserSrp.publicA(),
    (error: any) => error.code === "AUTH_EXPIRED",
  );
  await assert.rejects(
    browserSrp.prove(srp.password, challenge),
    (error: any) => error.code === "AUTH_EXPIRED",
  );

  const subtle = crypto.subtle;
  const deriveDescriptor = Object.getOwnPropertyDescriptor(
    subtle,
    "deriveBits",
  );
  const deriveBits = subtle.deriveBits.bind(subtle);
  let enterDerive!: () => void;
  const deriveEntered = new Promise<void>((resolve) => {
    enterDerive = resolve;
  });
  let resumeDerive!: () => void;
  const deriveGate = new Promise<void>((resolve) => {
    resumeDerive = resolve;
  });
  try {
    Object.defineProperty(subtle, "deriveBits", {
      configurable: true,
      writable: true,
      value: async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
        enterDerive();
        await deriveGate;
        return deriveBits(...args);
      },
    });
    const cancelledSrp = new BrowserSrpProof(srp.account);
    cancelledSrp.publicA();
    const pendingProof = cancelledSrp.prove(srp.password, challenge);
    await deriveEntered;
    cancelledSrp.clear();
    resumeDerive();
    await assert.rejects(
      pendingProof,
      (error: any) => error.code === "AUTH_EXPIRED",
    );
  } finally {
    if (deriveDescriptor)
      Object.defineProperty(subtle, "deriveBits", deriveDescriptor);
    else delete (subtle as any).deriveBits;
  }

  const randomDescriptor = Object.getOwnPropertyDescriptor(
    crypto,
    "getRandomValues",
  );
  try {
    Object.defineProperty(crypto, "getRandomValues", {
      configurable: true,
      writable: true,
      value: <T extends ArrayBufferView>(array: T) => {
        const bytes = new Uint8Array(
          array.buffer,
          array.byteOffset,
          array.byteLength,
        );
        bytes.fill(0);
        bytes[bytes.length - 1] = 7;
        return array;
      },
    });
    const browserBridge = new BrowserBridgeProof();
    const share = await browserBridge.first(
      fixtures.bridge.code,
      b64(unhex(fixtures.bridge.salt)),
    );
    assert.equal(share, b64(unhex(fixtures.bridge.clientMessage)));
    const confirmation = await browserBridge.confirm(
      b64(unhex(fixtures.bridge.serverMessage)),
      b64(unhex(fixtures.bridge.serverConfirmation)),
    );
    assert.equal(confirmation, b64(unhex(fixtures.bridge.confirmation)));
    const pendingDecrypt = browserBridge.decrypt(fixtures.bridge.ciphertext);
    browserBridge.clear();
    await assert.rejects(
      pendingDecrypt,
      (error: any) => error.code === "AUTH_EXPIRED",
    );
    const cancelledBridge = new BrowserBridgeProof();
    const deriving = cancelledBridge.first(
      fixtures.bridge.code,
      b64(unhex(fixtures.bridge.salt)),
    );
    cancelledBridge.clear();
    await assert.rejects(
      deriving,
      (error: any) => error.code === "AUTH_EXPIRED",
    );
  } finally {
    if (randomDescriptor)
      Object.defineProperty(crypto, "getRandomValues", randomDescriptor);
    else delete (crypto as any).getRandomValues;
  }
});

test("server auth envelopes reject replay, mixed attempts and premature or inconsistent completion", () => {
  const hello = {
    type: "hello",
    ...binding,
    direction: "server",
    sequence: 0,
    generation: 1,
    lifetimeMs: AUTH_LIFETIME_MS,
    expiresAt: Date.now() + AUTH_LIFETIME_MS,
  };
  const seq = new AuthResponseSequence(0);
  seq.consume(hello);
  assert.throws(() => seq.consume(hello));
  assert.throws(() =>
    seq.consume({
      type: "srp-challenge",
      ...binding,
      direction: "server",
      sequence: 2,
      challenge,
    }),
  );
  assert.throws(() =>
    seq.consume({
      type: "srp-challenge",
      ...binding,
      nonce: "b".repeat(64),
      direction: "server",
      sequence: 1,
      challenge,
    }),
  );
  assert.equal(
    seq.consume({
      type: "srp-challenge",
      ...binding,
      direction: "server",
      sequence: 1,
      challenge,
    }).type,
    "srp-challenge",
  );
  assert.throws(() =>
    seq.consume({
      type: "complete",
      ...binding,
      direction: "server",
      sequence: 2,
      state: "DEVICE_APPROVAL_PENDING",
      nextAttemptAt: 0,
      expiresAt: Date.now() + 86_400_000,
    }),
  );
  const fresh = new AuthResponseSequence(0);
  assert.throws(() =>
    fresh.consume({ ...hello, type: "complete", state: "READY" }),
  );
});

for (const flags of [
  {},
  { isICDRSDisabled: false },
  { isDeviceConsentedForPCS: true },
]) {
  test(`optional ICDRS flag follows pyicloud without an unnecessary PCS request: ${JSON.stringify(flags)}`, async () => {
    const h = scriptedHTTP([{ body: flags }]);
    const result = await advancePcs(
      h.http,
      "123456789",
      freshPcsCheckpoint(1000),
      1000,
    );
    assert.equal(result.state, "READY");
    assert.equal(h.requests.length, 1);
    assert.equal(result.checkpoint.pcsAttempts, 0);
  });
}

for (const body of [
  { hsaChallengeRequired: true },
  { hsaTrustedBrowser: false },
]) {
  test(`optional PCS fields never bypass an explicit trust rejection: ${JSON.stringify(body)}`, async () => {
    const h = scriptedHTTP([{ body }]);
    await assert.rejects(
      advancePcs(h.http, "123456789", freshPcsCheckpoint(1000), 1000),
      (e: any) => e.code === "VERIFICATION_REQUIRED",
    );
    assert.equal(h.requests.length, 1);
  });
}

test("PCS HTTP 412 without verification flags is not reported as failed device trust", async () => {
  const h = scriptedHTTP([
    { body: { isICDRSDisabled: true } },
    { status: 412, body: {} },
  ]);
  await assert.rejects(
    advancePcs(h.http, "123456789", freshPcsCheckpoint(1000), 1000),
    (e: any) =>
      e.code === "PROTOCOL_CHANGED" &&
      e.message.includes("HTTP 412") &&
      e.message.includes("not establish"),
  );
  assert.equal(h.requests.length, 2);
});

test("PCS HTTP 412 with an explicit device challenge remains a verification failure", async () => {
  const h = scriptedHTTP([
    { body: { isICDRSDisabled: true } },
    { status: 412, body: { hsaChallengeRequired: true } },
  ]);
  await assert.rejects(
    advancePcs(h.http, "123456789", freshPcsCheckpoint(1000), 1000),
    (e: any) => e.code === "VERIFICATION_REQUIRED",
  );
});

for (const flags of [
  { isICDRSDisabled: true },
  { isICDRSDisabled: true, isDeviceConsentedForPCS: true },
]) {
  test(`explicit PCS requirement still requests confirmed service preparation: ${JSON.stringify(flags)}`, async () => {
    const h = scriptedHTTP([{ body: flags }, { body: { status: "success" } }]);
    const r = await advancePcs(
      h.http,
      "123456789",
      freshPcsCheckpoint(1000),
      1000,
      "notes3",
    );
    assert.equal(r.state, "READY");
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].path, "/setup/ws/1/requestPCS");
    assert.deepEqual(h.requests[1].body, {
      appName: "notes3",
      derivedFromUserAction: true,
    });
  });
}
test("required PCS does not treat an unconfirmed service response as authorized", async () => {
  const h = scriptedHTTP([
    { body: { isICDRSDisabled: true } },
    { body: { message: "Cookies not available yet on server." } },
  ]);
  const r = await advancePcs(
    h.http,
    "123456789",
    freshPcsCheckpoint(1000),
    1000,
    "photos",
  );
  assert.equal(r.state, "DEVICE_APPROVAL_PENDING");
  assert.equal(r.checkpoint.nextAttemptAt, 6000);
});
test("authorization rejects invalid flags and reports service protocol errors without secrets", async () => {
  const h = scriptedHTTP([{ body: { isICDRSDisabled: "false" } }]);
  await assert.rejects(
    advancePcs(h.http, "123456789", freshPcsCheckpoint(1000), 1000),
    (e: any) => e.code === "PROTOCOL_CHANGED",
  );
  const bad = scriptedHTTP([
    { body: { isICDRSDisabled: true } },
    { body: { status: "private-sentinel", message: "private-sentinel" } },
  ]);
  await assert.rejects(
    advancePcs(bad.http, "123456789", freshPcsCheckpoint(1000), 1000, "notes3"),
    (e: any) =>
      e.code === "PROTOCOL_CHANGED" &&
      e.message.includes("requestPCS (notes3)") &&
      !e.message.includes("private-sentinel"),
  );
});
