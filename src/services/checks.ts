import { db } from "./config.ts";
import { AppError } from "../errors.ts";
import { AppleSessionRepository } from "../persistence/apple-sessions.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
export type ConnectionCheck = {
  state: "ok" | "error" | "pending" | "stale";
  checkedAt: number;
  error?: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
  };
  action?: string;
  nextAttemptAt?: number;
};
export async function checkScopes(env: RuntimeEnv, owner: string) {
  const scopes: Record<string, string | null> = {};
  const row = await db(env)
    .prepare("SELECT version,envelope FROM credentials WHERE owner_id=?")
    .bind(owner)
    .first<{ version: number; envelope: string }>();
  const dav = row
    ? Array.from(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(row.envelope),
          ),
        ),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    : null;
  scopes.calendar = scopes.contacts = dav;
  let web: string | null = null;
  try {
    const saved = await new AppleSessionRepository(env, owner).load();
    web = `${saved.fence.generation}:${saved.session.login.verifiedAt}`;
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      ![
        "NOT_CONNECTED",
        "REAUTH_REQUIRED",
        "VERIFICATION_REQUIRED",
        "AUTH_EXPIRED",
      ].includes(error.code)
    )
      throw error;
  }
  for (const name of ["reminders", "notes", "photos", "drive", "findmy"])
    scopes[name] = web;
  return scopes;
}
export async function savedChecks(env: RuntimeEnv, owner: string) {
  const scopes = await checkScopes(env, owner);
  const rows = await db(env)
    .prepare("SELECT service,scope,result FROM service_checks WHERE owner_id=?")
    .bind(owner)
    .all<{ service: string; scope: string; result: string }>();
  const out: Record<string, ConnectionCheck | null> = {};
  for (const name of Object.keys(scopes)) out[name] = null;
  for (const row of rows.results)
    if (scopes[row.service])
      out[row.service] =
        scopes[row.service] === row.scope
          ? JSON.parse(row.result)
          : { state: "stale", checkedAt: 0 };
  return out;
}
export async function saveCheck(
  env: RuntimeEnv,
  owner: string,
  service: string,
  scope: string | null,
  value: ConnectionCheck,
) {
  if (!scope || (await checkScopes(env, owner))[service] !== scope) return;
  await db(env)
    .prepare(
      "INSERT INTO service_checks(owner_id,service,scope,checked_at,result) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,service) DO UPDATE SET scope=excluded.scope,checked_at=excluded.checked_at,result=excluded.result WHERE service_checks.checked_at<=excluded.checked_at",
    )
    .bind(owner, service, scope, value.checkedAt, JSON.stringify(value))
    .run();
}
