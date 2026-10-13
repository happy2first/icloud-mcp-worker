import { AppError } from "../errors.ts";
import { db, cipher, requireService } from "./config.ts";
import { AppleSessionRepository } from "../persistence/apple-sessions.ts";
import { requireAppleEnabled } from "../auth/gates.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
export function assetURL(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.hash ||
    !/^(?:[a-z0-9-]+\.)*(?:icloud-content\.com|icloud\.com(?:\.cn)?)$/.test(
      u.hostname,
    )
  )
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned an unsupported asset host. No request was sent.",
    );
  return u;
}
const context = (owner: string, id: string) => ({
  ownerId: owner,
  accountId: "apple-download",
  generation: 0,
  recordId: id,
  schemaVersion: 1 as const,
});
export async function issueDownload(
  env: RuntimeEnv,
  owner: string,
  asset: { url: string; filename: string },
  scope: { service: "photos" | "drive"; generation: number },
) {
  requireAppleEnabled(env);
  await requireService(env, owner, scope.service);
  const saved = await new AppleSessionRepository(env, owner).load();
  if (saved.fence.generation !== scope.generation)
    throw new AppError(
      "CONFLICT",
      "Apple session changed. Request a new download.",
      409,
    );
  assetURL(asset.url);
  const id = crypto.randomUUID(),
    expiresAt = Math.min(Date.now() + 300000, saved.session.login.expiresAt);
  const envelope = await cipher(env).encrypt(
    { ...asset, ...scope },
    context(owner, id),
  );
  await db(env)
    .prepare("DELETE FROM download_tickets WHERE expires_at<?")
    .bind(Date.now())
    .run();
  await db(env)
    .prepare("INSERT INTO download_tickets VALUES(?,?,?,?)")
    .bind(id, owner, expiresAt, JSON.stringify(envelope))
    .run();
  return {
    downloadUrl: env.APP_ORIGIN + "/download/" + id,
    resourceUri: "icloud-file://" + id,
    expiresAt,
    authentication: "Cloudflare Access required",
    streamed: true,
  };
}
export async function download(
  env: RuntimeEnv,
  owner: string,
  id: string,
  send: typeof fetch = fetch,
) {
  if (!/^[0-9a-f-]{36}$/.test(id))
    throw new AppError("VALIDATION_ERROR", "Invalid download reference.");
  const row = await db(env)
    .prepare(
      "SELECT envelope FROM download_tickets WHERE id=? AND owner_id=? AND expires_at>?",
    )
    .bind(id, owner, Date.now())
    .first<{ envelope: string }>();
  if (!row)
    throw new AppError(
      "AUTH_EXPIRED",
      "Download reference expired. Request a new reference.",
      409,
    );
  const asset = await cipher(env).decrypt<{
    url: string;
    filename: string;
    service: "photos" | "drive";
    generation: number;
  }>(JSON.parse(row.envelope), context(owner, id));
  // Older unscoped tickets deliberately fail closed after this upgrade.
  if (
    !["photos", "drive"].includes(asset.service) ||
    !Number.isSafeInteger(asset.generation)
  )
    throw new AppError(
      "AUTH_EXPIRED",
      "Request a fresh scoped download reference.",
      409,
    );
  requireAppleEnabled(env);
  await requireService(env, owner, asset.service);
  const saved = await new AppleSessionRepository(env, owner).load();
  if (saved.fence.generation !== asset.generation)
    throw new AppError(
      "AUTH_EXPIRED",
      "Apple session changed. Request a new download reference.",
      409,
    );
  let url = assetURL(asset.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    let r: Response | undefined;
    for (let i = 0; i < 4; i++) {
      r = await send.call(globalThis, url, {
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 307, 308].includes(r.status)) break;
      const location = r.headers.get("location");
      await r.body?.cancel();
      if (!location || i === 3)
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Asset redirect budget exceeded.",
        );
      url = assetURL(new URL(location, url).href);
    }
    if (Number(r?.headers.get("content-length")) > 100 * 1024 * 1024)
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "File exceeds the 100 MiB download budget.",
        409,
      );
    if (!r?.ok || !r.body)
      throw new AppError(
        r?.status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
        "Apple asset is unavailable. Obtain a fresh download reference.",
        503,
        true,
      );
    const reader = r.body.getReader();
    let count = 0;
    const max = 100 * 1024 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const v = await reader.read();
          if (v.done) {
            clearTimeout(timer);
            reader.releaseLock();
            c.close();
            return;
          }
          count += v.value.length;
          if (count > max) throw new Error("limit");
          c.enqueue(v.value);
        } catch {
          clearTimeout(timer);
          controller.abort();
          await reader.cancel().catch(() => {});
          c.error(new Error("Download exceeded time/size budget."));
        }
      },
      async cancel() {
        clearTimeout(timer);
        controller.abort();
        await reader.cancel().catch(() => {});
      },
    });
    return new Response(stream, {
      headers: {
        "content-type":
          r.headers.get("content-type") ?? "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename.replace(/[\r\n]/g, ""))}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    clearTimeout(timer);
    controller.abort();
    if (e instanceof AppError) throw e;
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      "Asset download timed out.",
      503,
      true,
    );
  }
}
