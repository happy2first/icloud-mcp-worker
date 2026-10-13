import { AppError, publicError } from "../errors.ts";
import { hex } from "../crypto/bytes.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
import { AppleSessionRepository } from "../persistence/apple-sessions.ts";
import { requireAppleEnabled } from "./gates.ts";
import { AppleAuthHTTP } from "./apple/http.ts";
import { AppleSignInFlow } from "./apple/flow.ts";
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
  if (
    query.size !== 1 ||
    !/^(0|[1-9][0-9]{0,15})$/.test(generation) ||
    !Number.isSafeInteger(Number(generation))
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "Refresh connection status before starting sign-in.",
    );
  const repository = new AppleSessionRepository(env, owner);
  const fence = await repository.begin(Number(generation));
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
    new AppleAuthHTTP(undefined, undefined, abort.signal),
    abort.signal,
    async (session, result) => {
      if (abort.signal.aborted || closed())
        throw new AppError(
          "RESTART_REQUIRED",
          "The connection was lost. Restart sign-in.",
          409,
        );
      await repository.commit(
        fence,
        session,
        result.state,
        result.state === "DEVICE_APPROVAL_PENDING" ? result.action : undefined,
      );
    },
  );
  const clean = () => {
    if (closed()) return;
    const successful = phase === "complete";
    phase = "closed";
    clearTimeout(timer);
    abort.abort();
    flow.close();
    if (!successful)
      void repository.abandon(fence).catch(() => {
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
