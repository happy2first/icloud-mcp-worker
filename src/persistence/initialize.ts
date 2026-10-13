import { AppError } from "../errors.ts";
import type { RuntimeEnv } from "../platform/sites.ts";

// Build embeds the same schema.sql used by Wrangler, with no runtime filesystem.
declare const __D1_SCHEMA_SQL__: string;
const initialized = new WeakMap<object, Promise<void>>();
const checks = [
  "SELECT owner_id,account_id,generation,version,state,action,next_attempt_at,envelope,transaction_id,transaction_expires_at,resume_id,resume_expires_at,updated_at FROM apple_session_state LIMIT 0",
  "SELECT owner_id,version,envelope FROM credentials LIMIT 0",
  "SELECT owner_id,service,enabled,writable FROM service_config LIMIT 0",
  "SELECT owner_id,window,count FROM request_limits LIMIT 0",
  "SELECT id,owner_id,expires_at,envelope FROM download_tickets LIMIT 0",
];

export async function ensureStorage(
  env: RuntimeEnv,
  schemaSQL = typeof __D1_SCHEMA_SQL__ === "string" ? __D1_SCHEMA_SQL__ : "",
) {
  const database = env.DB;
  if (!database || typeof database.withSession !== "function")
    throw new AppError(
      "CONFIGURATION_REQUIRED",
      "Bind a D1 database as DB with session support.",
      503,
    );
  if (!schemaSQL)
    throw new AppError(
      "CONFIGURATION_REQUIRED",
      "The database initialization schema is missing. Rebuild the Worker.",
      503,
    );
  let pending = initialized.get(database);
  if (!pending) {
    pending = (async () => {
      const session = database.withSession("first-primary");
      const statements = schemaSQL
        .replace(/^--.*$/gm, "")
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean);
      // Only additive first-install DDL; never overwrite/delete credentials or alter
      // existing columns automatically. Future schema changes need explicit migrations.
      if (
        statements.length !== 5 ||
        statements.some((sql) => !/^CREATE TABLE IF NOT EXISTS\s/i.test(sql))
      )
        throw new AppError(
          "CONFIGURATION_REQUIRED",
          "The initial database schema is invalid. Rebuild the Worker.",
          503,
        );
      try {
        await session.batch(statements.map((sql) => session.prepare(sql)));
      } catch {
        throw new AppError(
          "STORAGE_UNAVAILABLE",
          "D1 initialization failed. Check the DB binding and Cloudflare database availability; existing data was not replaced.",
          503,
          true,
        );
      }
      try {
        await session.batch(checks.map((sql) => session.prepare(sql)));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message +
              (error.cause instanceof Error ? " " + error.cause.message : "")
            : "";
        if (/no such (?:table|column)/i.test(message))
          throw new AppError(
            "STORAGE_SCHEMA_MISMATCH",
            "The bound D1 database has an incompatible schema. Verify the database and apply an explicit migration; do not delete existing data.",
            503,
          );
        throw new AppError(
          "STORAGE_UNAVAILABLE",
          "D1 schema inspection failed. Check Cloudflare database availability and retry; existing data was not replaced.",
          503,
          true,
        );
      }
    })();
    initialized.set(database, pending);
    const attempt = pending;
    void pending.catch(() => {
      if (initialized.get(database) === attempt) initialized.delete(database);
    });
  }
  await pending;
}
