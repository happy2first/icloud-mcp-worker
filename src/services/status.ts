import type { RuntimeEnv } from "../platform/sites.ts";
import { configs, credentialStatus } from "./config.ts";
import { AppleConnectionService } from "../auth/service.ts";
import { AppleSessionRepository } from "../persistence/apple-sessions.ts";
export async function serviceStatus(env: RuntimeEnv, owner: string) {
  const web = await new AppleConnectionService(env, owner).status();
  const permissions = await configs(env, owner);
  const reminders = permissions.find((c) => c.service === "reminders")!;
  web.writeEnabled =
    web.writeEnabled && reminders.enabled && reminders.writable;
  web.phase = web.writeEnabled ? "read-write" : "read-only";
  for (const key of ["create", "update", "complete", "reopen"] as const)
    web.capabilities[key] = web.capabilities[key] && web.writeEnabled;
  for (const key of [
    "liveRead",
    "controlledRead",
    "listReminders",
    "allOpenReminders",
  ] as const)
    web.capabilities[key] = web.capabilities[key] && reminders.enabled;
  const dav = await credentialStatus(env, owner);
  let pcs: Record<string, boolean> = {};
  let webSessionAvailable = false;
  const pcsProgress: Record<
    string,
    { nextAttemptAt: number; expiresAt: number; exhausted: boolean }
  > = {};
  try {
    const saved = await new AppleSessionRepository(env, owner).load();
    webSessionAvailable = web.gates.enabled;
    for (const [name, p] of Object.entries({
      reminders: saved.session.pcs,
      ...saved.session.servicePcs,
    }))
      if (p)
        pcsProgress[name] = {
          nextAttemptAt: p.nextAttemptAt,
          expiresAt: p.expiresAt,
          exhausted: p.pcsAttempts >= 10 || p.consentChecks >= 10,
        };
    pcs = Object.fromEntries(
      Object.entries(saved.session.servicePcs ?? {}).map(([k, v]) => [
        k,
        !!v?.ready,
      ]),
    );
  } catch {
    /* disconnected has no saved session */
  }
  return {
    web,
    webSessionAvailable,
    dav,
    pcsProgress,
    services: permissions.map((c) => ({
      ...c,
      credentialAvailable: ["calendar", "contacts"].includes(c.service)
        ? dav.configured
        : webSessionAvailable,
      pcsReady:
        c.service === "notes"
          ? !!pcs.notes3
          : c.service === "photos"
            ? !!pcs.photos
            : c.service === "drive"
              ? !!pcs.iclouddrive
              : c.service === "reminders"
                ? web.state === "READY"
                : null,
      realAppleValidated: false,
    })),
    findmy: {
      credentialAvailable: webSessionAvailable,
      authentication: "existing-apple-web-session",
      familySharing: true,
      soundRequiresConfirmation: true,
      realAppleValidated: false,
    },
    productionValidated: false,
  };
}
