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
  try {
    const saved = await new AppleSessionRepository(env, owner).load();
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
    dav,
    services: permissions.map((c) => ({
      ...c,
      credentialAvailable: ["calendar", "contacts"].includes(c.service)
        ? dav.configured
        : web.connected,
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
    productionValidated: false,
  };
}
