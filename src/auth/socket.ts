import { AppError, publicError } from "../errors.ts";
import { hex } from "../crypto/bytes.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { AppleSessionRepository } from "../persistence/apple-sessions.ts";
import { requireAppleEnabled } from "./gates.ts";
import { AppleAuthHTTP } from "./apple/http.ts";
import { AppleSignInFlow } from "./apple/flow.ts";
import { requireCurrentLogin } from "./apple/policy.ts";
import { FindMyClient } from "../services/findmy.ts";
import { FindMySignInRequired, WebClient } from "../services/web.ts";
import {
  APPLE_AUTH_PROTOCOL,
  AUTH_LIFETIME_MS,
  AuthMessage,
  StartMessage,
} from "./apple/protocol.ts";

export async function appleAuthSocket(
  request: Request,
  env: RuntimeEnv,
  owner: string,
): Promise<Response> {
  // All live gates precede body parsing, state changes and Apple requests.
  requireAppleEnabled(env);
  if (
    request.method !== "GET" ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket"
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "A secure WebSocket upgrade is required.",
      426,
    );
  if (
    request.headers.get("origin") !== env.APP_ORIGIN ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError(
      "FORBIDDEN",
      "Use this private Site's connection form.",
      403,
    );
  if (request.headers.get("sec-websocket-protocol") !== APPLE_AUTH_PROTOCOL)
    throw new AppError(
      "VALIDATION_ERROR",
      "Use the supported Apple connection protocol.",
    );
  const query = new URL(request.url).searchParams;
  const generation = query.get("generation") ?? "";
  const findMy = query.get("service") === "findmy";
  if (
    query.size !==
      1 + Number(query.has("region")) + Number(query.has("service")) ||
    query.getAll("generation").length !== 1 ||
    query.getAll("region").length > 1 ||
    query.getAll("service").length > 1 ||
    (query.has("service") && !findMy) ||
    [...query.keys()].some(
      (key) => !["generation", "region", "service"].includes(key),
    ) ||
    (query.has("region") &&
      !["cn", "international"].includes(query.get("region")!)) ||
    !/^(0|[1-9][0-9]{0,15})$/.test(generation) ||
    !Number.isSafeInteger(Number(generation))
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "Refresh connection status before starting sign-in.",
    );
  const repository = new AppleSessionRepository(env, owner);
  const existing = findMy ? await repository.load() : null;
  if (existing) {
    requireCurrentLogin(existing.session.login);
    if (existing.fence.generation !== Number(generation))
      throw new AppError(
        "CONFLICT",
        "The saved Apple account changed; reopen Find My verification.",
        409,
      );
  }
  // Reauthentication is isolated: never begin()/replace the working account.
  const fence = existing
    ? {
        transactionId: crypto.randomUUID(),
        generation: existing.fence.generation + 1,
        expiresAt: Date.now() + AUTH_LIFETIME_MS,
      }
    : await repository.begin(Number(generation));
  const [client, server] = Object.values(new WebSocketPair());
  const abort = new AbortController();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
  let phase: "start" | "waiting" | "busy" | "complete" | "closed" = "start";
  let sequence = 0;
  let serverSequence = 0;
  let messages = 0;
  const send = (value: object) =>
    server.send(
      JSON.stringify({
        ...value,
        direction: "server",
        transactionId: fence.transactionId,
        nonce,
        sequence: serverSequence++,
      }),
    );
  const closed = () => phase === "closed";
  const flow = new AppleSignInFlow(
    existing
      ? AppleAuthHTTP.forFindMyVerification(
          existing.session.auth,
          fetch,
          abort.signal,
        )
      : new AppleAuthHTTP(
          undefined,
          undefined,
          abort.signal,
          query.get("region") === "cn" ? "cn" : "international",
        ),
    abort.signal,
    async (session, result) => {
      if (abort.signal.aborted || closed())
        throw new AppError(
          "RESTART_REQUIRED",
          "The connection was lost. Restart sign-in.",
          409,
        );
      if (existing) {
        const current = await repository.load();
        requireCurrentLogin(current.session.login);
        if (
          current.fence.generation !== existing.fence.generation ||
          session.connection.dsid !== current.session.connection.dsid
        )
          throw new AppError(
            "CONFLICT",
            "Apple account changed during Find My verification. Original credentials preserved.",
            409,
          );
        const writeFence = await repository.claimRenewal(
          current.fence.generation,
          current.fence.version,
        );
        try {
          const candidate = {
            ...current.session,
            auth: session.auth,
            connection: session.connection,
          };
          // A password proof is not proof of service access: perform the real read.
          const verifiedHTTP = AppleAuthHTTP.restore(
            candidate.auth,
            fetch,
            abort.signal,
          );
          try {
            await new FindMyClient(
              new WebClient(verifiedHTTP, candidate),
            ).list();
          } catch (error) {
            if (error instanceof FindMySignInRequired)
              throw new AppError(
                "REAUTH_REQUIRED",
                error.diagnostic +
                  " Find My rejected the new password-verified session (authContext=fresh; staleSessionReused=false). Original saved credentials preserved. Do not repeat verification continuously; HTTP 450 alone cannot identify the cause. Check the official iCloud Find My page for account requirements and report this safe diagnostic. No sound request was sent.",
                409,
              );
            throw error;
          }
          if (abort.signal.aborted || closed())
            throw new AppError(
              "RESTART_REQUIRED",
              "Find My verification was cancelled; original credentials preserved.",
              409,
            );
          await repository.commitResume(
            writeFence,
            {
              ...candidate,
              auth: verifiedHTTP.snapshot(),
              // Preserve retention and PCS metadata; no assurance deadline extension.
              renewal: current.session.renewal
                ? {
                    ...current.session.renewal,
                    lastAppleSuccessAt: Date.now(),
                    findMyRecovery: undefined,
                  }
                : undefined,
            },
            current.state,
            current.action ?? undefined,
          );
        } finally {
          await repository.releaseResume(writeFence);
        }
        return;
      }
      await repository.commit(
        fence as Awaited<ReturnType<AppleSessionRepository["begin"]>>,
        session,
        result.state,
        result.state === "DEVICE_APPROVAL_PENDING" ? result.action : undefined,
      );
    },
    undefined,
    undefined,
    existing?.session.connection.dsid,
  );
  const clean = () => {
    if (closed()) return;
    const successful = phase === "complete";
    phase = "closed";
    clearTimeout(timer);
    abort.abort();
    flow.close();
    if (!successful && !existing)
      void repository
        .abandon(fence as Awaited<ReturnType<AppleSessionRepository["begin"]>>)
        .catch(() => {
          /* Lease expiry and fences still prevent stale writes. */
        });
  };
  const finish = (code: number, reason: string) => {
    clean();
    try {
      server.close(code, reason);
    } catch {
      /* Closed peer. */
    }
  };
  const fail = (error: unknown) => {
    if (closed()) return;
    const safe = publicError(error, crypto.randomUUID());
    try {
      send({ type: "failed", error: safe });
    } catch {
      /* No raw Apple error material is logged. */
    }
    finish(1008, "Restart sign-in from the secure setup page.");
  };
  server.accept();
  server.addEventListener("close", clean);
  server.addEventListener("error", () =>
    finish(1011, "The connection was lost. Restart sign-in."),
  );
  server.addEventListener("message", (event) => {
    void (async () => {
      if (closed() || phase === "complete") return;
      if (
        ++messages > 12 ||
        typeof event.data !== "string" ||
        event.data.length > 8192
      )
        throw new AppError(
          "VALIDATION_ERROR",
          "The sign-in message exceeded the supported budget.",
        );
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        throw new AppError("VALIDATION_ERROR", "Invalid sign-in message.");
      }
      if (phase === "start") {
        const start = StartMessage.safeParse(value);
        if (!start.success)
          throw new AppError(
            "VALIDATION_ERROR",
            "Use the secure sign-in form. Passwords and derived keys must remain in the browser.",
          );
        if (
          start.data.transactionId !== fence.transactionId ||
          start.data.nonce !== nonce ||
          start.data.sequence !== sequence++
        )
          throw new AppError(
            "RESTART_REQUIRED",
            "This sign-in message belongs to another attempt.",
            409,
          );
        phase = "busy";
        const result = await flow.start(start.data);
        if (closed() || abort.signal.aborted) return;
        phase = "waiting";
        send(result);
        return;
      }
      const message = AuthMessage.safeParse(value);
      if (
        !message.success ||
        message.data.transactionId !== fence.transactionId ||
        message.data.nonce !== nonce ||
        message.data.sequence !== sequence
      )
        throw new AppError(
          "RESTART_REQUIRED",
          "This sign-in message is stale or belongs to another attempt.",
          409,
        );
      sequence++;
      if (message.data.type === "cancel") {
        finish(1000, "Sign-in cancelled.");
        return;
      }
      if (phase !== "waiting")
        throw new AppError(
          "RESTART_REQUIRED",
          "A sign-in step is already running. Restart sign-in.",
          409,
        );
      phase = "busy";
      const result = await flow.advance(message.data);
      if (closed() || abort.signal.aborted) return;
      if (result.type === "complete") {
        send(result);
        phase = "complete";
        finish(1000, "Apple session saved.");
      } else {
        phase = "waiting";
        send(result);
      }
    })().catch(fail);
  });
  const timer = setTimeout(
    () =>
      fail(
        new AppError(
          "AUTH_EXPIRED",
          "Sign-in exceeded its interactive lifetime. Restart sign-in; a stored checkpoint cannot restore the socket.",
          409,
        ),
      ),
    Math.max(1, fence.expiresAt - Date.now()),
  );
  send({
    type: "hello",
    generation: fence.generation,
    expiresAt: fence.expiresAt,
    lifetimeMs: AUTH_LIFETIME_MS,
  });
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      "sec-websocket-protocol": APPLE_AUTH_PROTOCOL,
      "cache-control": "private, no-store",
    },
  });
}
