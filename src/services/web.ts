import {
  AppleSessionRepository,
  type AppleSession,
} from "../persistence/apple-sessions.ts";
import { AppleAuthHTTP } from "../auth/apple/http.ts";
import {
  AppleSessionRenewal,
  appleRequestBudget,
  appleSuccess,
  renewalCheckpoint,
} from "../auth/apple/session-renewal.ts";
import {
  advancePcs,
  freshPcsCheckpoint,
  webAccessRequiresPcs,
} from "../auth/apple/pcs.ts";
import { AppError, UpstreamRateLimitedError } from "../errors.ts";
import { appleWebHeaders } from "../transport/apple-http.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { requireAppleEnabled } from "../auth/gates.ts";
export type PcsService = "notes3" | "photos" | "iclouddrive";
// Retry preparation only; the service callback (including writes) is never
// replayed by this queue. D1 leases still coordinate separate Worker isolates.
export async function prepareWebRead<T>(
  prepare: () => Promise<T>,
  deadline: number,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
) {
  const until = Math.min(deadline - 18_000, Date.now() + 12_000);
  for (let attempt = 0; ; attempt++) {
    try {
      return await prepare();
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== "CONFLICT" ||
        !error.retryable ||
        attempt >= 12 ||
        Date.now() + 1000 > until
      )
        throw error;
      await wait(1000);
    }
  }
}
// pyicloud treats FMIP 450 as full sign-in, not a saved-token exchange.
export class FindMySignInRequired extends AppError {
  constructor(diagnostic: string) {
    super(
      "REAUTH_REQUIRED",
      diagnostic +
        " Find My rejected this web session. If it was just verified, do not repeat sign-in: HTTP 450 alone cannot identify the cause; inspect cookieContext and responseFormat. App-specific passwords cannot authenticate Find My. Other iCloud credentials were preserved; no token exchange or automatic replay was performed.",
      409,
    );
  }
}
export async function webOperation<T>(
  env: RuntimeEnv,
  owner: string,
  service: PcsService | "fmip",
  run: (client: WebClient) => Promise<T>,
  approve = false,
  replaySafe = true,
) {
  requireAppleEnabled(env);
  const repo = new AppleSessionRepository(env, owner);
  const initial = await repo.load();
  const fmipRecovery = initial.session.renewal?.findMyRecovery;
  if (
    service === "fmip" &&
    fmipRecovery &&
    ((fmipRecovery.nextRetryAt === null &&
      fmipRecovery.message.includes("cookieContext=")) ||
      (fmipRecovery.nextRetryAt !== null &&
        Date.now() < fmipRecovery.nextRetryAt))
  )
    throw new AppError(
      fmipRecovery.code,
      fmipRecovery.message +
        (fmipRecovery.nextRetryAt === null
          ? " Find My remains blocked for this session; no Apple request made on this attempt. Inspect the diagnostic before repeating sign-in."
          : " Cached Find My recovery failure; no Apple request made on this attempt. Wait before retrying."),
      409,
    );
  const renewal = new AppleSessionRenewal(env, repo);
  const budget = appleRequestBudget();
  for (let attempt = 0; attempt < 2; attempt++) {
    const { saved, fence } = await prepareWebRead(async () => {
      const saved = await renewal.ensure(
        initial.fence.generation,
        budget,
        service === "fmip" &&
          !initial.session.connection.services?.fmip &&
          attempt === 0,
      );
      if (budget.deadline <= Date.now())
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          "Apple request deadline reached. Retry later.",
          503,
          true,
        );
      const fence = await repo.claimRenewal(
        saved.fence.generation,
        saved.fence.version,
      );
      return { saved, fence };
    }, budget.deadline);
    const http = AppleAuthHTTP.restore(
      saved.session.auth,
      fetch,
      AbortSignal.timeout(Math.min(25000, budget.deadline - Date.now())),
    );
    let session = saved.session;
    try {
      const state =
        service === "fmip" ? undefined : session.servicePcs?.[service];
      if (approve && service !== "fmip") {
        const checkpoint =
          state && state.expiresAt > Date.now() ? state : freshPcsCheckpoint();
        const result = await advancePcs(
          http,
          session.connection.dsid,
          checkpoint,
          Date.now(),
          service,
        );
        session = {
          ...session,
          servicePcs: {
            ...session.servicePcs,
            [service]: {
              ...result.checkpoint,
              ready: result.state === "READY",
            },
          },
          auth: http.snapshot(),
        };
        await repo.commitResume(
          fence,
          session,
          saved.state,
          saved.action ?? undefined,
        );
        return {
          state: result.state,
          ...(result.state === "DEVICE_APPROVAL_PENDING"
            ? { action: result.action }
            : {}),
          nextAttemptAt: result.checkpoint.nextAttemptAt,
        } as T;
      }
      if (service !== "fmip" && !state?.ready) {
        const access = await http.setup(
          "/requestWebAccessState",
          undefined,
          session.connection.dsid,
        );
        http.expect(access, [200], `requestWebAccessState (${service})`);
        if (webAccessRequiresPcs(access.body))
          throw new AppError(
            "DEVICE_APPROVAL_PENDING",
            `Apple requires PCS preparation for ${service}; complete it in /admin. No device-consent notification or PCS request was sent by this read.`,
            409,
          );
        session = {
          ...session,
          servicePcs: {
            ...session.servicePcs,
            [service]: { ...freshPcsCheckpoint(), ready: true },
          },
        };
      }
      const result = await run(
        new WebClient(http, session, saved.fence.generation),
      );
      await repo.commitResume(
        fence,
        appleSuccess({ ...session, auth: http.snapshot() }),
        saved.state,
        saved.action ?? undefined,
      );
      return result;
    } catch (e) {
      if (
        e instanceof AppError &&
        e.code === "REAUTH_REQUIRED" &&
        !(e instanceof FindMySignInRequired) &&
        replaySafe &&
        attempt === 0 &&
        !budget.recoveryUsed &&
        env.APPLE_SESSION_RENEWAL_ENABLED !== "false"
      ) {
        await repo.releaseResume(fence);
        await renewal.ensure(
          initial.fence.generation,
          budget,
          true,
          service === "fmip",
        );
        if (approve)
          throw new AppError(
            "RESTART_REQUIRED",
            "Apple session recovered. Check PCS approval again; the consent request was not replayed.",
            409,
          );
        continue;
      }
      if (
        e instanceof AppError &&
        e.code === "REAUTH_REQUIRED" &&
        service === "fmip"
      ) {
        await repo.commitResume(
          fence,
          {
            ...saved.session,
            renewal: {
              ...(saved.session.renewal ?? renewalCheckpoint()),
              findMyRecovery: {
                nextRetryAt:
                  e instanceof FindMySignInRequired
                    ? null
                    : Date.now() + 30_000,
                code: e.code,
                message: e.message.slice(0, 2000),
              },
            },
          },
          saved.state,
          saved.action ?? undefined,
        );
      }
      if (
        e instanceof AppError &&
        e.code === "REAUTH_REQUIRED" &&
        service !== "fmip" &&
        env.APPLE_SESSION_RENEWAL_ENABLED !== "false"
      ) {
        const metadata = session.renewal ?? renewalCheckpoint();
        const failures = Math.min(8, metadata.failures + 1);
        await repo.commitResume(
          fence,
          {
            ...session,
            auth: { ...session.auth, cookies: http.snapshot().cookies },
            renewal: {
              ...metadata,
              failures,
              requiredAction: "retry",
              lastErrorCode: "UPSTREAM_UNAVAILABLE",
              nextRetryAt:
                Date.now() + Math.min(3600000, 30000 * 2 ** (failures - 1)),
            },
          },
          saved.state,
          saved.action ?? undefined,
        );
      }
      if (
        e instanceof AppError &&
        e.code === "DEVICE_APPROVAL_PENDING" &&
        service !== "fmip" &&
        session.servicePcs?.[service]?.ready
      ) {
        session = {
          ...session,
          servicePcs: {
            ...session.servicePcs,
            [service]: { ...freshPcsCheckpoint(), ready: false },
          },
          auth: http.snapshot(),
        };
        await repo.commitResume(
          fence,
          session,
          saved.state,
          saved.action ?? undefined,
        );
      }
      if (
        service === "fmip" &&
        e instanceof AppError &&
        e.code === "REAUTH_REQUIRED" &&
        !(e instanceof FindMySignInRequired)
      )
        throw new AppError(
          "REAUTH_REQUIRED",
          e.message +
            (budget.recoveryUsed
              ? " Find My still rejected the service session after one saved-token exchange. No further automatic retry; other service credentials were not removed."
              : " Find My session rejected; no automatic replay was performed. This does not establish that other iCloud services are disconnected."),
          409,
        );
      throw e;
    } finally {
      await repo.releaseResume(fence);
    }
  }
  throw new AppError(
    "REAUTH_REQUIRED",
    "Apple rejected the service after bounded session recovery. Reconnect in /admin.",
    409,
  );
}
export class WebClient {
  constructor(
    readonly auth: AppleAuthHTTP,
    readonly session: AppleSession,
    readonly generation: number = 0,
  ) {}
  root(service: "ckdatabasews" | "drivews" | "docws" | "fmip") {
    const value =
      this.session.connection.services?.[service] ??
      (service === "ckdatabasews"
        ? new URL(this.session.connection.cloudKitURL).origin
        : undefined);
    if (!value)
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        `Apple service discovery (${this.auth.region}): no supported ${service} endpoint in the saved account map; available services=${
          Object.keys(this.session.connection.services ?? {})
            .filter((key) =>
              ["ckdatabasews", "drivews", "docws", "fmip"].includes(key),
            )
            .join(",") || "none"
        }. No service request was sent.`,
        409,
      );
    return value;
  }
  params() {
    const c = this.session.connection;
    return new URLSearchParams({
      dsid: c.dsid,
      clientId: c.clientId,
      clientBuildNumber: c.clientBuildNumber,
      clientMasteringNumber: c.clientMasteringNumber,
      remapEnums: "true",
      getCurrentSyncToken: "true",
    });
  }
  async request(
    service: "ckdatabasews" | "drivews" | "docws" | "fmip",
    path: string,
    payload?: unknown,
  ) {
    const url = new URL(path, this.root(service));
    for (const [k, v] of this.params()) url.searchParams.set(k, v);
    // Capture cookie eligibility before the response can delete any cookie.
    // Boolean presence only: values, account identifiers and token contents stay private.
    const cookieNames = new Set(
      (service === "fmip" ? this.auth.http.jar.header(url) : "")
        .split("; ")
        .map((part) => part.split("=")[0]),
    );
    const r = await this.auth.http.request(url.href, {
      discovered: true,
      headers: appleWebHeaders(this.auth.region),
      ...(service === "ckdatabasews" && url.pathname.endsWith("/records/query")
        ? { timeoutMs: 16_000 }
        : {}),
      method: payload === undefined ? "GET" : "POST",
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    // Inspect only known flags, never return Apple's raw body, cookies or tokens.
    let fmipBody: any;
    if (service === "fmip") {
      try {
        fmipBody = JSON.parse(new TextDecoder().decode(r.bytes));
      } catch {
        // Non-JSON auth errors still carry an actionable HTTP status.
      }
      const cookieContext = JSON.stringify({
        webAuthToken: cookieNames.has("X-APPLE-WEBAUTH-TOKEN"),
        webAuthUser: cookieNames.has("X-APPLE-WEBAUTH-USER"),
        webAuthValidate: cookieNames.has("X-APPLE-WEBAUTH-VALIDATE"),
        webSessionToken: cookieNames.has("X-APPLE-DS-WEB-SESSION-TOKEN"),
        trustCookie: [...cookieNames].some((name) =>
          name.startsWith("X-APPLE-WEBAUTH-HSA-TRUST-"),
        ),
      });
      const responseFormat =
        fmipBody && typeof fmipBody === "object"
          ? "json"
          : r.bytes.length === 0
            ? "empty"
            : r.headers.get("content-type")?.includes("html")
              ? "html"
              : "other";
      const diagnostic = `Apple fmip ${url.pathname} (${this.auth.region}; host=${url.hostname}): HTTP ${r.status}; statusCode=${["200", "203", "401", "403", "421", "450"].includes(String(fmipBody?.statusCode)) ? fmipBody.statusCode : "missing-or-unrecognized"}; termsUpdateNeeded=${fmipBody?.termsUpdateNeeded === true ? "true" : fmipBody?.termsUpdateNeeded === false ? "false" : "missing"}; cookieContext=${cookieContext}; responseFormat=${responseFormat}.`;
      if (fmipBody?.termsUpdateNeeded === true)
        throw new AppError(
          "TERMS_ACTION_REQUIRED",
          diagnostic +
            " Review updated terms at the official iCloud website before checking Find My again. No terms were automatically accepted.",
          409,
        );
      if (r.status === 450 || String(fmipBody?.statusCode) === "450")
        throw new FindMySignInRequired(diagnostic);
    }
    if ([401, 421, 450].includes(r.status))
      throw new AppError(
        "REAUTH_REQUIRED",
        `Apple ${service} ${url.pathname} (${this.auth.region}; host=${url.hostname}): HTTP ${r.status}; service session rejected.`,
        409,
      );
    if (r.status === 429)
      throw new UpstreamRateLimitedError(
        retrySeconds(r.headers.get("retry-after")),
      );
    // Gate transport errors before parsing: Apple often sends HTML on outages.
    if (r.status >= 500)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Apple service is temporarily unavailable. Retry later.",
        503,
        true,
      );
    let body: any;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(r.bytes),
      );
    } catch {
      if (r.status === 403)
        throw new AppError(
          "FORBIDDEN",
          "Apple denied service access. Check iCloud web access in account settings.",
          403,
        );
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an unsupported response.",
      );
    }
    if (service === "fmip") {
      const status = String(body?.statusCode ?? "");
      if (["401", "421", "450"].includes(status))
        throw new AppError(
          "REAUTH_REQUIRED",
          `Apple fmip ${url.pathname} (${this.auth.region}; host=${url.hostname}): HTTP ${r.status}; statusCode=${status}; service session rejected.`,
          409,
        );
      if (status === "403")
        throw new AppError(
          "FORBIDDEN",
          "Find My denied this account or device access. Check Family Sharing and Find My permissions.",
          403,
        );
      if (status && !["200", "203"].includes(status))
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Find My returned an unsupported status. Check project updates.",
        );
    }
    const code = String(body?.serverErrorCode ?? "");
    if (
      [
        "PCS_REQUIRED",
        "DEVICE_CONSENT_REQUIRED",
        "WEB_ACCESS_DISABLED",
      ].includes(code)
    )
      throw new AppError(
        "DEVICE_APPROVAL_PENDING",
        "Reauthorize this service in /admin.",
        409,
      );
    if (
      r.status === 403 ||
      ["ACCESS_DENIED", "PERMISSION_FAILURE"].includes(code)
    )
      throw new AppError(
        "FORBIDDEN",
        "Apple denied service access. Check iCloud web access in account settings.",
        403,
      );
    if (code) throw serviceError(code);
    if (r.status !== 200)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple rejected the supported service protocol. Check project updates.",
      );
    return body;
  }
  async ck(
    service: "notes" | "photos",
    operation:
      | "records/query"
      | "records/lookup"
      | "changes/zone"
      | "zones/list",
    payload: unknown,
  ) {
    const body = await this.request(
      "ckdatabasews",
      `/database/1/${service === "photos" ? "com.apple.photos.cloud" : "com.apple.notes"}/production/private/${operation}`,
      payload,
    );
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an invalid CloudKit envelope.",
      );
    if (
      (body.zones !== undefined && !Array.isArray(body.zones)) ||
      (body.records !== undefined && !Array.isArray(body.records))
    )
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned invalid CloudKit records or zones.",
      );
    for (const zone of body.zones ?? [])
      if (zone?.serverErrorCode)
        throw serviceError(String(zone.serverErrorCode));
    for (const r of body.records ?? []) {
      if (r?.serverErrorCode) throw serviceError(String(r.serverErrorCode));
    }
    return body;
  }
}
export const field = (r: any, key: string) => r?.fields?.[key]?.value;
export function wrappedText(v: unknown) {
  if (v == null) return null;
  if (typeof v !== "string")
    throw new AppError("PROTOCOL_CHANGED", "Unsupported Apple text field.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(v), (c) => c.charCodeAt(0)),
    );
  } catch {
    return v;
  }
}

export function retrySeconds(value: string | null) {
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, (time - Date.now()) / 1000) : null;
}
export function serviceError(code: string) {
  if (
    ["PCS_REQUIRED", "DEVICE_CONSENT_REQUIRED", "WEB_ACCESS_DISABLED"].includes(
      code,
    )
  )
    return new AppError(
      "DEVICE_APPROVAL_PENDING",
      "Reauthorize this service PCS in /admin.",
      409,
    );
  if (
    [
      "AUTHENTICATION_REQUIRED",
      "INVALID_AUTH_TOKEN",
      "NOT_AUTHENTICATED",
      "AUTHENTICATION_FAILED",
    ].includes(code)
  )
    return new AppError(
      "REAUTH_REQUIRED",
      "Apple rejected the session. Reconnect in /admin.",
      409,
    );
  if (
    ["ACCESS_DENIED", "PERMISSION_FAILURE", "PERMISSION_DENIED"].includes(code)
  )
    return new AppError(
      "FORBIDDEN",
      "Apple denied this resource. Check account permissions.",
      403,
    );
  if (["THROTTLED", "REQUEST_RATE_LIMITED", "ZONE_BUSY"].includes(code))
    return new UpstreamRateLimitedError(null);
  if (["UNKNOWN_ITEM", "NOT_FOUND"].includes(code))
    return new AppError(
      "CONFLICT",
      "Requested Apple resource no longer exists. Refresh the listing.",
      409,
    );
  return new AppError(
    "PROTOCOL_CHANGED",
    "Apple returned an unsupported service error. Check project updates.",
  );
}
