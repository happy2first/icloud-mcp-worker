import { z } from "zod";
import { envelopesFromSecret, type Envelope } from "../crypto/envelopes.ts";
import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
export const ServiceName = z.enum([
  "calendar",
  "contacts",
  "reminders",
  "notes",
  "photos",
  "drive",
]);
export type ServiceName = z.infer<typeof ServiceName>;
export const CredentialInput = z
  .object({
    account: z.string().trim().email().max(320),
    password: z
      .string()
      .max(100)
      .transform((v) => v.replace(/[\s-]/g, ""))
      .pipe(z.string().regex(/^[a-z]{16}$/))
      .transform((v) => v.match(/.{4}/g)!.join("-")),
    expectedVersion: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export function db(env: RuntimeEnv) {
  if (!env.DB)
    throw new AppError("CONFIGURATION_REQUIRED", "Bind the D1 database.", 503);
  return env.DB.withSession("first-primary");
}
export function cipher(env: RuntimeEnv) {
  try {
    return envelopesFromSecret(env.ENCRYPTION_KEYS_JSON);
  } catch {
    throw new AppError(
      "CONFIGURATION_REQUIRED",
      "Configure encryption Secrets.",
      503,
    );
  }
}
const context = (owner: string, version: number) => ({
  ownerId: owner,
  accountId: "apple-dav",
  generation: version,
  recordId: "app-password",
  schemaVersion: 1 as const,
});
export async function saveCredentials(
  env: RuntimeEnv,
  owner: string,
  input: z.infer<typeof CredentialInput>,
) {
  const version = input.expectedVersion + 1;
  const envelope = JSON.stringify(
    await cipher(env).encrypt(
      { account: input.account, password: input.password },
      context(owner, version),
    ),
  );
  const result =
    input.expectedVersion === 0
      ? await db(env)
          .prepare("INSERT OR IGNORE INTO credentials VALUES(?,?,?)")
          .bind(owner, version, envelope)
          .run()
      : await db(env)
          .prepare(
            "UPDATE credentials SET version=?,envelope=? WHERE owner_id=? AND version=?",
          )
          .bind(version, envelope, owner, input.expectedVersion)
          .run();
  if (result.meta.changes !== 1)
    throw new AppError(
      "CONFLICT",
      "Credentials changed. Refresh management status.",
      409,
    );
  return { version };
}
export async function credentialStatus(env: RuntimeEnv, owner: string) {
  const row = await db(env)
    .prepare("SELECT version FROM credentials WHERE owner_id=?")
    .bind(owner)
    .first<{ version: number }>();
  return { configured: !!row, version: row?.version ?? 0 };
}
export async function loadCredentials(env: RuntimeEnv, owner: string) {
  const row = await db(env)
    .prepare("SELECT version,envelope FROM credentials WHERE owner_id=?")
    .bind(owner)
    .first<{ version: number; envelope: string }>();
  if (!row)
    throw new AppError(
      "NOT_CONNECTED",
      "Enter an Apple app-specific password in /admin.",
      409,
    );
  return cipher(env).decrypt<{ account: string; password: string }>(
    JSON.parse(row.envelope) as Envelope,
    context(owner, row.version),
  );
}
export async function configs(env: RuntimeEnv, owner: string) {
  const r = await db(env)
    .prepare(
      "SELECT service,enabled,writable FROM service_config WHERE owner_id=?",
    )
    .bind(owner)
    .all<{ service: ServiceName; enabled: number; writable: number }>();
  return ServiceName.options.map((service) => ({
    service,
    enabled: !!r.results.find((x) => x.service === service)?.enabled,
    writable: !!r.results.find((x) => x.service === service)?.writable,
  }));
}
export async function requireService(
  env: RuntimeEnv,
  owner: string,
  service: ServiceName,
  write = false,
) {
  const config = (await configs(env, owner)).find(
    (x) => x.service === service,
  )!;
  if (!config.enabled)
    throw new AppError("FORBIDDEN", `Enable ${service} in /admin.`, 403);
  if (write && !config.writable)
    throw new AppError(
      "FORBIDDEN",
      `Enable write access for ${service} in /admin.`,
      403,
    );
}
export async function rateLimit(env: RuntimeEnv, owner: string) {
  const window = Math.floor(Date.now() / 60000);
  const row = await db(env)
    .prepare(
      "INSERT INTO request_limits VALUES(?,?,1) ON CONFLICT(owner_id) DO UPDATE SET count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END,window=excluded.window RETURNING count",
    )
    .bind(owner, window)
    .first<{ count: number }>();
  if (!row || row.count > 60)
    throw new AppError(
      "RATE_LIMITED",
      "Request limit reached. Wait until the next minute.",
      429,
      true,
    );
}
