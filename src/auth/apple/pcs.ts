import { AppError } from "../../errors.ts";
import { AppleAuthHTTP } from "./http.ts";
import { requireNoAppleRejection } from "./policy.ts";

export interface PcsCheckpoint {
  consentRequested: boolean;
  pcsAttempts: number;
  consentChecks: number;
  expiresAt: number;
  nextAttemptAt: number;
}
export type PcsResult =
  | { state: "READY"; checkpoint: PcsCheckpoint }
  | {
      state: "DEVICE_APPROVAL_PENDING";
      action: "approve-device-consent" | "wait-for-reminders-keys";
      checkpoint: PcsCheckpoint;
    };
export const freshPcsCheckpoint = (now = Date.now()): PcsCheckpoint => ({
  consentRequested: false,
  pcsAttempts: 0,
  consentChecks: 0,
  expiresAt: now + 10 * 60_000,
  nextAttemptAt: 0,
});

export function webAccessRequiresPcs(state: any): boolean {
  requireNoAppleRejection(state, "requestWebAccessState");
  if (
    state?.hsaChallengeRequired === true ||
    state?.hsaTrustedBrowser === false
  )
    throw new AppError(
      "VERIFICATION_REQUIRED",
      "Apple requestWebAccessState explicitly requires device verification or rejects browser trust. Saved credentials preserved.",
      409,
    );
  if (
    !state ||
    (state.isICDRSDisabled !== undefined &&
      typeof state.isICDRSDisabled !== "boolean") ||
    (state.isDeviceConsentedForPCS !== undefined &&
      typeof state.isDeviceConsentedForPCS !== "boolean")
  )
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple requestWebAccessState returned invalid authorization flags.",
    );
  return state.isICDRSDisabled === true;
}

// Each call makes at most two HTTP requests. Waiting belongs to a later owner
// request, not a sleeping Worker or background retry loop.
export async function advancePcs(
  http: AppleAuthHTTP,
  dsid: string,
  input: PcsCheckpoint,
  now = Date.now(),
  appName: "reminders" | "notes3" | "photos" | "iclouddrive" = "reminders",
): Promise<PcsResult> {
  const checkpoint = { ...input };
  if (now >= checkpoint.expiresAt)
    throw new AppError(
      "AUTH_EXPIRED",
      "The device-consent attempt expired. Restart setup.",
      409,
    );
  if (now < checkpoint.nextAttemptAt)
    throw new AppError(
      "RATE_LIMITED",
      "Wait until the displayed retry time before checking device consent again.",
      429,
      true,
    );
  if (checkpoint.consentChecks >= 10 || checkpoint.pcsAttempts >= 10)
    throw new AppError(
      "DEVICE_APPROVAL_PENDING",
      "Apple did not finish device consent within this attempt. Restart setup after resolving the device approval.",
      409,
    );
  const consent = await http.setup("/requestWebAccessState", undefined, dsid);
  http.expect(consent, [200], "requestWebAccessState");
  checkpoint.consentChecks++;
  const state = consent.body!;
  // Match pyicloud's optional-field defaults. READY here only completes the
  // preparation step; /admin still performs a real service read before success.
  if (!webAccessRequiresPcs(state)) return { state: "READY", checkpoint };
  if (state.isDeviceConsentedForPCS === false) {
    if (!checkpoint.consentRequested) {
      const request = await http.setup(
        "/enableDeviceConsentForPCS",
        undefined,
        dsid,
      );
      http.expect(request, [200], "enableDeviceConsentForPCS");
      if (request.body?.isDeviceConsentNotificationSent !== true)
        throw new AppError(
          "DEVICE_APPROVAL_PENDING",
          "Apple did not confirm sending the device-consent prompt. Use the official iCloud interface to resolve web access.",
          409,
        );
      checkpoint.consentRequested = true;
    }
    checkpoint.nextAttemptAt = now + 5000;
    return {
      state: "DEVICE_APPROVAL_PENDING",
      action: "approve-device-consent",
      checkpoint,
    };
  }
  const pcs = await http.setup(
    "/requestPCS",
    { appName, derivedFromUserAction: checkpoint.pcsAttempts === 0 },
    dsid,
  );
  http.expect(pcs, [200], `requestPCS (${appName})`);
  checkpoint.pcsAttempts++;
  if (pcs.body?.status === "success") {
    checkpoint.nextAttemptAt = 0;
    return { state: "READY", checkpoint };
  }
  if (
    ![
      "Requested the device to upload cookies.",
      "Cookies not available yet on server.",
    ].includes(String(pcs.body?.message))
  )
    throw new AppError(
      "PROTOCOL_CHANGED",
      `Apple requestPCS (${appName}) returned an unsupported authorization result (status=${pcs.body?.status === "error" ? "error" : pcs.body?.status === undefined ? "missing" : "other"}; message=${typeof pcs.body?.message === "string" ? "present" : "missing"}).`,
    );
  checkpoint.nextAttemptAt = now + 5000;
  return {
    state: "DEVICE_APPROVAL_PENDING",
    action: "wait-for-reminders-keys",
    checkpoint,
  };
}
