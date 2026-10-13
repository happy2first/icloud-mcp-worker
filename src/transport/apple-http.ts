import { AppError, requireValue } from "../errors.ts";
import { CookieJar } from "./cookie-jar.ts";

export const APPLE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15";
// Pinned pyicloud carries this browser context across setup, PCS and CloudKit.
export const appleWebHeaders = () => ({
  "User-Agent": APPLE_USER_AGENT,
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://www.icloud.com",
  Referer: "https://www.icloud.com/",
});

const fixed = new Set([
  "idmsa.apple.com",
  "setup.icloud.com",
  "www.icloud.com",
]);
export function validatedAppleURL(value: string, discovered = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned an invalid service address.",
    );
  }
  requireValue(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443"),
    "Only validated Apple HTTPS services are allowed.",
  );
  const service =
    discovered &&
    ((/^(?:p\d{1,3}-)?fmipweb\.icloud\.com(?:\.cn)?$/.test(url.hostname) &&
      /^\/fmipservice\/client\/web\/(?:initClient|refreshClient|playSound)$/.test(
        url.pathname,
      )) ||
      (/^p\d{1,3}-ckdatabasews\.icloud\.com$/.test(url.hostname) &&
        /^\/database\/1\/(?:com\.apple\.notes|com\.apple\.photos\.cloud)\/production\/private\/(?:records\/(?:query|lookup)|zones\/list|changes\/zone)$/.test(
          url.pathname,
        )) ||
      (/^p\d{1,3}-drivews\.icloud\.com$/.test(url.hostname) &&
        url.pathname === "/retrieveItemDetailsInFolders") ||
      (/^p\d{1,3}-docws\.icloud\.com$/.test(url.hostname) &&
        /^\/ws\/com\.apple\.CloudDocs\/download\/by_id$/.test(url.pathname)));
  const cloudkit =
    /^p\d{1,3}-ckdatabasews\.icloud\.com$/.test(url.hostname) &&
    (/^\/database\/1\/com\.apple\.reminders\/production\/private(?:\/|$)/.test(
      url.pathname,
    ) ||
      /^\/database\/1\/com\.apple\.reminders\/production\/shared\/(?:zones\/list|records\/lookup)$/.test(
        url.pathname,
      ));
  requireValue(
    fixed.has(url.hostname) || service || (discovered && cloudkit),
    "The service address is outside the supported Apple endpoints.",
  );
  requireValue(!url.hash, "Apple service addresses cannot contain fragments.");
  return url;
}
export async function limitedBytes(
  response: Response,
  limit = 1_048_576,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new AppError(
      "PROTOCOL_CHANGED",
      "The Apple response exceeded the byte budget.",
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit)
        throw new AppError(
          "PROTOCOL_CHANGED",
          "The Apple response exceeded the byte budget.",
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export class AppleHTTP {
  readonly jar: CookieJar;
  readonly send: typeof fetch;
  readonly signal?: AbortSignal;
  constructor(
    jar = new CookieJar(),
    send: typeof fetch = fetch,
    signal?: AbortSignal,
  ) {
    this.jar = jar;
    this.send = send.bind(globalThis);
    this.signal = signal;
  }
  async request(
    value: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      headers?: HeadersInit;
      body?: string;
      discovered?: boolean;
      signal?: AbortSignal;
      followRedirects?: boolean;
    } = {},
  ) {
    let url = validatedAppleURL(value, options.discovered);
    let method = options.method ?? "GET";
    let body = options.body;
    const headers = new Headers(options.headers);
    headers.delete("cookie");
    headers.delete("authorization");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const cancelled = () => controller.abort();
    const signal = options.signal ?? this.signal;
    if (signal?.aborted) cancelled();
    else signal?.addEventListener("abort", cancelled, { once: true });
    try {
      for (let hop = 0; hop <= 3; hop++) {
        const currentHeaders = new Headers(headers);
        const cookie = this.jar.header(url);
        if (cookie) currentHeaders.set("cookie", cookie);
        const response = await this.send(url, {
          method,
          body,
          headers: currentHeaders,
          redirect: "manual",
          signal: controller.signal,
        });
        // getSetCookie preserves commas inside Expires; fail rather than split a combined header.
        if (
          response.headers.has("set-cookie") &&
          typeof response.headers.getSetCookie !== "function"
        )
          throw new AppError(
            "UNSUPPORTED_FEATURE",
            "This runtime cannot preserve separate Apple cookies.",
          );
        for (const line of response.headers.getSetCookie?.() ?? [])
          this.jar.set(line, url);
        if (
          options.followRedirects !== false &&
          [301, 302, 303, 307, 308].includes(response.status)
        ) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          requireValue(
            location && hop < 3,
            "The Apple redirect budget was exceeded.",
          );
          const next = validatedAppleURL(
            new URL(location, url).href,
            options.discovered,
          );
          // Redirects must never carry proofs, cookies, or per-session headers to a new origin.
          requireValue(
            next.origin === url.origin,
            "Apple requested an unsupported cross-origin redirect.",
          );
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) &&
              method === "POST")
          ) {
            method = "GET";
            body = undefined;
            headers.delete("content-type");
          }
          url = next;
          continue;
        }
        const bytes = await limitedBytes(response);
        return { status: response.status, headers: response.headers, bytes };
      }
      throw new AppError(
        "PROTOCOL_CHANGED",
        "The Apple redirect budget was exceeded.",
      );
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Apple could not be reached within the request budget.",
        503,
        true,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
    }
  }
}
