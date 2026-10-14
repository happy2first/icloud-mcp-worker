export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "OWNER_NOT_CONFIGURED"
  | "NOT_CONNECTED"
  | "UNSUPPORTED_AUTH"
  | "UNSUPPORTED_FEATURE"
  | "VALIDATION_ERROR"
  | "PROTOCOL_CHANGED"
  | "APPLE_REDIRECT_ERROR"
  | "UPSTREAM_UNAVAILABLE"
  | "RATE_LIMITED"
  | "CONFIGURATION_REQUIRED"
  | "STORAGE_UNAVAILABLE"
  | "STORAGE_SCHEMA_MISMATCH"
  | "CONFLICT"
  | "REAUTH_REQUIRED"
  | "VERIFICATION_REQUIRED"
  | "DEVICE_APPROVAL_PENDING"
  | "TERMS_ACTION_REQUIRED"
  | "AUTH_EXPIRED"
  | "RESTART_REQUIRED"
  | "WRITE_OUTCOME_UNKNOWN";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    code: ErrorCode,
    message: string,
    status = 422,
    retryable = false,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export class UpstreamRateLimitedError extends AppError {
  readonly retryAfterSeconds: number | null;
  constructor(seconds: number | null) {
    super(
      "RATE_LIMITED",
      "Apple is limiting requests. Wait for retryAfterSeconds, or retry later if it is unavailable.",
      429,
      true,
    );
    this.retryAfterSeconds =
      seconds !== null && Number.isFinite(seconds) && seconds >= 0
        ? Math.min(seconds, 86400)
        : null;
  }
}

export class WriteOutcomeUnknownError extends AppError {
  readonly reminderId: string;
  readonly idempotencyKey?: string;
  constructor(reminderId: string, idempotencyKey?: string, detail?: string) {
    super(
      "WRITE_OUTCOME_UNKNOWN",
      "Apple may have saved the reminder, but this request could not confirm the result. Read the reminder before trying another change. For creation, reuse the same idempotencyKey; never generate another ID for this attempt." +
        (detail ? ` Details: ${detail}` : ""),
      503,
      false,
    );
    this.reminderId = reminderId;
    this.idempotencyKey = idempotencyKey;
  }
}

export function publicError(error: unknown, requestId: string) {
  // Classify known database failures without returning raw SQL, data or bindings.
  const isStorageFailure = (value: unknown): boolean => {
    if (!(value instanceof Error)) return false;
    return (
      /D1_ERROR|D1_EXEC_ERROR|SQLITE_|no such (?:table|column)|database is locked/i.test(
        value.message,
      ) ||
      (value.cause instanceof Error &&
        /D1_ERROR|D1_EXEC_ERROR|SQLITE_|no such (?:table|column)/i.test(
          value.cause.message,
        ))
    );
  };
  const e =
    error instanceof AppError
      ? error
      : isStorageFailure(error)
        ? new AppError(
            "STORAGE_UNAVAILABLE",
            "Worker database access failed. Check D1; this error does not indicate an Apple connection failure.",
            503,
            true,
          )
        : new AppError(
            "UPSTREAM_UNAVAILABLE",
            "This operation could not be completed. Try the connection again.",
            503,
            true,
          );
  const retry =
    "retryAfterSeconds" in e
      ? e.retryAfterSeconds
      : "retryAfterMs" in e && typeof e.retryAfterMs === "number"
        ? e.retryAfterMs / 1000
        : null;
  return {
    ...(typeof retry === "number" && Number.isFinite(retry) && retry >= 0
      ? { retryAfterSeconds: Math.min(retry, 86400) }
      : {}),
    code: e.code,
    message: e.message,
    retryable: e.retryable,
    requestId,
    ...(e instanceof WriteOutcomeUnknownError
      ? {
          reminderId: e.reminderId,
          ...(e.idempotencyKey ? { idempotencyKey: e.idempotencyKey } : {}),
        }
      : {}),
  };
}

export function requireValue(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new AppError("VALIDATION_ERROR", message);
}
