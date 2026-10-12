import { AppError } from "../../errors.ts";
import { AppleAuthHTTP } from "./http.ts";

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
  http.expect(consent, [200]);
  checkpoint.consentChecks++;
  const state = consent.body;
  if (typeof state?.isICDRSDisabled !== "boolean")
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned an unknown web-access consent state.",
    );
  if (state.isICDRSDisabled === false) return { state: "READY", checkpoint };
  if (state.isDeviceConsentedForPCS !== true) {
    if (!checkpoint.consentRequested) {
      const request = await http.setup(
        "/enableDeviceConsentForPCS",
        undefined,
        dsid,
      );
      http.expect(request, [200]);
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
  http.expect(pcs, [200]);
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
      "Apple returned an unsupported Reminders key-consent response.",
    );
  checkpoint.nextAttemptAt = now + 5000;
  return {
    state: "DEVICE_APPROVAL_PENDING",
    action: "wait-for-reminders-keys",
    checkpoint,
  };
}
