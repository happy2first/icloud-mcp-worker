import { requireValue } from "../errors.ts";
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  expiresAt: number | null;
}
const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export class CookieJar {
  private cookies: Cookie[];
  constructor(cookies: Cookie[] = []) {
    this.cookies = cookies.map((c) => ({ ...c }));
  }
  set(line: string, url: URL, now = Date.now()) {
    requireValue(
      line.length <= 8192 && !/[\r\n]/.test(line),
      "Invalid upstream cookie.",
    );
    const parts = line.split(";");
    const first = parts.shift() ?? "";
    const equals = first.indexOf("=");
    if (equals <= 0) return;
    const name = first.slice(0, equals).trim();
    const value = first.slice(equals + 1).trim();
    if (!token.test(name) || /[\x00-\x20\x7f;,]/.test(value)) return;
    let domain = url.hostname.toLowerCase();
    let hostOnly = true;
    const defaultPath =
      url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
    let path = defaultPath;
    let secure = false;
    let expiresAt: number | null = null;
    let maxAge: number | null = null;
    for (const part of parts) {
      const [raw, ...rest] = part.trim().split("=");
      const key = raw.toLowerCase();
      const attribute = rest.join("=").trim();
      if (key === "domain") {
        const candidate = attribute.replace(/^\./, "").toLowerCase();
        // No public-suffix or unrelated-domain cookies, even from an allowlisted service.
        if (
          !/^(?:[a-z0-9-]+\.)+(?:apple\.com|icloud\.com(?:\.cn)?)$/.test(candidate) &&
          !["apple.com", "icloud.com", "icloud.com.cn"].includes(candidate)
        )
          return;
        if (
          url.hostname !== candidate &&
          !url.hostname.endsWith(`.${candidate}`)
        )
          return;
        domain = candidate;
        hostOnly = false;
      } else if (key === "path" && attribute.startsWith("/")) path = attribute;
      else if (key === "secure") secure = true;
      else if (key === "expires") {
        const parsed = Date.parse(attribute);
        if (Number.isFinite(parsed)) expiresAt = parsed;
      } else if (key === "max-age" && /^-?\d+$/.test(attribute))
        maxAge = Number(attribute);
    }
    if (maxAge !== null)
      expiresAt = maxAge <= 0 ? 0 : now + Math.min(maxAge, 31_536_000) * 1000;
    if (name.startsWith("__Secure-") && (!secure || url.protocol !== "https:"))
      return;
    if (
      name.startsWith("__Host-") &&
      (!secure || !hostOnly || path !== "/" || url.protocol !== "https:")
    )
      return;
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === path),
    );
    if (expiresAt === null || expiresAt > now)
      this.cookies.push({
        name,
        value,
        domain,
        hostOnly,
        path,
        secure,
        expiresAt,
      });
    requireValue(
      this.cookies.length <= 200,
      "The upstream cookie budget was exceeded.",
    );
  }
  header(url: URL, now = Date.now()) {
    this.cookies = this.cookies.filter(
      (c) => c.expiresAt === null || c.expiresAt > now,
    );
    return this.cookies
      .filter(
        (c) =>
          (c.hostOnly
            ? url.hostname === c.domain
            : url.hostname === c.domain ||
              url.hostname.endsWith(`.${c.domain}`)) &&
          (!c.secure || url.protocol === "https:") &&
          (url.pathname === c.path ||
            (url.pathname.startsWith(c.path) &&
              (c.path.endsWith("/") || url.pathname[c.path.length] === "/"))),
      )
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }
  snapshot(): Cookie[] {
    return this.cookies.map((c) => ({ ...c }));
  }
}
