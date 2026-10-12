import { AppError } from "../errors.ts";
import { buffer } from "../crypto/bytes.ts";
import { validatedPushURL } from "./apple-push.ts";
import { APPLE_USER_AGENT } from "../auth/apple/http.ts";

export interface BinaryChannel {
  send(bytes: Uint8Array): void;
  receive(timeoutMs?: number): Promise<Uint8Array>;
  close(): void;
}
export type PushConnector = (
  url: string,
  signal: AbortSignal,
) => Promise<BinaryChannel>;

// The caller owns one bounded interactive lifetime. No queue, waitUntil,
// checkpoint restore or persistent background socket is used.
export async function connectApplePush(
  value: string,
  signal: AbortSignal,
  send: typeof fetch = fetch,
): Promise<BinaryChannel> {
  const url = validatedPushURL(value);
  if (!/^\/v2\/[0-9a-f]{2,4096}$/.test(url.pathname) || url.search)
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Unsupported Apple bridge bootstrap address.",
    );
  url.protocol = "https:";
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 15_000);
  let socket: WebSocket | undefined;
  try {
    if (signal.aborted) throw new Error("cancelled");
    const reply = await send(url.href, {
      headers: {
        Upgrade: "websocket",
        Origin: "https://idmsa.apple.com",
        "User-Agent": APPLE_USER_AGENT,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (reply.status !== 101 || !reply.webSocket) {
      await reply.body?.cancel();
      throw new Error("upgrade-failed");
    }
    socket = reply.webSocket;
    socket.binaryType = "arraybuffer";
  } catch {
    signal.removeEventListener("abort", abort);
    throw new AppError(
      "RESTART_REQUIRED",
      "Apple's verification socket could not be opened. Restart setup.",
      409,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
  signal.removeEventListener("abort", abort);
  const channel = binaryChannel(socket, signal);
  socket.accept();
  return channel;
}

export function binaryChannel(
  socket: WebSocket,
  signal: AbortSignal,
): BinaryChannel {
  const queued: Uint8Array[] = [];
  let waiting: {
    resolve(bytes: Uint8Array): void;
    reject(error: AppError): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let ended = false;
  let received = 0;
  const failure = () =>
    new AppError(
      "RESTART_REQUIRED",
      "The verification socket ended or exceeded its budget. Restart sign-in.",
      409,
      true,
    );
  const close = () => {
    if (ended) return;
    ended = true;
    signal.removeEventListener("abort", close);
    for (const bytes of queued) bytes.fill(0);
    queued.length = 0;
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.reject(failure());
      waiting = null;
    }
    try {
      socket.close(1000, "Authentication channel ended.");
    } catch {
      /* Never expose the nonce URL or a raw socket error. */
    }
  };
  socket.addEventListener("close", close);
  socket.addEventListener("error", close);
  socket.addEventListener("message", (event) => {
    if (ended) return;
    if (
      !(event.data instanceof ArrayBuffer) ||
      !event.data.byteLength ||
      event.data.byteLength > 65_536 ||
      ++received > 64
    ) {
      close();
      return;
    }
    const bytes = new Uint8Array(event.data);
    if (waiting) {
      const next = waiting;
      waiting = null;
      clearTimeout(next.timer);
      next.resolve(bytes);
    } else if (queued.length < 8) queued.push(bytes);
    else {
      bytes.fill(0);
      close();
    }
  });
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return {
    send(bytes) {
      if (ended || !bytes.length || bytes.length > 65_536) throw failure();
      try {
        socket.send(buffer(bytes));
      } catch {
        close();
        throw failure();
      }
    },
    receive(timeoutMs = 30_000) {
      if (
        ended ||
        waiting ||
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 30_000
      )
        return Promise.reject(failure());
      const next = queued.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve, reject) => {
        waiting = {
          resolve,
          reject,
          timer: setTimeout(() => close(), timeoutMs),
        };
      });
    },
    close,
  };
}
