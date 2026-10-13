// Observed pyicloud protocol at the pinned MIT revision. Only Reminders setup
// services are exposed here. Raw account responses and headers stay server-side.
import { z } from "zod";
import { AppError } from "../../errors.ts";
import {
  AppleHTTP,
  appleHome,
  type AppleRegion,
  validatedAppleURL,
  APPLE_USER_AGENT,
  appleWebHeaders,
  APPLE_SESSION_RESPONSE_HEADERS,
} from "../../transport/apple-http.ts";
import { CookieJar, type Cookie } from "../../transport/cookie-jar.ts";
import { requireNoAppleRejection } from "./policy.ts";

export const AUTH_ROOT = "https://idmsa.apple.com/appleauth/auth";
export const SETUP_ROOT = "https://setup.icloud.com/setup/ws/1";
export const APPLE_WIDGET =
  "d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d";
export { APPLE_USER_AGENT } from "../../transport/apple-http.ts";
export const CLIENT_BUILD = "2534Project66";
export const CLIENT_MASTERING = "2534B22";
const responseHeaders = APPLE_SESSION_RESPONSE_HEADERS;
const token = z
  .string()
  .max(16_384)
  .refine((value) => !/[\r\n\x00]/.test(value));
const CookieSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
    value: z
      .string()
      .max(8192)
      .refine((value) => !/[\x00-\x20\x7f;,]/.test(value)),
    domain: z
      .string()
      .max(253)
      .regex(/^(?:[a-z0-9-]+\.)*(?:apple\.com|icloud\.com(?:\.cn)?)$/),
    hostOnly: z.boolean(),
    path: z.string().max(4096).startsWith("/"),
    secure: z.boolean(),
    expiresAt: z.number().finite().nullable(),
  })
  .strict();
export const AuthSnapshotSchema = z
  .object({
    region: z.enum(["international", "cn"]).optional(),
    clientId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9-]+$/),
    headers: z.record(z.enum(responseHeaders), token),
    cookies: z.array(CookieSchema).max(200),
  })
  .strict();
export type AuthSnapshot = z.infer<typeof AuthSnapshotSchema>;
type AuthPath =
  | ""
  | "/signin/init"
  | "/signin/complete?isRememberMeEnabled=true"
  | "/2sv/trust"
  | "/verify/phone"
  | "/verify/phone/securitycode"
  | "/verify/trusteddevice/securitycode"
  | "/bridge/step/0"
  | "/bridge/step/2"
  | "/bridge/step/4"
  | "/bridge/step/6"
  | "/bridge/code/validate";
type SetupPath =
  | "/accountLogin"
  | "/validate"
  | "/requestWebAccessState"
  | "/enableDeviceConsentForPCS"
  | "/requestPCS";
export interface AppleReply {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
  retryAfterMs: number;
}
export class AppleAuthenticationError extends AppError {
  readonly confirmed: boolean;
  constructor(confirmed: boolean) {
    super(
      "REAUTH_REQUIRED",
      confirmed
        ? "Apple rejected the saved authentication tokens. Sign in and verify your device again."
        : "Apple web authentication needs a saved-token check.",
      409,
    );
    this.confirmed = confirmed;
  }
}
export class AppleRetryError extends AppError {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(
      "RATE_LIMITED",
      "Apple is limiting requests. Wait until the indicated retry time.",
      429,
      true,
    );
    this.retryAfterMs = retryAfterMs;
  }
}
export function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class AppleAuthHTTP {
  readonly http: AppleHTTP;
  readonly region: AppleRegion;
  get setupRoot() {
    return `https://setup.icloud.com${this.region === "cn" ? ".cn" : ""}/setup/ws/1`;
  }
  readonly clientId: string;
  private data: Partial<Record<(typeof responseHeaders)[number], string>> = {};
  private calls = 0;
  readonly signal?: AbortSignal;
  constructor(
    http = new AppleHTTP(),
    snapshot?: AuthSnapshot,
    signal?: AbortSignal,
    region: AppleRegion = "international",
  ) {
    this.region = snapshot?.region ?? region;
    this.http = http;
    this.signal = signal;
    if (snapshot) {
      const parsed = AuthSnapshotSchema.safeParse(snapshot);
      if (!parsed.success)
        throw new AppError(
          "REAUTH_REQUIRED",
          "The saved Apple session cannot be restored. Reconnect through setup.",
          409,
        );
      this.clientId = parsed.data.clientId;
      this.data = parsed.data.headers;
    } else this.clientId = `auth-${crypto.randomUUID()}`;
  }
  static restore(
    value: unknown,
    send: typeof fetch = fetch,
    signal?: AbortSignal,
  ) {
    const parsed = AuthSnapshotSchema.safeParse(value);
    if (!parsed.success)
      throw new AppError(
        "REAUTH_REQUIRED",
        "The saved Apple session is invalid. Reconnect through setup.",
        409,
      );
    return new AppleAuthHTTP(
      new AppleHTTP(
        new CookieJar(parsed.data.cookies as Cookie[]),
        send,
        signal,
      ),
      parsed.data,
      signal,
    );
  }
  snapshot(): AuthSnapshot {
    return {
      region: this.region,
      clientId: this.clientId,
      headers: { ...this.data },
      cookies: this.http.jar.snapshot(),
    };
  }
  value(name: (typeof responseHeaders)[number]) {
    return this.data[name];
  }
  authHeaders(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = {
      "User-Agent": APPLE_USER_AGENT,
      Accept: "application/json, text/javascript",
      "Content-Type": "application/json",
      "X-Apple-OAuth-Client-Id": APPLE_WIDGET,
      "X-Apple-OAuth-Client-Type": "firstPartyAuth",
      "X-Apple-OAuth-Redirect-URI": appleHome(this.region),
      "X-Apple-OAuth-Require-Grant-Code": "true",
      "X-Apple-OAuth-Response-Mode": "web_message",
      "X-Apple-OAuth-Response-Type": "code",
      "X-Apple-OAuth-State": this.clientId,
      "X-Apple-Frame-Id": this.clientId,
      "X-Apple-Widget-Key": APPLE_WIDGET,
      Referer: "https://idmsa.apple.com",
      "X-Apple-FD-Client-Info": JSON.stringify({
        U: APPLE_USER_AGENT,
        L: "en-US",
        Z: "GMT+00:00",
        V: "1.1",
        F: "",
      }),
    };
    for (const name of [
      "scnt",
      "X-Apple-ID-Session-Id",
      "X-Apple-Auth-Attributes",
    ] as const)
      if (this.data[name]) headers[name] = this.data[name]!;
    return { ...headers, ...extra };
  }
  async bootstrap() {
    const url = new URL(`${AUTH_ROOT}/authorize/signin`);
    url.search = new URLSearchParams({
      frame_id: this.clientId,
      iframeid: this.clientId,
      state: this.clientId,
      skVersion: "7",
      client_id: APPLE_WIDGET,
      response_type: "code",
      redirect_uri: appleHome(this.region),
      response_mode: "web_message",
      authVersion: "latest",
    }).toString();
    const reply = await this.send(
      url.href,
      "GET",
      undefined,
      this.authHeaders({ Accept: "text/html" }),
    );
    this.expect(reply, [200]);
  }
  auth(
    path: AuthPath,
    method: "GET" | "POST" | "PUT" = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return this.send(AUTH_ROOT + path, method, body, this.authHeaders(extra));
  }
  setup(path: SetupPath, body?: unknown, dsid?: string) {
    const url = new URL(this.setupRoot + path);
    url.search = new URLSearchParams({
      clientBuildNumber: CLIENT_BUILD,
      clientMasteringNumber: CLIENT_MASTERING,
      clientId: this.clientId,
      ...(dsid ? { dsid } : {}),
    }).toString();
    return this.send(url.href, "POST", body, appleWebHeaders(this.region));
  }
  private async send(
    url: string,
    method: "GET" | "POST" | "PUT",
    body: unknown,
    headers: Record<string, string>,
  ): Promise<AppleReply> {
    if (++this.calls > 32)
      throw new AppError(
        "RATE_LIMITED",
        "The Apple request budget was exhausted. Restart setup later.",
        429,
      );
    const response = await this.http.request(url, {
      method,
      headers,
      signal: this.signal,
      // requests (pyicloud) returns a Location-less 302 to the caller; its
      // accountLogin parser then validates the JSON account/trust result.
      allowAccountLogin302Body:
        new URL(url).pathname === "/setup/ws/1/accountLogin",
      maxRedirects: method === "GET" ? 8 : 3,
      stage: new URL(url).pathname.endsWith("/2sv/trust")
        ? "browser-trust"
        : new URL(url).pathname.endsWith("/accountLogin")
          ? "account-login"
          : new URL(url).pathname.endsWith("/validate")
            ? "session-validation"
            : /\/(?:bridge|verify)\//.test(new URL(url).pathname)
              ? "device-verification"
              : "authentication",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const name of responseHeaders) {
      const value = response.headers.get(name);
      if (value !== null) {
        if (!token.safeParse(value).success)
          throw new AppError(
            "PROTOCOL_CHANGED",
            "Apple returned invalid session headers.",
          );
        this.data[name] = value;
      }
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes);
    } catch {
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an invalid response encoding.",
      );
    }
    let parsed: unknown = null;
    if (
      text.trim().startsWith("{") ||
      response.headers.get("content-type")?.includes("json")
    ) {
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple returned malformed JSON.",
        );
      }
    }
    const delay = response.headers.get("retry-after");
    let retryAfterMs = 30_000;
    if (delay) {
      const seconds = Number(delay);
      const time = Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(delay) - Date.now();
      if (Number.isFinite(time))
        retryAfterMs = Math.max(
          5000,
          Math.min(8_640_000_000_000_000 - Date.now(), time),
        );
    }
    const reply = {
      status: response.status,
      body: object(parsed),
      text,
      retryAfterMs,
    };
    if (
      new URL(url).pathname === "/setup/ws/1/accountLogin" &&
      response.status === 302 &&
      !reply.body
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple account-login: HTTP 302 without Location did not contain a JSON account result. No session was saved.",
      );
    if (response.status === 429 || (response.status >= 500 && delay))
      throw new AppleRetryError(retryAfterMs);
    const errors = reply.body?.serviceErrors;
    if (
      Array.isArray(errors) &&
      errors.some((error) => object(error)?.code === -20209)
    )
      throw new AppError(
        "UNSUPPORTED_AUTH",
        "Apple has locked this account. Resolve the account condition through Apple before reconnecting.",
        422,
      );
    return reply;
  }
  expect(reply: AppleReply, allowed: number[], stage = "authentication") {
    if (allowed.includes(reply.status)) return;
    if ([401, 403, 421, 450].includes(reply.status))
      throw new AppError(
        "REAUTH_REQUIRED",
        `Apple ${stage}: HTTP ${reply.status}; authentication rejected.`,
        409,
      );
    if (
      reply.status === 412 &&
      /^(requestPCS|requestWebAccessState|enableDeviceConsentForPCS)/.test(
        stage,
      ) &&
      reply.body?.hsaChallengeRequired !== true &&
      reply.body?.hsaTrustedBrowser !== false
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        `Apple ${stage} (${this.region}): HTTP 412; hsaChallengeRequired=${safeFlag(reply.body?.hsaChallengeRequired)}; hsaTrustedBrowser=${safeFlag(reply.body?.hsaTrustedBrowser)}. Data-access precondition rejected without an explicit device-verification signal; this response alone does not establish that sign-in is required. Saved credentials preserved; request was not replayed.`,
        422,
      );
    if (reply.status === 412)
      throw new AppError(
        "VERIFICATION_REQUIRED",
        `Apple ${stage}: HTTP 412; hsaChallengeRequired=${safeFlag(reply.body?.hsaChallengeRequired)}; hsaTrustedBrowser=${safeFlag(reply.body?.hsaTrustedBrowser)}. Device verification required.`,
        409,
      );
    throw new AppError(
      reply.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "PROTOCOL_CHANGED",
      `Apple ${stage}: unsupported HTTP ${reply.status} response.`,
      reply.status >= 500 ? 503 : 422,
      reply.status >= 500,
    );
  }
  async validateSession(expectedAccount: string) {
    const reply = await this.setup("/validate", null);
    return this.acceptedAccount(reply, expectedAccount, false);
  }
  private acceptedAccount(
    reply: AppleReply,
    expectedAccount?: string,
    exchange = true,
  ) {
    const body = reply.body;
    if (reply.status >= 500)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Apple session validation is temporarily unavailable.",
        503,
        true,
      );
    if (body?.termsUpdateNeeded === true)
      throw new AppError(
        "TERMS_ACTION_REQUIRED",
        "Review Apple's updated terms in the official iCloud interface before continuing.",
        409,
      );
    if (reply.status === 412 || body?.hsaChallengeRequired === true)
      throw new AppError(
        "VERIFICATION_REQUIRED",
        `Apple ${exchange ? "account-login" : "session-validation"} (${this.region}): HTTP ${reply.status}; hsaChallengeRequired=${safeFlag(body?.hsaChallengeRequired)}; hsaTrustedBrowser=${safeFlag(body?.hsaTrustedBrowser)}. Fresh device verification required; saved connection preserved.`,
        409,
      );
    if ([401, 421, 450].includes(reply.status))
      throw new AppleAuthenticationError(exchange);
    // A resource permission failure is not evidence that saved tokens are revoked.
    if (reply.status === 403)
      throw new AppError(
        "FORBIDDEN",
        "Apple denied this account setup request. Resolve access through Apple's official interface.",
        403,
      );
    this.expect(reply, exchange ? [200, 302] : [200]);
    if (!body)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted the session validation result.",
      );
    const explicitRejection =
      body.authenticated === false ||
      body.valid === false ||
      [
        "AUTHENTICATION_REQUIRED",
        "NOT_AUTHENTICATED",
        "INVALID_AUTH_TOKEN",
        "AUTHENTICATION_FAILED",
      ].includes(String(body.serverErrorCode).toUpperCase());
    if (explicitRejection) throw new AppleAuthenticationError(exchange);
    try {
      requireNoAppleRejection(
        body,
        exchange ? "account-login" : "session-validation",
      );
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== "VERIFICATION_REQUIRED"
      )
        throw error;
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an unsupported session rejection. The saved connection was preserved.",
      );
    }
    if (body.hsaTrustedBrowser === false)
      throw new AppError(
        "VERIFICATION_REQUIRED",
        "Apple no longer accepts this browser's trusted-session state. Verify your device again.",
        409,
      );
    if (
      body.hsaTrustedBrowser !== true ||
      (body.hsaChallengeRequired !== undefined &&
        typeof body.hsaChallengeRequired !== "boolean") ||
      (body.termsUpdateNeeded !== undefined &&
        typeof body.termsUpdateNeeded !== "boolean")
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple did not return a supported trusted-session state.",
      );
    const dsInfo = object(body.dsInfo);
    const dsid = dsInfo?.dsid;
    const rawURL = object(object(body.webservices)?.ckdatabasews)?.url;
    if (
      !(
        (typeof dsid === "string" && /^\d{1,32}$/.test(dsid)) ||
        (typeof dsid === "number" && Number.isSafeInteger(dsid) && dsid > 0)
      ) ||
      typeof rawURL !== "string"
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple did not return the required Reminders account services.",
      );
    if (expectedAccount !== undefined && String(dsid) !== expectedAccount)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned a different account. No reminder access or account replacement was allowed.",
      );
    let root: URL;
    try {
      root = new URL(rawURL);
    } catch {
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an invalid Reminders service.",
      );
    }
    if (
      (root.pathname !== "/" && root.pathname !== "") ||
      root.search ||
      root.hash ||
      root.username ||
      root.password
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an unsupported Reminders service path.",
      );
    let cloudKitURL: string;
    try {
      cloudKitURL = validatedAppleURL(
        `${root.origin}/database/1/com.apple.reminders/production/private`,
        true,
      ).href;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned a Reminders service outside the supported allowlist.",
      );
    }
    return {
      services: this.services(body),
      dsid: String(dsid),
      cloudKitURL,
      clientId: this.clientId,
      clientBuildNumber: CLIENT_BUILD,
      clientMasteringNumber: CLIENT_MASTERING,
    };
  }
  private services(body: Record<string, unknown> | null) {
    const services: Partial<
      Record<"ckdatabasews" | "drivews" | "docws" | "fmip", string>
    > = {};
    const ws = object(body?.webservices);
    for (const key of ["ckdatabasews", "drivews", "docws", "fmip"] as const) {
      const value =
        object(ws?.[key])?.url ??
        (key === "fmip" ? object(ws?.findme)?.url : undefined);
      if (typeof value === "string") {
        try {
          const url = new URL(value);
          if (url.pathname !== "/" || url.search || url.hash)
            throw new AppError("PROTOCOL_CHANGED", "Unsupported service root.");
          // Validate each service independently, including services not currently enabled.
          const pattern =
            key === "ckdatabasews"
              ? /^p\d{1,3}-ckdatabasews\.icloud\.com(?:\.cn)?$/
              : key === "drivews"
                ? /^p\d{1,3}-drivews\.icloud\.com(?:\.cn)?$/
                : key === "docws"
                  ? /^p\d{1,3}-docws\.icloud\.com(?:\.cn)?$/
                  : /^(?:p\d{1,3}-)?fmipweb\.icloud\.com(?:\.cn)?$/;
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.port ||
            !pattern.test(url.hostname)
          )
            throw new AppError(
              "PROTOCOL_CHANGED",
              "Unsupported Apple service host.",
            );
          services[key] = url.origin;
        } catch (error) {
          // Reject unsupported optional roots for that service without losing a
          // valid account/CloudKit login. Requests never use the rejected root.
          if (key === "ckdatabasews") throw error;
        }
      }
    }
    return services;
  }
  async accountLogin(expectedAccount?: string) {
    const token = this.value("X-Apple-Session-Token");
    if (!token)
      throw new AppError(
        "REAUTH_REQUIRED",
        "Apple did not establish a usable session token. Restart sign-in.",
        409,
      );
    const reply = await this.setup("/accountLogin", {
      accountCountryCode: this.value("X-Apple-ID-Account-Country"),
      dsWebAuthToken: token,
      extended_login: true,
      trustToken: this.value("X-Apple-TwoSV-Trust-Token") ?? "",
    });
    if (expectedAccount !== undefined)
      return this.acceptedAccount(reply, expectedAccount);
    this.expect(reply, [200, 302]);
    const body = reply.body;
    if (body?.termsUpdateNeeded === true)
      throw new AppError(
        "TERMS_ACTION_REQUIRED",
        "Review Apple's updated terms in the official iCloud interface before reconnecting.",
        409,
      );
    requireNoAppleRejection(body, "account-login");
    if (body?.hsaChallengeRequired === true || body?.hsaTrustedBrowser !== true)
      throw new AppError(
        "VERIFICATION_REQUIRED",
        `Apple account-login: trusted session not confirmed (HTTP ${reply.status}; hsaTrustedBrowser=${safeFlag(body?.hsaTrustedBrowser)}; hsaChallengeRequired=${safeFlag(body?.hsaChallengeRequired)}; dsInfo=${!!object(body?.dsInfo)}; webservices=${!!object(body?.webservices)}; domainToUse=${safeRegion(body?.domainToUse)}). No session was saved.`,
        409,
      );
    const dsInfo = object(body?.dsInfo);
    const dsid = dsInfo?.dsid;
    const rawURL = object(object(body?.webservices)?.ckdatabasews)?.url;
    if (
      !(
        (typeof dsid === "string" && /^\d{1,32}$/.test(dsid)) ||
        (typeof dsid === "number" && Number.isSafeInteger(dsid) && dsid > 0)
      ) ||
      typeof rawURL !== "string"
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple did not return the required Reminders account services.",
      );
    let root: URL;
    try {
      root = new URL(rawURL);
    } catch {
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an invalid Reminders service.",
      );
    }
    if (
      (root.pathname !== "/" && root.pathname !== "") ||
      root.search ||
      root.hash ||
      root.username ||
      root.password
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an unsupported Reminders service path.",
      );
    const cloudKitURL = validatedAppleURL(
      `${root.origin}/database/1/com.apple.reminders/production/private`,
      true,
    ).href;
    return {
      services: this.services(body),
      dsid: String(dsid),
      cloudKitURL,
      clientId: this.clientId,
      clientBuildNumber: CLIENT_BUILD,
      clientMasteringNumber: CLIENT_MASTERING,
    };
  }
}

// Diagnostic values are closed sets: never echo Apple body strings, IDs or tokens.
function safeFlag(value: unknown): string {
  return value === true
    ? "true"
    : value === false
      ? "false"
      : value === undefined
        ? "missing"
        : "invalid";
}
function safeRegion(value: unknown): string {
  return value === "icloud.com.cn" || value === "icloud.com"
    ? value
    : value === undefined
      ? "missing"
      : "other";
}
