import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateSync, deflateRawSync } from "node:zlib";
import {
  DavClient,
  davURL,
  parseMulti,
  calendarData,
  contactData,
  updateDavData,
} from "../src/services/dav.ts";
import {
  validatedAppleURL,
  limitedBytes,
} from "../src/transport/apple-http.ts";
import { decodeNote, NotesClient } from "../src/services/notes.ts";
import {
  PhotosClient,
  photoPairs,
  photoSummary,
} from "../src/services/photos.ts";
import { DriveClient } from "../src/services/drive.ts";
import { WebClient } from "../src/services/web.ts";
import { assetURL } from "../src/services/downloads.ts";
import { advancePcs, freshPcsCheckpoint } from "../src/auth/apple/pcs.ts";
import { AppleAuthHTTP } from "../src/auth/apple/http.ts";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { bytesField } from "../src/crypto/protobuf.ts";
import { b64, utf8 } from "../src/crypto/bytes.ts";
import { thumbnailResult } from "../src/mcp/services.ts";
const creds = {
  account: "synthetic@example.invalid",
  password: "aaaa-bbbb-cccc-dddd",
};
const f = (value: any) => ({ value });
test("photo thumbnails are MCP image blocks, not opaque JSON base64 text", () => {
  const result = thumbnailResult({
    mimeType: "image/jpeg; charset=binary",
    base64: "synthetic",
  });
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[0].mimeType, "image/jpeg");
  assert.ok(!JSON.stringify(result.structuredContent).includes("synthetic"));
  assert.throws(() =>
    thumbnailResult({ mimeType: "text/html", base64: "synthetic" }),
  );
});
test("CardDAV REPORT uses address-data, preserves text and refuses missing properties", async () => {
  let missing = false;
  const c = new DavClient("contacts", creds, async (_url, init) => {
    assert.ok(String(init?.body).includes("<c:address-data/>"));
    assert.ok(!String(init?.body).includes("addressbook-data"));
    return new Response(
      `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/a.vcf</d:href><d:propstat><d:prop><d:getetag>"v1"</d:getetag>${missing ? "" : "<c:address-data>BEGIN:VCARD\nFN:00123\nEND:VCARD\n</c:address-data>"}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      { status: 207 },
    );
  });
  const r = await c.query("https://contacts.icloud.com/a/");
  assert.equal(r[0].data, "BEGIN:VCARD\nFN:00123\nEND:VCARD\n");
  missing = true;
  await assert.rejects(
    c.query("https://contacts.icloud.com/a/"),
    (e: any) => e.code === "PROTOCOL_CHANGED",
  );
  assert.throws(() => parseMulti("<html>not a DAV response</html>"));
  assert.deepEqual(parseMulti('<d:multistatus xmlns:d="DAV:"/>'), []);
});
test("DAV serialization escapes bare carriage returns", () => {
  const card = contactData({ uid: "test", name: "safe\rEND:VCARD" });
  assert.ok(card.includes("FN:safe\\nEND:VCARD"));
  assert.equal(card.split("\r\n").filter((l) => l === "END:VCARD").length, 1);
});
test("calendar updates remove DURATION, advance metadata and retain nested alarms", () => {
  const original = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:stable",
    "DTSTART:20261012T010000Z",
    "DURATION:PT1H",
    "SEQUENCE:4",
    "DTSTAMP:20200101T010000Z",
    "SUMMARY:old",
    "X-UNKNOWN:keep",
    "BEGIN:VALARM",
    "DURATION:PT5M",
    "DESCRIPTION:alarm",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const result = updateDavData("calendar", original, {
    title: "new",
    start: "20261012T020000Z",
    end: "20261012T030000Z",
  });
  assert.ok(!result.includes("DURATION:PT1H"));
  assert.ok(result.includes("DURATION:PT5M"));
  assert.ok(result.includes("UID:stable\r\n"));
  assert.ok(result.includes("SEQUENCE:5\r\n"));
  assert.ok(result.includes("X-UNKNOWN:keep"));
  assert.ok(result.includes("LAST-MODIFIED:"));
  assert.ok(!result.includes("DTSTAMP:20200101"));
  for (const property of [
    "rrule:FREQ=DAILY",
    "EXDATE:20261012T010000Z",
    "ATTENDEE:mailto:someone@example.invalid",
  ])
    assert.throws(
      () =>
        updateDavData(
          "calendar",
          original.replace("UID:stable", "UID:stable\r\n" + property),
          { title: "new", start: "20261012T020000Z", end: "20261012T030000Z" },
        ),
      (e: any) => e.code === "UNSUPPORTED_FEATURE",
    );
});
test("contact updates replace grouped and lowercase values without duplicating old email", () => {
  const result = updateDavData(
    "contacts",
    "begin:vcard\r\nVERSION:3.0\r\nUID:stable\r\nfn:old\r\nN:old;;;;\r\nitem1.EMAIL:old@example.invalid\r\nTEL:123\r\nend:vcard\r\n",
    { name: "new", email: "new@example.invalid" },
  );
  assert.ok(!result.includes("old@example.invalid"));
  assert.ok(!result.includes("fn:old"));
  assert.ok(result.includes("TEL:123"));
  assert.ok(result.includes("EMAIL:new@example.invalid"));
});
test("declared oversized response is cancelled without reading", async () => {
  let cancelled = false;
  const r = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-length": "999" } },
  );
  await assert.rejects(limitedBytes(r, 10));
  assert.equal(cancelled, true);
});
test("generic CloudKit maps HTML outages and nested zone errors safely", async () => {
  for (const [status, body, expected] of [
    [503, "<html>secret</html>", "UPSTREAM_UNAVAILABLE"],
    [403, "<html>secret</html>", "FORBIDDEN"],
    [
      200,
      JSON.stringify({ zones: [{ serverErrorCode: "PCS_REQUIRED" }] }),
      "DEVICE_APPROVAL_PENDING",
    ],
    [200, JSON.stringify({ records: {} }), "PROTOCOL_CHANGED"],
  ] as const) {
    const auth = new AppleAuthHTTP(
      new AppleHTTP(undefined, async () => new Response(body, { status })),
    );
    const w = new WebClient(auth, {
      connection: {
        cloudKitURL:
          "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
        dsid: "123",
        clientId: "synthetic",
        clientBuildNumber: "test",
        clientMasteringNumber: "test",
      },
    } as any);
    await assert.rejects(
      w.ck("notes", "changes/zone", {}),
      (e: any) => e.code === expected && !e.message.includes("secret"),
    );
  }
});
test("DAV exact per-service allowlists reject SSRF, credentials, ports and queries", () => {
  for (const u of [
    "http://caldav.icloud.com/",
    "https://caldav.icloud.com.evil.test/",
    "https://caldav.icloud.com:444/",
    "https://caldav.icloud.com/?x=1",
    "https://127.0.0.1/",
    "https://u:p@caldav.icloud.com/",
    "https://contacts.icloud.com/",
  ])
    assert.throws(() => davURL(u, "calendar"));
  assert.equal(
    davURL("https://p01-caldav.icloud.com/a/", "calendar").hostname,
    "p01-caldav.icloud.com",
  );
});
test("DAV namespace parser selects only successful propstat and rejects entities", () => {
  const records = parseMulti(
    '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a</D:href><D:propstat><D:prop><D:getetag>"one"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat><D:propstat><D:prop><D:displayname>bad</D:displayname></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response></D:multistatus>',
  );
  assert.equal(records[0].props.getetag, '"one"');
  assert.equal(records[0].props.displayname, undefined);
  assert.throws(() =>
    parseMulti(
      '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><x>&x;</x>',
    ),
  );
});
test("DAV writes use conditional creation and optimistic versions; never auto-retry writes", async () => {
  const seen: any[] = [];
  const client = new DavClient("calendar", creds, async (u, init) => {
    seen.push(init);
    return new Response("", { status: 201, headers: { etag: '"new"' } });
  });
  await client.put("https://caldav.icloud.com/a.ics", "data");
  await client.put("https://caldav.icloud.com/a.ics", "data", '"old"');
  await client.delete("https://caldav.icloud.com/a.ics", '"new"');
  assert.equal(seen[0].headers["If-None-Match"], "*");
  assert.equal(seen[1].headers["If-Match"], '"old"');
  assert.equal(seen[2].method, "DELETE");
  let calls = 0;
  const failed = new DavClient("calendar", creds, async () => {
    calls++;
    throw new Error("password sentinel");
  });
  await assert.rejects(
    failed.put("https://caldav.icloud.com/a.ics", "x"),
    (e: any) =>
      e.code === "WRITE_OUTCOME_UNKNOWN" && !e.message.includes("sentinel"),
  );
  assert.equal(calls, 1);
});
test("DAV redirects cannot send app password to an unrelated or different service", async () => {
  let calls = 0;
  const client = new DavClient("calendar", creds, async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://contacts.icloud.com/steal" },
    });
  });
  await assert.rejects(client.get("https://caldav.icloud.com/"));
  assert.equal(calls, 1);
});
for (const [status, code] of [
  [401, "REAUTH_REQUIRED"],
  [403, "FORBIDDEN"],
  [412, "CONFLICT"],
  [429, "RATE_LIMITED"],
] as const)
  test("DAV " + status + " maps to " + code, async () => {
    const c = new DavClient(
      "contacts",
      creds,
      async () => new Response("", { status }),
    );
    await assert.rejects(
      c.get("https://contacts.icloud.com/a"),
      (e: any) => e.code === code,
    );
  });
test("iCalendar and vCard escape injection and fold by UTF-8 bytes", () => {
  const event = calendarData({
    uid: "synthetic",
    title: "hello\nBEGIN:VEVENT",
    start: "20261012T010000Z",
    end: "20261012T020000Z",
    description: "a".repeat(160) + "中文",
  });
  assert.equal((event.match(/BEGIN:VEVENT/g) ?? []).length, 2);
  assert.ok(event.includes("SUMMARY:hello\\nBEGIN:VEVENT"));
  for (const line of event.split("\r\n"))
    assert.ok(Buffer.byteLength(line) <= 75);
  const card = contactData({ uid: "u", name: "a;b,c\nEND:VCARD" });
  assert.ok(card.includes("FN:a\\;b\\,c\\nEND:VCARD"));
});
test("three bounded Notes compression formats decode the pinned protobuf field path", async () => {
  const raw = bytesField(2, bytesField(3, bytesField(2, utf8("会议\n😀"))));
  for (const compress of [gzipSync, deflateSync, deflateRawSync])
    assert.equal((await decodeNote(b64(compress(raw)))).text, "会议\n😀");
  await assert.rejects(decodeNote(b64(gzipSync(utf8("invalid protobuf")))));
  await assert.rejects(decodeNote(b64(gzipSync(new Uint8Array(300000)))));
});
test("Notes queries carry explicit zone, desired keys and continuation; search declares page scope", async () => {
  let sent: any;
  const web = {
    ck: async (s: any, op: any, p: any) => {
      sent = p;
      return {
        records: [
          {
            recordName: "n",
            fields: {
              TitleEncrypted: f(b64(utf8("Work"))),
              SnippetEncrypted: f(b64(utf8("meeting"))),
              Folder: f({ recordName: "folder" }),
            },
          },
        ],
        continuationMarker: "next",
      };
    },
  } as unknown as WebClient;
  const r = await new NotesClient(web).list(50, "old", "folder", "work");
  assert.equal(sent.zoneID.zoneName, "Notes");
  assert.equal(sent.continuationMarker, "old");
  assert.equal(r.records[0].title, "Work");
  assert.equal(r.continuation, "next");
  assert.equal(r.complete, false);
  assert.equal(r.searchScope, "title-and-snippet-in-this-page");
});
test("locked Notes fail explicitly instead of returning snippet as body", async () => {
  const web = {
    ck: async () => ({
      records: [
        { recordName: "n", recordType: "PasswordProtectedNote", fields: {} },
      ],
    }),
  } as unknown as WebClient;
  await assert.rejects(
    new NotesClient(web).get("n"),
    (e: any) => e.code === "UNSUPPORTED_FEATURE",
  );
});
test("photo pairs retain multiple assets referring to a shared master and expose no download token", () => {
  const master = {
    recordType: "CPLMaster",
    recordName: "master",
    fields: {
      filenameEnc: f(b64(utf8("a.jpg"))),
      resOriginalRes: f({
        downloadURL: "https://secret.icloud-content.com/a?token=sentinel",
      }),
    },
  };
  const records = [
    master,
    ...["a", "b"].map((id) => ({
      recordType: "CPLAsset",
      recordName: id,
      fields: { masterRef: f({ recordName: "master" }) },
    })),
  ];
  const pairs = photoPairs(records);
  assert.equal(pairs.length, 2);
  assert.equal(photoSummary(pairs[0]).filename, "a.jpg");
  assert.ok(!JSON.stringify(pairs.map(photoSummary)).includes("sentinel"));
  assert.throws(() => photoPairs(records.slice(1)));
});
test("photo rank query and album filter use observed Photos record index", async () => {
  let sent: any;
  const w = {
    ck: async (s: any, op: any, p: any) => {
      sent = p;
      return { records: [] };
    },
  } as unknown as WebClient;
  const r = await new PhotosClient(w).query(20, 40, "album");
  assert.equal(sent.query.recordType, "CPLContainerRelationLiveByAssetDate");
  assert.equal(sent.query.filterBy[1].fieldValue.value, 40);
  assert.equal(r.complete, true);
});
test("Drive uses DriveWS directory endpoint and DocWS download endpoint", async () => {
  const requests: any[] = [];
  const w = {
    request: async (s: any, path: any, body: any) => {
      requests.push({ s, path, body });
      return s === "drivews"
        ? [
            {
              items: [
                {
                  drivewsid: "id",
                  docwsid: "doc",
                  name: "report",
                  type: "FILE",
                },
              ],
            },
          ]
        : {
            data_token: {
              url: "https://download.icloud-content.com/report?token=sentinel",
            },
          };
    },
  } as unknown as WebClient;
  const drive = new DriveClient(w);
  assert.equal((await drive.browse()).records[0].documentId, "doc");
  await drive.download("doc");
  assert.equal(requests[0].s, "drivews");
  assert.equal(requests[0].path, "/retrieveItemDetailsInFolders");
  assert.equal(requests[1].s, "docws");
  assert.ok(requests[1].path.includes("document_id=doc"));
});
test("service HTTP allowlists do not permit arbitrary APIs or cross-container mutations", () => {
  for (const path of [
    "/database/1/com.apple.notes/production/private/records/query",
    "/database/1/com.apple.photos.cloud/production/private/records/lookup",
  ])
    assert.equal(
      validatedAppleURL("https://p01-ckdatabasews.icloud.com" + path, true)
        .hostname,
      "p01-ckdatabasews.icloud.com",
    );
  for (const path of [
    "/database/1/com.apple.notes/production/private/records/modify",
    "/database/1/com.apple.photos.cloud/production/public/records/query",
  ])
    assert.throws(() =>
      validatedAppleURL("https://p01-ckdatabasews.icloud.com" + path, true),
    );
  assert.throws(() =>
    validatedAppleURL("https://p01-drivews.icloud.com/deleteItems", true),
  );
});
test("PCS request is service specific for all four Apple app names", async () => {
  for (const service of [
    "reminders",
    "notes3",
    "photos",
    "iclouddrive",
  ] as const) {
    let payload: any;
    const auth = new AppleAuthHTTP(
      new AppleHTTP(undefined, async (url, init) => {
        if (String(url).includes("requestWebAccessState"))
          return Response.json({
            isICDRSDisabled: true,
            isDeviceConsentedForPCS: true,
          });
        payload = JSON.parse(String(init?.body));
        return Response.json({ status: "success" });
      }),
    );
    const result = await advancePcs(
      auth,
      "123",
      freshPcsCheckpoint(),
      Date.now(),
      service,
    );
    assert.equal(payload.appName, service);
    assert.equal(result.state, "READY");
  }
});
test("signed assets reject non-Apple hosts, userinfo and insecure redirects", () => {
  for (const u of [
    "http://asset.icloud.com/x",
    "https://icloud.com.evil.test/x",
    "https://a:b@asset.icloud.com/x",
    "https://127.0.0.1/x",
  ])
    assert.throws(() => assetURL(u));
  assert.equal(
    assetURL("https://abc.icloud-content.com/a?token=synthetic").hostname,
    "abc.icloud-content.com",
  );
});

test("generic web client uses photos.cloud container and keeps DocWS document_id", async () => {
  const calls: any[] = [];
  const auth = {
    http: {
      request: async (url: string, options: any) => {
        calls.push({ url: new URL(url), options });
        return {
          status: 200,
          headers: new Headers(),
          bytes: utf8(JSON.stringify({ records: [] })),
        };
      },
    },
  } as unknown as AppleAuthHTTP;
  const session = {
    connection: {
      dsid: "123",
      clientId: "synthetic",
      clientBuildNumber: "synthetic",
      clientMasteringNumber: "synthetic",
      cloudKitURL:
        "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
      services: {
        ckdatabasews: "https://p01-ckdatabasews.icloud.com",
        docws: "https://p01-docws.icloud.com",
      },
    },
  } as any;
  const client = new WebClient(auth, session);
  await client.ck("photos", "records/query", {
    query: { recordType: "CPLAlbumByPositionLive" },
  });
  assert.equal(
    calls[0].url.pathname,
    "/database/1/com.apple.photos.cloud/production/private/records/query",
  );
  await client.request(
    "docws",
    "/ws/com.apple.CloudDocs/download/by_id?document_id=synthetic",
  );
  assert.equal(calls[1].url.searchParams.get("document_id"), "synthetic");
  assert.equal(calls[1].url.searchParams.get("dsid"), "123");
});

test("DAV builtin XML entities decode without permitting DTDs", () => {
  const rows = parseMulti(
    '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a</d:href><d:propstat><d:prop><d:displayname>A&amp;B &lt;team&gt;</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
  );
  assert.equal(rows[0].props.displayname, "A&B <team>");
  assert.throws(() =>
    parseMulti('<!DOCTYPE root [<!ENTITY bomb "huge">]><root>&bomb;</root>'),
  );
});
