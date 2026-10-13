import { z } from "zod";
import { AppError } from "../../errors.ts";
import type {
  AppleSession,
  AppleSessionRepository,
} from "../../persistence/apple-sessions.ts";
import type { RuntimeEnv } from "../../platform/sites.ts";
import { freshPcsCheckpoint } from "./pcs.ts";
import { requireCurrentLogin } from "./policy.ts";
import {
  AppleAuthHTTP,
  AppleAuthenticationError,
  AppleRetryError,
} from "./http.ts";

const time = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .max(8_640_000_000_000_000)
  .nullable();
export const RenewalCheckpointSchema = z
  .object({
    lastValidatedAt: time,
    lastAppleSuccessAt: time,
    lastRenewedAt: time,
    nextRetryAt: time,
    failures: z.number().int().min(0).max(8),
    requiredAction: z
      .enum([
        "verify-device",
        "apple-sign-in",
        "review-terms",
        "approve-reminders",
        "retry",
      ])
      .nullable(),
    lastErrorCode: z
      .enum([
        "REAUTH_REQUIRED",
        "VERIFICATION_REQUIRED",
        "TERMS_ACTION_REQUIRED",
        "DEVICE_APPROVAL_PENDING",
        "RATE_LIMITED",
        "UPSTREAM_UNAVAILABLE",
        "PROTOCOL_CHANGED",
        "FORBIDDEN",
        "UNSUPPORTED_AUTH",
      ])
      .nullable(),
  })
  .strict();
export type RenewalCheckpoint = z.infer<typeof RenewalCheckpointSchema>;
export const renewalCheckpoint = (): RenewalCheckpoint => ({
  lastValidatedAt: null,
  lastAppleSuccessAt: null,
  lastRenewedAt: null,
  nextRetryAt: null,
  failures: 0,
  requiredAction: null,
  lastErrorCode: null,
});
export interface AppleRequestBudget {
  deadline: number;
  recoveryUsed: boolean;
}
export const appleRequestBudget = (): AppleRequestBudget => ({
  deadline: Date.now() + 40_000,
  recoveryUsed: false,
});
export function appleSuccess(session: AppleSession): AppleSession {
  return {
    ...session,
    renewal: {
      ...(session.renewal ?? renewalCheckpoint()),
      lastAppleSuccessAt: Date.now(),
    },
  };
}

export function sessionCheckInterval(env: RuntimeEnv) {
  if (env.APPLE_SESSION_CHECK_INTERVAL_MS === undefined) return 6 * 60 * 60_000;
  const interval = Number(env.APPLE_SESSION_CHECK_INTERVAL_MS);
  if (
    !/^\d+$/.test(env.APPLE_SESSION_CHECK_INTERVAL_MS) ||
    !Number.isSafeInteger(interval) ||
    interval < 300_000 ||
    interval > 86_400_000
  )
    throw new AppError(
      "CONFIGURATION_REQUIRED",
      "The saved-session check interval must be between five minutes and 24 hours.",
      503,
    );
  return interval;
}

function checkDue(session: AppleSession, interval: number, now: number) {
  const metadata = session.renewal ?? renewalCheckpoint();
  const recent = Math.max(
    metadata.lastValidatedAt ?? session.login.verifiedAt,
    metadata.lastAppleSuccessAt ?? 0,
  );
  if (now - recent >= interval) return true;
  // Unknown cookie expiry is not evidence of Apple validity. Only the required
  // web-auth cookie's known expiry accelerates an otherwise recent check.
  const http = AppleAuthHTTP.restore(session.auth);
  const url = new URL(`${http.setupRoot}/validate`);
  const cookies = http.http.jar.header(url, now);
  if (
    !cookies
      .split("; ")
      .some((cookie) => cookie.startsWith("X-APPLE-WEBAUTH-TOKEN="))
  )
    return now - (metadata.lastValidatedAt ?? 0) >= 300_000;
  return (
    session.auth.cookies.some(
      (cookie) =>
        cookie.name === "X-APPLE-WEBAUTH-TOKEN" &&
        cookie.expiresAt !== null &&
        cookie.expiresAt <= now + 600_000,
    ) && now - (metadata.lastValidatedAt ?? 0) >= 300_000
  );
}

function pendingError(metadata: RenewalCheckpoint, now: number) {
  if (metadata.requiredAction === "apple-sign-in")
    return new AppError(
      "REAUTH_REQUIRED",
      "The saved tokens cannot renew this connection. Use the secure sign-in form; the retained record has not been replaced.",
      409,
    );
  if (metadata.requiredAction === "verify-device")
    return new AppError(
      "VERIFICATION_REQUIRED",
      "Apple requires fresh device verification. Use the secure connection form.",
      409,
    );
  if (metadata.nextRetryAt !== null && now < metadata.nextRetryAt)
    return new AppError(
      metadata.lastErrorCode ?? "UPSTREAM_UNAVAILABLE",
      metadata.requiredAction === "review-terms"
        ? "Review Apple's updated terms in the official iCloud interface, then retry after the displayed time."
        : "The saved connection is preserved. Wait until the displayed retry time before contacting Apple again.",
      metadata.lastErrorCode === "RATE_LIMITED" ? 429 : 503,
      true,
    );
  return null;
}

export class AppleSessionRenewal {
  readonly env: RuntimeEnv;
  readonly repository: AppleSessionRepository;
  constructor(env: RuntimeEnv, repository: AppleSessionRepository) {
    this.env = env;
    this.repository = repository;
  }

  async ensure(
    expectedGeneration: number,
    budget: AppleRequestBudget,
    force = false,
  ) {
    let saved = await this.repository.load();
    if (saved.fence.generation !== expectedGeneration)
      throw new AppError(
        "CONFLICT",
        "The Apple connection changed before validation.",
        409,
      );
    requireCurrentLogin(saved.session.login);
    const blocked = pendingError(
      saved.session.renewal ?? renewalCheckpoint(),
      Date.now(),
    );
    if (blocked) throw blocked;
    if (this.env.APPLE_SESSION_RENEWAL_ENABLED === "false") return saved;
    if (
      this.env.REMINDERS_OWNER_ID &&
      this.repository.owner !== this.env.REMINDERS_OWNER_ID
    )
      throw new AppError(
        "FORBIDDEN",
        "Only the configured authenticated owner may renew an Apple session.",
        403,
      );
    if (
      !force &&
      !saved.session.renewal?.lastErrorCode &&
      !checkDue(saved.session, sessionCheckInterval(this.env), Date.now())
    )
      return saved;
    if (budget.recoveryUsed)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "This request already used its saved-token recovery cycle. The connection is preserved.",
        503,
        true,
      );
    if (budget.deadline - Date.now() < 18_000)
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Insufficient request time remains for a bounded session check. Retry in a new request.",
        503,
        true,
      );
    const fence = await this.repository.claimRenewal(
      expectedGeneration,
      saved.fence.version,
    );
    try {
      saved = await this.repository.load();
      if (
        saved.fence.generation !== fence.generation ||
        saved.fence.version !== fence.version
      )
        throw new AppError(
          "CONFLICT",
          "The Apple connection changed before validation began.",
          409,
        );
      if (budget.deadline - Date.now() < 18_000)
        throw new AppError(
          "UPSTREAM_UNAVAILABLE",
          "Insufficient request time remains for validation. The connection is preserved.",
          503,
          true,
        );
      const metadata = saved.session.renewal ?? renewalCheckpoint();
      const signal = AbortSignal.timeout(
        Math.min(17_000, budget.deadline - Date.now()),
      );
      let http = AppleAuthHTTP.restore(saved.session.auth, fetch, signal);
      try {
        let connection;
        let exchanged = false;
        try {
          connection = await http.validateSession(
            saved.session.connection.dsid,
          );
        } catch (error) {
          if (!(error instanceof AppleAuthenticationError) || error.confirmed)
            throw error;
          if (budget.recoveryUsed || budget.deadline - Date.now() < 9000)
            throw new AppError(
              "UPSTREAM_UNAVAILABLE",
              "No time remains for saved-token recovery. Retry later.",
              503,
              true,
            );
          budget.recoveryUsed = true;
          http = AppleAuthHTTP.restore(
            { ...saved.session.auth, cookies: http.snapshot().cookies },
            fetch,
            signal,
          );
          if (!http.value("X-Apple-Session-Token"))
            throw new AppError(
              "REAUTH_REQUIRED",
              "No saved session token is available for recovery. Use the secure sign-in form.",
              409,
            );
          connection = await http.accountLogin(saved.session.connection.dsid);
          exchanged = true;
        }
        const now = Date.now();
        requireCurrentLogin(saved.session.login, now);
        await this.repository.commitResume(
          fence,
          {
            ...saved.session,
            auth: http.snapshot(),
            connection: { ...saved.session.connection, ...connection },
            renewal: {
              ...metadata,
              lastValidatedAt: now,
              lastRenewedAt: exchanged ? now : metadata.lastRenewedAt,
              failures: 0,
              nextRetryAt: null,
              requiredAction: null,
              lastErrorCode: null,
            },
          },
          saved.state,
          saved.action ?? undefined,
        );
      } catch (error) {
        if (error instanceof AppleAuthenticationError && error.confirmed) {
          await this.repository.invalidate(fence, "apple-sign-in");
          throw error;
        }
        if (
          error instanceof AppError &&
          ["AUTH_EXPIRED", "CONFLICT", "CONFIGURATION_REQUIRED"].includes(
            error.code,
          )
        )
          throw error;
        const safe =
          error instanceof AppError
            ? error
            : new AppError(
                "UPSTREAM_UNAVAILABLE",
                "Apple session validation did not finish. The connection is preserved.",
                503,
                true,
              );
        const code = RenewalCheckpointSchema.shape.lastErrorCode.safeParse(
          safe.code,
        );
        if (!code.success || code.data === null) throw safe;
        const failures = Math.min(8, metadata.failures + 1);
        const nextRetryAt =
          Date.now() +
          Math.max(
            error instanceof AppleRetryError ? error.retryAfterMs : 0,
            Math.min(3_600_000, 30_000 * 2 ** (failures - 1)),
          );
        const requiredAction =
          safe.code === "REAUTH_REQUIRED"
            ? "apple-sign-in"
            : safe.code === "VERIFICATION_REQUIRED"
              ? "verify-device"
              : safe.code === "TERMS_ACTION_REQUIRED"
                ? "review-terms"
                : "retry";
        // Failed checks may delete cookies, but may not bless returned tokens,
        // service changes or a new validation time.
        await this.repository.commitResume(
          fence,
          {
            ...saved.session,
            auth: { ...saved.session.auth, cookies: http.snapshot().cookies },
            renewal: {
              ...metadata,
              failures,
              nextRetryAt,
              requiredAction,
              lastErrorCode: code.data,
            },
          },
          saved.state,
          saved.action ?? undefined,
        );
        throw safe;
      }
    } finally {
      await this.repository.releaseResume(fence);
    }
    return this.repository.load();
  }

  async requireDataApproval(
    expectedGeneration: number,
    budget: AppleRequestBudget,
  ) {
    const saved = await this.ensure(expectedGeneration, budget);
    const fence = await this.repository.claimRenewal(
      expectedGeneration,
      saved.fence.version,
    );
    try {
      await this.repository.commitResume(
        fence,
        {
          ...saved.session,
          pcs: freshPcsCheckpoint(),
          renewal: {
            ...(saved.session.renewal ?? renewalCheckpoint()),
            requiredAction: "approve-reminders",
            lastErrorCode: null,
          },
        },
        "DEVICE_APPROVAL_PENDING",
        "approve-device-consent",
      );
    } finally {
      await this.repository.releaseResume(fence);
    }
    throw new AppError(
      "DEVICE_APPROVAL_PENDING",
      "The Apple account connection is preserved. Approve Reminders web access on your device, then check approval.",
      409,
    );
  }
}
