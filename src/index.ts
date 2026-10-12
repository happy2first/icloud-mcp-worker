import {
  cloudflareAccessFetch,
  type CloudflareAccessEnv,
} from "./platform/cloudflare-access.ts";
import { requireOwner, requireSameOrigin } from "./platform/sites.ts";
import { applicationRoute } from "./api/router.ts";
import { adminPage } from "./admin.ts";
import { limitedBytes } from "./transport/apple-http.ts";
import { AppError, publicError } from "./errors.ts";
import { z } from "zod";
import {
  configs,
  CredentialInput,
  saveCredentials,
  db,
  requireService,
  rateLimit,
  ServiceName,
} from "./services/config.ts";
import { serviceStatus } from "./services/status.ts";
import { webOperation } from "./services/web.ts";
import { DavClient } from "./services/dav.ts";
import { NotesClient } from "./services/notes.ts";
import { PhotosClient } from "./services/photos.ts";
import { DriveClient } from "./services/drive.ts";
import { AppleConnectionService } from "./auth/service.ts";
import { download } from "./services/downloads.ts";
import client from "./client.generated.ts";
import adminScript from "./admin.generated.ts";
const worker = {
  async fetch(request: Request, env: CloudflareAccessEnv) {
    return cloudflareAccessFetch(request, env, async (authenticated) => {
      try {
        const path = new URL(authenticated.url).pathname;
        if (path === "/api/bootstrap/identity")
          return (await applicationRoute(authenticated, env, client))!;
        const owner = requireOwner(authenticated, env);
        if (["/", "/admin"].includes(path) && authenticated.method === "GET")
          return adminPage(adminScript);
        if (path.startsWith("/download/") && authenticated.method === "GET") {
          await rateLimit(env, owner);
          return await download(env, owner, path.slice(10));
        }
        if (
          path === "/mcp" ||
          path === "/api/apple/read" ||
          path.startsWith("/api/auth/")
        )
          await rateLimit(env, owner);
        if (path === "/api/apple/read")
          await requireService(env, owner, "reminders");
        if (path === "/api/admin/status" && authenticated.method === "GET")
          return Response.json(await serviceStatus(env, owner), {
            headers: { "cache-control": "private, no-store" },
          });
        if (path.startsWith("/api/admin/") && authenticated.method === "POST") {
          requireSameOrigin(authenticated, env);
          await rateLimit(env, owner);
          let value: unknown;
          try {
            value = JSON.parse(
              new TextDecoder().decode(
                await limitedBytes(new Response(authenticated.body), 16384),
              ),
            );
          } catch {
            throw new AppError("VALIDATION_ERROR", "Supply bounded JSON.");
          }
          let result: unknown;
          if (path === "/api/admin/credentials") {
            result = await saveCredentials(
              env,
              owner,
              CredentialInput.parse(value),
            );
          } else if (path === "/api/admin/remove-credentials") {
            const { expectedVersion } = z
              .object({ expectedVersion: z.number().int().positive().safe() })
              .strict()
              .parse(value);
            const deleted = await db(env)
              .prepare("DELETE FROM credentials WHERE owner_id=? AND version=?")
              .bind(owner, expectedVersion)
              .run();
            if (deleted.meta.changes !== 1)
              throw new AppError(
                "CONFLICT",
                "Credentials changed. Refresh before removing them.",
                409,
              );
            result = { removed: true };
          } else if (path === "/api/admin/service") {
            const c = z
              .object({
                service: ServiceName,
                enabled: z.boolean(),
                writable: z.boolean(),
              })
              .strict()
              .parse(value);
            if (!c.enabled && c.writable)
              throw new AppError(
                "VALIDATION_ERROR",
                "Disabled services cannot retain write permission.",
              );
            if (c.writable && ["notes", "photos", "drive"].includes(c.service))
              throw new AppError(
                "FORBIDDEN",
                "This service is read-only.",
                403,
              );
            await db(env)
              .prepare(
                "INSERT INTO service_config VALUES(?,?,?,?) ON CONFLICT(owner_id,service) DO UPDATE SET enabled=excluded.enabled,writable=excluded.writable",
              )
              .bind(owner, c.service, Number(c.enabled), Number(c.writable))
              .run();
            result = await configs(env, owner);
          } else if (path === "/api/admin/pcs") {
            const c = z
              .object({ service: z.enum(["notes3", "photos", "iclouddrive"]) })
              .strict()
              .parse(value);
            result = await webOperation(
              env,
              owner,
              c.service,
              async () => ({}),
              true,
            );
          } else if (path === "/api/admin/check") {
            const c = z.object({ service: ServiceName }).strict().parse(value);
            await requireService(env, owner, c.service);
            if (c.service === "calendar" || c.service === "contacts") {
              await (await DavClient.for(env, owner, c.service)).discover();
            } else if (c.service === "reminders") {
              const apple = new AppleConnectionService(env, owner);
              await apple.getCurrentLists((await apple.status()).generation);
            } else if (c.service === "notes") {
              await webOperation(env, owner, "notes3", (w) =>
                new NotesClient(w).list(1),
              );
            } else if (c.service === "photos") {
              await webOperation(env, owner, "photos", (w) =>
                new PhotosClient(w).albums(1),
              );
            } else {
              await webOperation(env, owner, "iclouddrive", (w) =>
                new DriveClient(w).browse(undefined, 0, 1),
              );
            }
            result = {
              service: c.service,
              liveReadPassed: true,
              checkedAt: Date.now(),
            };
          } else
            throw new AppError(
              "VALIDATION_ERROR",
              "Unknown management operation.",
            );
          return Response.json(result, {
            headers: { "cache-control": "private, no-store" },
          });
        }
        const response = await applicationRoute(authenticated, env, client);
        return response ?? new Response("Not found", { status: 404 });
      } catch (e) {
        const error =
          e instanceof z.ZodError
            ? new AppError("VALIDATION_ERROR", "Invalid management request.")
            : e;
        return Response.json(
          { error: publicError(error, crypto.randomUUID()) },
          {
            status: error instanceof AppError ? error.status : 503,
            headers: { "cache-control": "private, no-store" },
          },
        );
      }
    });
  },
};
export default worker;
