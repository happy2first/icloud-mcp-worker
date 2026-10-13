import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AppError, UpstreamRateLimitedError } from "../errors.ts";
import { limitedBytes } from "../transport/apple-http.ts";
import { retrySeconds } from "./web.ts";
import { loadCredentials } from "./config.ts";
import type { RuntimeEnv } from "../platform/sites.ts";
export type DavKind = "calendar" | "contacts";
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  processEntities: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (n) => n === "response" || n === "propstat",
});
export const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
// With attributes enabled, <href xmlns="DAV:">...</href> is an object,
// while <d:href>...</d:href> is a string. Never stringify it as [object Object].
function hrefText(value: unknown): string {
  const text = typeof value === "string" ? value :
    value && typeof value === "object" && "#text" in value ? (value as any)["#text"] : undefined;
  if (typeof text !== "string" || !text.trim())
    throw new AppError("PROTOCOL_CHANGED", "DAV response omitted a valid resource href.");
  return text.trim();
}
export function davURL(value: string, kind: DavKind) {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new AppError("VALIDATION_ERROR", "DAV resource address is malformed.");
  }
  const host =
    kind === "calendar"
      ? /^(?:caldav|p\d{1,3}-caldav)\.icloud\.com(?:\.cn)?$/
      : /^(?:contacts|p\d{1,3}-contacts)\.icloud\.com(?:\.cn)?$/;
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    u.hash ||
    u.search ||
    !host.test(u.hostname)
  )
    throw new AppError(
      "VALIDATION_ERROR",
      "DAV resource rejected: expected this service's Apple HTTPS endpoint in icloud.com or icloud.com.cn, without credentials, a nonstandard port, query or fragment.",
    );
  return u;
}
export function parseMulti(text: string) {
  if (
    text.includes("<!DOCTYPE") ||
    text.includes("<!ENTITY") ||
    XMLValidator.validate(text) !== true
  )
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple returned unsupported DAV XML.",
    );
  const v = parser.parse(text);
  if (
    !Object.hasOwn(v, "multistatus") ||
    (v.multistatus?.response !== undefined &&
      !Array.isArray(v.multistatus.response))
  )
    throw new AppError(
      "PROTOCOL_CHANGED",
      "Apple omitted DAV multistatus records.",
    );
  return (v.multistatus?.response ?? []).map((r: any) => ({
    href: hrefText(r.href),
    props: Object.assign(
      {},
      ...(r.propstat ?? [])
        .filter((p: any) => String(p.status).includes(" 200 "))
        .map((p: any) => p.prop),
    ),
  }));
}
export class DavClient {
  constructor(
    readonly kind: DavKind,
    readonly credentials: { account: string; password: string },
    readonly send: typeof fetch = fetch,
    readonly signal?: AbortSignal,
  ) {}
  static async for(env: RuntimeEnv, owner: string, kind: DavKind) {
    return new DavClient(kind, await loadCredentials(env, owner));
  }
  async request(
    value: string,
    method: string,
    body?: string,
    extra: Record<string, string> = {},
  ) {
    let url = davURL(value, this.kind);
    const auth =
      "Basic " +
      btoa(
        String.fromCharCode(
          ...new TextEncoder().encode(
            this.credentials.account + ":" + this.credentials.password,
          ),
        ),
      );
    const signal = this.signal
      ? AbortSignal.any([this.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);
    const visited = new Set<string>();
    try {
      for (let hop = 0; hop < 4; hop++) {
        if (visited.has(url.href))
          throw new AppError("APPLE_REDIRECT_ERROR", `DAV ${this.kind} ${method}: redirect loop.`, 409);
        visited.add(url.href);
        const r = await this.send.call(globalThis, url, {
          method,
          body,
          headers: {
            Authorization: auth,
            "Content-Type":
              method === "PUT"
                ? this.kind === "calendar"
                  ? "text/calendar; charset=utf-8"
                  : "text/vcard; charset=utf-8"
                : "application/xml; charset=utf-8",
            ...extra,
          },
          redirect: "manual",
          signal,
        });
        if ([301, 302, 307, 308].includes(r.status)) {
          const location = r.headers.get("location");
          await r.body?.cancel();
          if (!location || hop === 3)
            throw new AppError(
              "APPLE_REDIRECT_ERROR",
              `DAV ${this.kind} ${method}: ${!location ? "redirect omitted Location" : "redirect limit exceeded"} (HTTP ${r.status}).`,
            );
          url = davURL(new URL(location, url).href, this.kind);
          continue;
        }
        if (r.status === 401)
          throw new AppError(
            "REAUTH_REQUIRED",
            `DAV ${this.kind} ${method}: Apple rejected the app-specific password (HTTP 401). Check the Apple account and password in /admin.`,
            409,
          );
        if (r.status === 403)
          throw new AppError("FORBIDDEN", "Apple denied DAV access.", 403);
        if (r.status === 412)
          throw new AppError(
            "CONFLICT",
            "DAV version changed or creation ID already exists. Read before retrying.",
            409,
          );
        if (r.status === 429)
          throw new UpstreamRateLimitedError(
            retrySeconds(r.headers.get("retry-after")),
          );
        if (!r.ok) {
          if (method === "PUT" || method === "DELETE")
            throw new AppError(
              "WRITE_OUTCOME_UNKNOWN",
              "Write may have committed. Read the exact resource before retrying.",
              503,
            );
          throw new AppError(
            "UPSTREAM_UNAVAILABLE",
            `DAV ${this.kind} ${method}: Apple returned HTTP ${r.status}.`,
            503,
            true,
          );
        }
        return {
          url: url.href,
          status: r.status,
          etag: r.headers.get("etag"),
          text: new TextDecoder().decode(await limitedBytes(r, 2097152)),
        };
      }
      throw new AppError("PROTOCOL_CHANGED", "DAV redirect budget exceeded.");
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        method === "PUT" || method === "DELETE"
          ? "WRITE_OUTCOME_UNKNOWN"
          : "UPSTREAM_UNAVAILABLE",
        method === "PUT" || method === "DELETE"
          ? "Write outcome unknown. Read the exact resource before retrying."
          : `DAV ${this.kind} ${method}: ${signal.aborted ? "request budget exceeded" : "network connection failed"}. Retry later.`,
        503,
      );
    }
  }
  async propfind(url: string, props: string, depth = "0") {
    const r = await this.request(
      url,
      "PROPFIND",
      `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="urn:ietf:params:xml:ns:carddav"><d:prop>${props}</d:prop></d:propfind>`,
      { Depth: depth },
    );
    return parseMulti(r.text).map((x: any) => ({
      ...x,
      href: davURL(new URL(x.href, r.url).href, this.kind).href,
    }));
  }
  async discover() {
    // Bound all discovery stages, including the one read-only regional fallback.
    const signal = this.signal
      ? AbortSignal.any([this.signal, AbortSignal.timeout(40000)])
      : AbortSignal.timeout(40000);
    return new DavClient(this.kind, this.credentials, this.send, signal).discoverWithinBudget();
  }
  private async discoverWithinBudget() {
    const root =
      this.kind === "calendar"
        ? "https://caldav.icloud.com/"
        : "https://contacts.icloud.com/";
    let principal;
    try {
      principal = await this.propfind(root, "<d:current-user-principal/>");
    } catch (e) {
      // Chinese CardDAV accounts may require the regional bootstrap directly.
      // Do not retry writes, protocol errors, rate limits or arbitrary endpoints.
      if (!(e instanceof AppError) || !["REAUTH_REQUIRED", "FORBIDDEN", "UPSTREAM_UNAVAILABLE"].includes(e.code) || this.signal?.aborted) throw e;
      principal = await this.propfind(root.replace(".com/", ".com.cn/"), "<d:current-user-principal/>");
    }
    const principalRecord = principal.find((x: any) => x.props["current-user-principal"]?.href);
    const href = principalRecord?.props["current-user-principal"]?.href;
    if (!href)
      throw new AppError("PROTOCOL_CHANGED", "Apple omitted DAV principal.");
    const home = await this.propfind(
      new URL(hrefText(href), principalRecord.href).href,
      this.kind === "calendar"
        ? "<c:calendar-home-set/>"
        : "<a:addressbook-home-set/>",
    );
    const homeProperty = this.kind === "calendar" ? "calendar-home-set" : "addressbook-home-set";
    const homeRecord = home.find((x: any) => x.props[homeProperty]?.href);
    const h = homeRecord?.props[homeProperty]?.href;
    if (!h)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple omitted DAV home collection.",
      );
    const resolved = new URL(hrefText(h), homeRecord.href).href;
    const collections = await this.propfind(
      resolved,
      "<d:displayname/><d:resourcetype/>",
      "1",
    );
    return {
      collections: collections
        .filter(
          (x: any) =>
            x.props.resourcetype?.[
              this.kind === "calendar" ? "calendar" : "addressbook"
            ] !== undefined,
        )
        .map((x: any) => ({ url: x.href, name: x.props.displayname ?? "" })),
    };
  }
  async query(collection: string, start?: string, end?: string) {
    const isCal = this.kind === "calendar";
    if (isCal && (!start || !end))
      throw new AppError(
        "VALIDATION_ERROR",
        "Specify start and end UTC dates.",
      );
    const range = isCal
      ? `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${xml(start!)}" end="${xml(end!)}"/></c:comp-filter></c:comp-filter>`
      : "<c:filter/>";
    const name = isCal ? "calendar" : "addressbook",
      dataName = isCal ? "calendar-data" : "address-data",
      ns = isCal ? "caldav" : "carddav";
    const r = await this.request(
      collection,
      "REPORT",
      `<c:${name}-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:${ns}"><d:prop><d:getetag/><c:${dataName}/></d:prop>${range}</c:${name}-query>`,
      { Depth: "1" },
    );
    return parseMulti(r.text).map((x: any) => {
      if (
        typeof x.props[dataName] !== "string" ||
        typeof x.props.getetag !== "string"
      )
        throw new AppError(
          "PROTOCOL_CHANGED",
          "Apple omitted requested DAV data or ETag; no incomplete query result is returned.",
        );
      return {
        url: davURL(new URL(x.href, r.url).href, this.kind).href,
        etag: x.props.getetag,
        data: x.props[dataName],
      };
    });
  }
  async get(url: string) {
    return this.request(url, "GET");
  }
  async put(url: string, data: string, etag?: string) {
    return this.request(
      url,
      "PUT",
      data,
      etag ? { "If-Match": etag } : { "If-None-Match": "*" },
    );
  }
  async delete(url: string, etag: string) {
    return this.request(url, "DELETE", undefined, { "If-Match": etag });
  }
}
export function escapeText(s: string) {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}
export function foldLines(lines: string[]) {
  return (
    lines
      .map((line) => {
        let out = "",
          width = 0;
        for (const c of line) {
          const n = new TextEncoder().encode(c).length;
          if (width + n > 75) {
            out += "\r\n ";
            width = 1;
          }
          out += c;
          width += n;
        }
        return out;
      })
      .join("\r\n") + "\r\n"
  );
}
export function calendarData(input: {
  uid: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
}) {
  return foldLines([
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//icloud-mcp-worker//EN",
    "BEGIN:VEVENT",
    "UID:" + input.uid,
    "DTSTAMP:" +
      new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z/, "Z"),
    "DTSTART:" + input.start,
    "DTEND:" + input.end,
    "SUMMARY:" + escapeText(input.title),
    ...(input.description !== undefined
      ? ["DESCRIPTION:" + escapeText(input.description)]
      : []),
    ...(input.location !== undefined
      ? ["LOCATION:" + escapeText(input.location)]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ]);
}
export function contactData(input: {
  uid: string;
  name: string;
  email?: string;
  phone?: string;
}) {
  return foldLines([
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:" + input.uid,
    "FN:" + escapeText(input.name),
    "N:;" + escapeText(input.name) + ";;;",
    ...(input.email ? ["EMAIL:" + escapeText(input.email)] : []),
    ...(input.phone ? ["TEL:" + escapeText(input.phone)] : []),
    "END:VCARD",
  ]);
}

/** Replace only explicitly supplied fields in one unambiguous component. */
export function updateDavData(kind: DavKind, text: string, changes: any) {
  const lines = text
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter(Boolean);
  const target = kind === "calendar" ? "VEVENT" : "VCARD";
  const name = (line: string) =>
    line.split(/[;:]/)[0].split(".").at(-1)!.toUpperCase();
  const begins = lines.filter((l) => l.toUpperCase() === "BEGIN:" + target);
  if (
    begins.length !== 1 ||
    lines.filter((l) => l.toUpperCase() === "END:" + target).length !== 1
  )
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "Ambiguous DAV component. Use the Apple app.",
      409,
    );
  if (
    kind === "calendar" &&
    lines.some((l) =>
      [
        "RRULE",
        "RDATE",
        "EXDATE",
        "RECURRENCE-ID",
        "ORGANIZER",
        "ATTENDEE",
      ].includes(name(l)),
    )
  )
    throw new AppError(
      "UNSUPPORTED_FEATURE",
      "Recurring or invitation event edits are unsupported. Use Apple Calendar.",
      409,
    );
  let depth = 0;
  const properties: string[] = [];
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:" + target) depth = 1;
    else if (upper.startsWith("BEGIN:") && depth) depth++;
    else if (upper.startsWith("END:") && depth) depth--;
    else if (depth === 1) properties.push(line);
  }
  const uidLines = properties.filter((l) => name(l) === "UID");
  if (uidLines.length !== 1 || !uidLines[0].split(":").slice(1).join(":"))
    throw new AppError("PROTOCOL_CHANGED", "DAV resource has no unique UID.");
  // UID is preserved from the original, never decoded and re-serialized.
  const updated =
    kind === "calendar"
      ? calendarData({
          uid: "unused",
          title: "",
          start: "",
          end: "",
          ...changes,
        })
      : contactData({ uid: "unused", name: "", ...changes });
  const keys =
    kind === "calendar"
      ? [
          ...(changes.title !== undefined ? ["SUMMARY"] : []),
          ...(changes.start !== undefined || changes.end !== undefined
            ? ["DTSTART", "DTEND", "DURATION"]
            : []),
          "DTSTAMP",
          "LAST-MODIFIED",
          "SEQUENCE",
          ...(changes.description !== undefined ? ["DESCRIPTION"] : []),
          ...(changes.location !== undefined ? ["LOCATION"] : []),
        ]
      : [
          ...(changes.name !== undefined ? ["FN", "N"] : []),
          ...(changes.email !== undefined ? ["EMAIL"] : []),
          ...(changes.phone !== undefined ? ["TEL"] : []),
        ];
  const additions = updated
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter((l) => keys.includes(name(l)));
  if (kind === "calendar") {
    const sequences = properties.filter((l) => name(l) === "SEQUENCE");
    const value = sequences[0]?.split(":")[1] ?? "0";
    if (
      sequences.length > 1 ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value) + 1)
    )
      throw new AppError("PROTOCOL_CHANGED", "Unsupported calendar sequence.");
    additions.push("SEQUENCE:" + (Number(value) + 1));
    additions.push(
      "LAST-MODIFIED:" +
        additions.find((l) => l.startsWith("DTSTAMP:"))!.slice(8),
    );
  }
  const output: string[] = [];
  depth = 0;
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper === "BEGIN:" + target) depth = 1;
    else if (upper.startsWith("BEGIN:") && depth) depth++;
    if (depth === 1 && keys.includes(name(line))) continue;
    if (upper === "END:" + target) output.push(...additions);
    output.push(line);
    if (upper.startsWith("END:") && depth) depth--;
  }
  return foldLines(output);
}

