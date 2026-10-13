import test from "node:test";
import assert from "node:assert/strict";
import { DavClient, davURL, parseMulti } from "../src/services/dav.ts";

const creds = { account: "fixture@example.invalid", password: "fixture-password" };
const response = (href: string, prop: string) => new Response(
  `<multistatus xmlns="DAV:"><response><href xmlns="DAV:"> ${href} </href><propstat><prop>${prop}</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`,
  { status: 207 },
);

for (const kind of ["calendar", "contacts"] as const) {
  test(`${kind}: discovery handles attributed hrefs, regional redirects and relative collections`, async () => {
    const service = kind === "calendar" ? "caldav" : "contacts";
    const partition = `https://p123-${service}.icloud.com.cn`;
    const property = kind === "calendar" ? "calendar-home-set" : "addressbook-home-set";
    const resource = kind === "calendar" ? "calendar" : "addressbook";
    const namespace = kind === "calendar" ? "caldav" : "carddav";
    const seen: string[] = [];
    const client = new DavClient(kind, creds, async (url, init) => {
      const u = new URL(String(url));
      seen.push(u.href);
      assert.equal(init?.method, "PROPFIND");
      assert.equal(init?.redirect, "manual");
      if (seen.length === 1) return new Response(null, {
        status: 307, headers: { location: partition + "/" },
      });
      if (u.pathname === "/") return response(partition + "/", '<current-user-principal><href xmlns="DAV:">/123/principal/</href></current-user-principal>');
      if (u.pathname === "/123/principal/") return response(u.href,
        `<c:${property} xmlns:c="urn:ietf:params:xml:ns:${namespace}"><href xmlns="DAV:">${partition}:443/123/home/</href></c:${property}>`);
      assert.equal(u.pathname, "/123/home/");
      assert.equal((init?.headers as any).Depth, "1");
      return response("/123/home/default/", `<displayname>Home &amp; work</displayname><resourcetype><collection/><c:${resource} xmlns:c="urn:ietf:params:xml:ns:${namespace}"/></resourcetype>`);
    });
    assert.deepEqual(await client.discover(), { collections: [
      { url: partition + "/123/home/default/", name: "Home & work" },
    ] });
    assert.equal(seen.length, 4);
    assert.ok(seen.every(u => !u.includes("[object")));
  });
}

test("regional bootstrap is attempted only once for read-only discovery", async () => {
  const seen: string[] = [];
  const client = new DavClient("contacts", creds, async url => {
    seen.push(String(url));
    return new Response(null, { status: 401 });
  });
  await assert.rejects(client.discover(), (e: any) => e.code === "REAUTH_REQUIRED");
  assert.deepEqual(seen, ["https://contacts.icloud.com/", "https://contacts.icloud.com.cn/"]);
});

test("DAV parsing never emits object-string or missing href addresses", () => {
  const xml = '<multistatus xmlns="DAV:"><response><href xmlns="DAV:">/123/</href></response></multistatus>';
  assert.equal(parseMulti(xml)[0].href, "/123/");
  assert.throws(() => parseMulti('<multistatus><response><href/></response></multistatus>'), (e: any) => e.code === "PROTOCOL_CHANGED");
  assert.throws(() => davURL("[object Object]", "calendar"), (e: any) => e.code === "VALIDATION_ERROR");
  for (const u of ["https://p01-caldav.icloud.com.cn.evil.test/", "https://contacts.icloud.com.cn/", "http://caldav.icloud.com.cn/", "https://caldav.icloud.com.cn:444/", "https://caldav.icloud.com.cn/?secret=x"])
    assert.throws(() => davURL(u, "calendar"));
});

test("DAV failures distinguish HTTP, network and redirect errors without raw secrets", async () => {
  for (const [send, code, detail] of [
    [async () => new Response(null, { status: 503 }), "UPSTREAM_UNAVAILABLE", "HTTP 503"],
    [async () => { throw new Error("secret-sentinel"); }, "UPSTREAM_UNAVAILABLE", "network connection failed"],
    [async () => new Response(null, { status: 302 }), "APPLE_REDIRECT_ERROR", "omitted Location"],
    [async () => new Response(null, { status: 307, headers: { location: "/" } }), "APPLE_REDIRECT_ERROR", "redirect loop"],
  ] as const) {
    const client = new DavClient("calendar", creds, send);
    await assert.rejects(client.get("https://caldav.icloud.com/"), (e: any) =>
      e.code === code && e.message.includes(detail) && !e.message.includes("sentinel"));
  }
});
