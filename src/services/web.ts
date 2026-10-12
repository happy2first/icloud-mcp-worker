import {
  AppleSessionRepository,
  type AppleSession,
} from "../persistence/apple-sessions.ts";
import { AppleAuthHTTP } from "../auth/apple/http.ts";
import {
  AppleSessionRenewal,
  appleRequestBudget,
  appleSuccess,
} from "../auth/apple/session-renewal.ts";
import { advancePcs, freshPcsCheckpoint } from "../auth/apple/pcs.ts";
import { AppError, UpstreamRateLimitedError } from "../errors.ts";
import { appleWebHeaders } from "../transport/apple-http.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
export type PcsService = "notes3" | "photos" | "iclouddrive";
export async function webOperation<T>(
  env: RuntimeEnv,
  owner: string,
  service: PcsService,
  run: (client: WebClient) => Promise<T>,
  approve = false,
) {
  const repo = new AppleSessionRepository(env, owner);
  const initial = await repo.load();
  const saved = await new AppleSessionRenewal(env, repo).ensure(
    initial.fence.generation,
    appleRequestBudget(),
  );
  const fence = await repo.claimRenewal(
    saved.fence.generation,
    saved.fence.version,
  );
  const http = AppleAuthHTTP.restore(
    saved.session.auth,
    fetch,
    AbortSignal.timeout(25000),
  );
  let session = saved.session;
  try {
    const state = session.servicePcs?.[service];
    if (approve) {
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
          [service]: { ...result.checkpoint, ready: result.state === "READY" },
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
        nextAttemptAt: result.checkpoint.nextAttemptAt,
      } as T;
    }
    if (!state?.ready)
      throw new AppError(
        "DEVICE_APPROVAL_PENDING",
        `Open /admin and authorize ${service} PCS access.`,
        409,
      );
    const result = await run(new WebClient(http, session));
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
      e.code === "DEVICE_APPROVAL_PENDING" &&
      session.servicePcs?.[service]?.ready
    ) {
      session = {
        ...session,
        servicePcs: {
          ...session.servicePcs,
          [service]: { ...session.servicePcs[service]!, ready: false },
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
    throw e;
  } finally {
    await repo.releaseResume(fence);
  }
}
export class WebClient {
  constructor(
    readonly auth: AppleAuthHTTP,
    readonly session: AppleSession,
  ) {}
  root(service: "ckdatabasews" | "drivews" | "docws") {
    const value =
      this.session.connection.services?.[service] ??
      (service === "ckdatabasews"
        ? new URL(this.session.connection.cloudKitURL).origin
        : undefined);
    if (!value)
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        `Apple did not advertise ${service}. Reconnect; this account may not support the service.`,
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
    service: "ckdatabasews" | "drivews" | "docws",
    path: string,
    payload?: unknown,
  ) {
    const url = new URL(path, this.root(service));
    for (const [k, v] of this.params()) url.searchParams.set(k, v);
    const r = await this.auth.http.request(url.href, {
      discovered: true,
      headers: appleWebHeaders(),
      method: payload === undefined ? "GET" : "POST",
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if ([401, 421, 450].includes(r.status))
      throw new AppError(
        "REAUTH_REQUIRED",
        "Apple session rejected. Reconnect in /admin.",
        409,
      );
    if (r.status === 429)
      throw new UpstreamRateLimitedError(
        retrySeconds(r.headers.get("retry-after")),
      );
    let body: any;
    try {
      body = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(r.bytes),
      );
    } catch {
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple returned an unsupported response.",
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
    if (r.status >= 500)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Apple service is temporarily unavailable. Retry later.",
        503,
        true,
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
    for (const r of body.records ?? []) {
      if (r.serverErrorCode) throw serviceError(String(r.serverErrorCode));
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
