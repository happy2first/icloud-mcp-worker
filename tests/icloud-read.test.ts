import test from "node:test";
import assert from "node:assert/strict";
import {
  AppleHTTP,
  APPLE_USER_AGENT,
  validatedAppleURL,
} from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";
import { encodeDocument } from "../src/reminders/crdt.ts";
import { AppError } from "../src/errors.ts";
import {
  CloudKitRateLimitedError,
  CloudKitRemindersClient,
  normalizeList,
  normalizeReminder,
  type CloudKitConnection,
} from "../src/icloud/cloudkit.ts";

const connection: CloudKitConnection = {
  dsid: "123456789",
  clientId: "11111111-2222-3333-4444-555555555555",
  clientBuildNumber: "2534Project66",
  clientMasteringNumber: "2534B22",
  cloudKitURL:
    "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/private",
};

type MockResponse = {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
};
type CapturedRequest = {
  url: URL;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
};

function clientWith(
  responses: MockResponse[],
  metadata: CloudKitConnection = connection,
) {
  const requests: CapturedRequest[] = [];
  const http = new AppleHTTP(new CookieJar(), async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses.shift();
    assert.ok(next, `unexpected request to ${url.pathname}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.headers,
    });
  });
  return { api: new CloudKitRemindersClient(http, metadata), requests };
}

function listRecord(recordName = "List/LIST-A") {
  return {
    recordName,
    recordType: "List",
    recordChangeTag: "tag-list-1",
    zoneID: {
      zoneName: "Reminders",
      zoneType: "REGULAR_CUSTOM_ZONE",
      ownerRecordName: "__defaultOwner__",
    },
    fields: {
      Name: { type: "STRING", value: "<script>alert('list')</script>" },
      Count: { type: "INT64", value: 1 },
      Deleted: { type: "INT64", value: 0 },
      ReminderIDs: { type: "STRING", value: '["Reminder/REM-1"]' },
      NewAppleField: { type: "STRING", value: "retained" },
    },
  };
}

function reminderRecord(title: string) {
  return {
    recordName: "Reminder/REM-1",
    recordType: "Reminder",
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" },
    fields: {
      TitleDocument: { type: "ENCRYPTED_BYTES", value: encodeDocument(title) },
      NotesDocument: {
        type: "ENCRYPTED_BYTES",
        value: encodeDocument("<img src=x onerror=alert(1)>"),
      },
      List: {
        type: "REFERENCE",
        value: { recordName: "List/LIST-A", action: "VALIDATE" },
      },
      Completed: { type: "INT64", value: 0 },
      DueDate: { type: "TIMESTAMP", value: 1_735_862_400_000 },
      Priority: { type: "INT64", value: 5 },
      AlarmIDs: { type: "STRING_LIST", value: ["Alarm/ALARM-1"] },
      AttachmentIDs: { type: "UNKNOWN_LIST", value: [] },
      HashtagIDs: { type: "UNKNOWN_LIST", value: [] },
      RecurrenceRuleIDs: { type: "UNKNOWN_LIST", value: [] },
      CustomFutureField: { type: "STRING", value: "kept" },
    },
  };
}

test("Reminders zone discovery and list query use the pinned private CloudKit request shape", async () => {
  const { api, requests } = clientWith([
    {
      body: {
        zones: [
          { zoneID: { zoneName: "Calendar", zoneType: "REGULAR_ZONE" } },
          {
            zoneID: {
              zoneName: "Reminders",
              zoneType: "REGULAR_CUSTOM_ZONE",
              ownerRecordName: "__defaultOwner__",
            },
          },
        ],
      },
    },
    { body: { records: [], continuationMarker: "query-next" } },
  ]);

  const discovery = await api.listZones();
  assert.equal(discovery.available, true);
  assert.equal(discovery.remindersZone?.zoneID.zoneName, "Reminders");
  assert.equal(discovery.complete, true);
  const page = await api.queryRemindersPage({
    listId: "List/LIST-A",
    includeCompleted: true,
    limit: 20,
  });
  assert.equal(page.complete, false);
  assert.equal(page.paginationComplete, false);
  assert.equal(page.continuation, "query-next");

  for (const request of requests) {
    assert.equal(request.headers.get("origin"), "https://www.icloud.com");
    assert.equal(request.headers.get("referer"), "https://www.icloud.com/");
    assert.equal(request.headers.get("user-agent"), APPLE_USER_AGENT);
  }
  assert.equal(requests[0].method, "POST");
  assert.equal(
    requests[0].url.pathname,
    "/database/1/com.apple.reminders/production/private/zones/list",
  );
  assert.deepEqual(Object.fromEntries(requests[0].url.searchParams), {
    remapEnums: "true",
    clientBuildNumber: "2534Project66",
    clientMasteringNumber: "2534B22",
    clientId: connection.clientId,
    dsid: connection.dsid,
  });
  assert.deepEqual(requests[0].body, {});
  assert.equal(
    requests[1].url.pathname,
    "/database/1/com.apple.reminders/production/private/records/query",
  );
  assert.deepEqual(requests[1].body, {
    query: {
      recordType: "reminderList",
      filterBy: [
        {
          comparator: "EQUALS",
          fieldName: "List",
          fieldValue: {
            type: "REFERENCE",
            value: { recordName: "List/LIST-A", action: "VALIDATE" },
          },
        },
        {
          comparator: "EQUALS",
          fieldName: "includeCompleted",
          fieldValue: { type: "INT64", value: 1 },
        },
        {
          comparator: "EQUALS",
          fieldName: "LookupValidatingReference",
          fieldValue: { type: "INT64", value: 1 },
        },
      ],
    },
    zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" },
    resultsLimit: 20,
  });
});

test("shared diagnostics bind exact lookups to authenticated shared-zone discovery without replacing the private owner", async () => {
  const sharedZone = {
    zoneName: "Reminders",
    zoneType: "REGULAR_CUSTOM_ZONE",
    ownerRecordName: "_shared-owner",
  };
  const discovery = { zones: [{ zoneID: sharedZone }] };
  const record = { ...listRecord(), zoneID: sharedZone };
  const { api, requests } = clientWith(
    [
      { body: discovery },
      {
        body: {
          records: [
            record,
            { recordName: "List/MISSING", serverErrorCode: "NOT_FOUND" },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: "_private-owner" },
  );
  assert.deepEqual(
    await api.probeSharedLists(["List/LIST-A", "List/MISSING"]),
    {
      database: "shared",
      zonesDiscovered: 1,
      deletedZones: 0,
      remindersZones: 1,
      otherZones: 0,
      lookups: [
        {
          matchedInputIndices: [1],
          deletedRecords: 0,
          recordErrors: [{ inputIndex: 2, code: "NOT_FOUND" }],
        },
      ],
      complete: true,
      contentsReturned: false,
    },
  );
  assert.equal(api.remindersZoneOwner, "_private-owner");
  assert.equal(
    requests[0].url.pathname,
    "/database/1/com.apple.reminders/production/shared/zones/list",
  );
  assert.equal(
    requests[1].url.pathname,
    "/database/1/com.apple.reminders/production/shared/records/lookup",
  );
  assert.deepEqual(requests[1].body.zoneID, sharedZone);
  const trace = JSON.stringify(api.readTrace);
  for (const value of ["_shared-owner", "List/LIST-A", "List/MISSING"])
    assert.ok(!trace.includes(value));
  const spoofed = clientWith([
    { body: discovery },
    {
      body: {
        records: [
          {
            ...record,
            zoneID: { ...sharedZone, ownerRecordName: "_foreign-owner" },
          },
        ],
      },
    },
  ]);
  await assert.rejects(spoofed.api.probeSharedLists(["List/LIST-A"]), AppError);
  for (const unbound of [
    {
      ...record,
      zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" },
    },
    {
      ...record,
      fields: {
        ...record.fields,
        Share: {
          type: "REFERENCE",
          value: {
            recordName: "List/LIST-A",
            zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" },
          },
        },
      },
    },
    {
      recordName: "List/LIST-A",
      serverErrorCode: "NOT_FOUND",
      zoneID: { ...sharedZone, ownerRecordName: "__defaultOwner__" },
    },
  ]) {
    const alias = clientWith([
      { body: discovery },
      { body: { records: [unbound] } },
    ]);
    await assert.rejects(alias.api.probeSharedLists(["List/LIST-A"]), AppError);
  }
  const excessive = clientWith([
    {
      body: {
        zones: Array.from({ length: 4 }, (_, index) => ({
          zoneID: { ...sharedZone, ownerRecordName: `_owner-${index}` },
        })),
      },
    },
  ]);
  await assert.rejects(
    excessive.api.probeSharedLists(["List/LIST-A"]),
    AppError,
  );
  assert.equal(excessive.requests.length, 1);
  assert.throws(
    () =>
      validatedAppleURL(
        "https://p01-ckdatabasews.icloud.com/database/1/com.apple.reminders/production/shared/records/modify",
        true,
      ),
    AppError,
  );
});

test("query pages expose partial per-record errors and continuation; normalizers retain hostile text and raw fields", async () => {
  const { api } = clientWith([
    {
      body: {
        records: [
          listRecord(),
          {
            recordName: "List/LIST-B",
            serverErrorCode: "CONFLICT",
            reason: "per-record failure",
          },
        ],
        continuationMarker: "page-2",
      },
    },
    { body: { records: [reminderRecord("<script>alert('title')</script>")] } },
  ]);

  const first = await api.queryPage({ recordType: "List", limit: 2 });
  assert.equal(first.paginationComplete, false);
  assert.equal(first.complete, false);
  assert.equal(first.pendingReason, "continuation");
  assert.equal(first.recordErrors[0]?.serverErrorCode, "CONFLICT");
  const list = normalizeList(
    first.records[0] as Extract<
      (typeof first.records)[number],
      { recordType: string }
    >,
  );
  assert.equal(list.title, "<script>alert('list')</script>");
  assert.equal(list.reminderIds?.[0], "Reminder/REM-1");
  assert.equal(
    (list.raw.fields as Record<string, unknown>).NewAppleField !== undefined,
    true,
  );
  const firstRecord = first.records[0] as Parameters<typeof normalizeList>[0];
  const oversizedMembership = {
    ...firstRecord,
    fields: {
      ...firstRecord.fields,
      ReminderIDs: {
        type: "STRING",
        value: JSON.stringify(Array(2001).fill("Reminder/REM-1")),
      },
    },
  };
  assert.throws(() => normalizeList(oversizedMembership), AppError);
  const summary = normalizeList(oversizedMembership, false);
  assert.equal(summary.reminderIds, null);
  assert.equal(summary.title, list.title);

  const second = await api.queryPage({
    recordType: "Reminder",
    continuation: first.continuation,
  });
  assert.equal(second.complete, true);
  const reminder = normalizeReminder(
    second.records[0] as Extract<
      (typeof second.records)[number],
      { recordType: string }
    >,
  );
  assert.equal(reminder.title, "<script>alert('title')</script>");
  assert.equal(reminder.notes, "<img src=x onerror=alert(1)>");
  assert.equal(reminder.listId, "List/LIST-A");
  assert.equal(reminder.dueDate, new Date(1_735_862_400_000).toISOString());
  assert.deepEqual(reminder.alarmIds, ["Alarm/ALARM-1"]);
  assert.deepEqual(reminder.attachmentIds, []);
  assert.deepEqual(reminder.hashtagIds, []);
  assert.deepEqual(reminder.recurrenceRuleIds, []);
  const rawReminder = second.records[0] as Parameters<
    typeof normalizeReminder
  >[0];
  for (const value of [["Attachment/ATT-1"], null, ""]) {
    assert.throws(
      () =>
        normalizeReminder({
          ...rawReminder,
          fields: {
            ...rawReminder.fields,
            AttachmentIDs: { type: "UNKNOWN_LIST", value },
          },
        }),
      AppError,
    );
  }
  assert.equal(
    (reminder.raw.fields as Record<string, unknown>).CustomFutureField !==
      undefined,
    true,
  );

  const versions = [
    { ...listRecord(), recordChangeTag: "new-version" },
    { ...listRecord(), recordChangeTag: "old-version" },
  ];
  const duplicate = clientWith([{ body: { records: versions } }]);
  await assert.rejects(
    duplicate.api.queryPage({ recordType: "List" }),
    AppError,
  );
});

test("experimental plural Lists query bootstraps the validated private zone and accepts singular List records", async () => {
  const owner = "_private-owner";
  const { api, requests } = clientWith([
    {
      body: {
        zones: [
          {
            zoneID: {
              zoneName: "Reminders",
              zoneType: "REGULAR_CUSTOM_ZONE",
              ownerRecordName: owner,
            },
          },
        ],
      },
    },
    { body: { records: [listRecord()], continuationMarker: "lists-next" } },
  ]);
  const page = await api.queryListsPage({ limit: 25 });
  assert.equal(page.records.length, 1);
  assert.equal(page.complete, false);
  assert.equal(page.continuation, "lists-next");
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].url.pathname,
    "/database/1/com.apple.reminders/production/private/records/query",
  );
  assert.deepEqual(requests[1].body, {
    query: { recordType: "Lists" },
    zoneID: {
      zoneName: "Reminders",
      zoneType: "REGULAR_CUSTOM_ZONE",
      ownerRecordName: owner,
    },
    resultsLimit: 25,
  });
  const wrongType = clientWith(
    [
      {
        body: {
          records: [
            {
              ...listRecord(),
              recordName: "Lists/LIST-A",
              recordType: "Lists",
            },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: owner },
  );
  await assert.rejects(wrongType.api.queryListsPage(), AppError);
  const wrongErrorType = clientWith(
    [
      {
        body: {
          records: [
            {
              recordName: "Reminder/NOT-A-LIST",
              serverErrorCode: "UNKNOWN_ITEM",
            },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: owner },
  );
  await assert.rejects(wrongErrorType.api.queryListsPage(), AppError);
  const missingContinuation = clientWith(
    [{ body: { records: [], moreComing: true } }],
    { ...connection, remindersZoneOwner: owner },
  );
  await assert.rejects(missingContinuation.api.queryListsPage(), AppError);
  const malformedContinuation = clientWith(
    [{ body: { records: [], continuationMarker: 42 } }],
    { ...connection, remindersZoneOwner: owner },
  );
  await assert.rejects(malformedContinuation.api.queryListsPage(), AppError);
});

test("queryAllLists follows continuations, deduplicates summaries, and retains groups and deleted lists without raw contents", async () => {
  const group = {
    ...listRecord("List/GROUP"),
    fields: {
      Name: { type: "STRING", value: "Folder" },
      IsGroup: { type: "INT64", value: 1 },
    },
  };
  const deleted = {
    ...listRecord("List/DELETED"),
    deleted: false,
    fields: {
      Name: { type: "STRING", value: "Removed" },
      Deleted: { type: "INT64", value: 1 },
    },
  };
  const { api, requests } = clientWith(
    [
      {
        body: {
          records: [listRecord(), group],
          continuationMarker: "lists-page-2",
        },
      },
      {
        body: {
          records: [
            listRecord(),
            deleted,
            { recordName: "List/TOMBSTONE", deleted: true },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: "_private-owner" },
  );
  const result = await api.queryAllLists();
  assert.equal(result.complete, true);
  assert.equal(result.pagesRead, 2);
  assert.equal(requests.length, 2);
  assert.equal(result.lists.length, 4);
  assert.equal(
    result.lists.find((list) => list.id === "List/GROUP")?.isGroup,
    true,
  );
  assert.equal(
    result.lists.find((list) => list.id === "List/DELETED")?.deleted,
    true,
  );
  assert.equal(
    result.lists.find((list) => list.id === "List/TOMBSTONE")?.deleted,
    true,
  );
  assert.ok(
    result.lists.every(
      (list) => list.reminderIds === null && Object.keys(list.raw).length === 0,
    ),
  );
  assert.equal(
    requests.every((request) => !Object.hasOwn(request.body, "desiredKeys")),
    true,
  );
  assert.deepEqual(requests[1].body, {
    query: { recordType: "Lists" },
    zoneID: {
      zoneName: "Reminders",
      zoneType: "REGULAR_CUSTOM_ZONE",
      ownerRecordName: "_private-owner",
    },
    resultsLimit: 200,
    continuationMarker: "lists-page-2",
  });
});

test("queryAllLists reports record errors and continuation cycles as incomplete", async () => {
  const errors = clientWith(
    [
      {
        body: {
          records: [
            {
              recordName: "List/FAILED",
              serverErrorCode: "CONFLICT",
              reason: "private reason",
            },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: "_private-owner" },
  );
  assert.deepEqual(await errors.api.queryAllLists(), {
    lists: [],
    complete: false,
    pagesRead: 1,
    pendingReason: "record_errors",
  });
  const authentication = clientWith(
    [
      {
        body: {
          records: [
            {
              recordName: "List/FAILED",
              serverErrorCode: "AUTHENTICATION_REQUIRED",
            },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: "_private-owner" },
  );
  await assert.rejects(
    authentication.api.queryAllLists(),
    (error: unknown) =>
      error instanceof AppError && error.code === "REAUTH_REQUIRED",
  );
  const cycle = clientWith(
    [
      { body: { records: [], continuationMarker: "cycle-a" } },
      { body: { records: [], continuationMarker: "cycle-b" } },
      { body: { records: [], continuationMarker: "cycle-a" } },
    ],
    { ...connection, remindersZoneOwner: "_private-owner" },
  );
  assert.deepEqual(await cycle.api.queryAllLists(), {
    lists: [],
    complete: false,
    pagesRead: 3,
    pendingReason: "continuation_cycle",
  });
  const immediate = clientWith(
    [
      { body: { records: [], continuationMarker: "same" } },
      { body: { records: [], continuationMarker: "same" } },
    ],
    { ...connection, remindersZoneOwner: "_private-owner" },
  );
  assert.deepEqual(await immediate.api.queryAllLists(), {
    lists: [],
    complete: false,
    pagesRead: 2,
    pendingReason: "continuation_cycle",
  });
});

test("queryAllLists fails conflicting duplicates, malformed records, and unavailable or foreign private zones", async () => {
  const conflict = clientWith(
    [
      { body: { records: [listRecord()], continuationMarker: "next" } },
      {
        body: {
          records: [
            {
              ...listRecord(),
              fields: { Name: { type: "STRING", value: "Changed title" } },
            },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: "_private-owner" },
  );
  await assert.rejects(conflict.api.queryAllLists(), AppError);
  const malformed = clientWith(
    [
      {
        body: {
          records: [
            {
              recordName: "List/BAD",
              recordType: "List",
              fields: { Count: { type: "STRING", value: "many" } },
            },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: "_private-owner" },
  );
  await assert.rejects(malformed.api.queryAllLists(), AppError);
  const absent = clientWith([{ body: { zones: [] } }]);
  await assert.rejects(absent.api.queryListsPage(), AppError);
  assert.equal(absent.requests.length, 1);
  const foreign = clientWith([
    {
      body: {
        zones: [
          {
            zoneID: {
              zoneName: "Reminders",
              ownerRecordName: "_private-owner",
            },
          },
        ],
      },
    },
    {
      body: {
        records: [
          {
            ...listRecord(),
            zoneID: {
              zoneName: "Reminders",
              ownerRecordName: "_foreign-owner",
            },
          },
        ],
      },
    },
  ]);
  await assert.rejects(foreign.api.queryListsPage(), AppError);
});

test("queryAllLists stops at the aggregate summary byte and page budgets", async () => {
  const largePage = (page: number) =>
    Array.from({ length: 150 }, (_, index) => ({
      recordName: `List/B${page}-${index}`,
      recordType: "List",
      fields: { Name: { type: "STRING", value: "x".repeat(1_000) } },
    }));
  const byteResponses = Array.from({ length: 8 }, (_, page) => ({
    body: {
      records: largePage(page),
      ...(page < 7 ? { continuationMarker: `byte-${page + 1}` } : {}),
    },
  }));
  const bytes = clientWith(byteResponses, {
    ...connection,
    remindersZoneOwner: "_private-owner",
  });
  const byteResult = await bytes.api.queryAllLists();
  assert.equal(byteResult.complete, false);
  assert.equal(byteResult.pendingReason, "summary_byte_limit");
  assert.ok(byteResult.lists.length < 1_200);
  const pageResponses = Array.from({ length: 25 }, (_, page) => ({
    body: { records: [], continuationMarker: `page-${page + 1}` },
  }));
  const pages = clientWith(pageResponses, {
    ...connection,
    remindersZoneOwner: "_private-owner",
  });
  assert.deepEqual(await pages.api.queryAllLists(), {
    lists: [],
    complete: false,
    pagesRead: 25,
    pendingReason: "page_limit",
  });
});

test("200-reminder compound pages accept related records but retain hard record and request limits", async () => {
  const records = Array.from({ length: 200 }, (_, index) => ({
    ...reminderRecord("Task"),
    recordName: `Reminder/R-${index}`,
  }));
  const alarms = Array.from({ length: 400 }, (_, index) => ({
    recordName: `Alarm/A-${index}`,
    recordType: "Alarm",
    fields: {},
  }));
  const full = clientWith([{ body: { records: [...records, ...alarms] } }]);
  assert.equal(
    (
      await full.api.queryRemindersPage({
        listId: "List/LIST-A",
        includeCompleted: false,
        limit: 200,
      })
    ).records.length,
    600,
  );
  assert.equal(full.requests[0].body.resultsLimit, 200);
  const excessive = clientWith([
    {
      body: {
        records: Array.from({ length: 1001 }, (_, index) => ({
          recordName: `Alarm/A-${index}`,
          recordType: "Alarm",
          fields: {},
        })),
      },
    },
  ]);
  await assert.rejects(
    excessive.api.queryRemindersPage({
      listId: "List/LIST-A",
      includeCompleted: false,
      limit: 200,
    }),
    AppError,
  );
  const invalid = clientWith([]);
  await assert.rejects(invalid.api.queryListsPage({ limit: 201 }), AppError);
  assert.equal(invalid.requests.length, 0);
});

test("unused opaque references do not invalidate an owned reminder or expose referenced data", async () => {
  const record = reminderRecord("Owned item");
  const fields = {
    ...record.fields,
    OpaqueMetadata: {
      type: "REFERENCE",
      value: {
        recordName: "List/UNUSED-FOREIGN",
        zoneID: { zoneName: "Reminders", ownerRecordName: "_foreign-owner" },
      },
    },
  };
  const { api, requests } = clientWith([
    { body: { records: [{ ...record, fields }] } },
  ]);
  const page = await api.queryRemindersPage({
    listId: "List/LIST-A",
    includeCompleted: false,
  });
  assert.equal(page.records.length, 1);
  const result = normalizeReminder(page.records[0] as any);
  assert.equal(result.title, "Owned item");
  assert.equal(result.listId, "List/LIST-A");
  assert.equal(requests.length, 1);
  assert.ok(!("OpaqueMetadata" in result));
});

test("unused repeat-rule metadata does not block owned reminder pages", async () => {
  const { api } = clientWith([
    {
      body: {
        records: [
          reminderRecord("Owned repeating item"),
          {
            recordName: "RecurrenceRule/RULE",
            recordType: "RecurrenceRule",
            zoneID: { zoneName: "Reminders", zoneType: "REGULAR_CUSTOM_ZONE" },
            fields: {
              OpaqueMetadata: {
                type: "REFERENCE",
                value: {
                  recordName: "List/UNUSED-FOREIGN",
                  zoneID: {
                    zoneName: "Reminders",
                    ownerRecordName: "_foreign-owner",
                  },
                },
              },
            },
          },
        ],
      },
    },
  ]);
  const page = await api.queryRemindersPage({
    listId: "List/LIST-A",
    includeCompleted: false,
  });
  assert.equal(page.records.length, 2);
  assert.equal(
    normalizeReminder(page.records[0] as any).title,
    "Owned repeating item",
  );
});

for (const key of ["List", "ParentReminder"] as const) {
  test(`consumed ${key} references still reject foreign owners with precise context`, async () => {
    const record = reminderRecord("Owned item");
    const { api } = clientWith([
      {
        body: {
          records: [
            {
              ...record,
              fields: {
                ...record.fields,
                [key]: {
                  type: "REFERENCE",
                  value: {
                    recordName:
                      key === "List" ? "List/LIST-A" : "Reminder/PARENT",
                    zoneID: {
                      zoneName: "Reminders",
                      ownerRecordName: "_foreign-owner",
                    },
                  },
                },
              },
            },
          ],
        },
      },
    ]);
    await assert.rejects(
      api.queryRemindersPage({
        listId: "List/LIST-A",
        includeCompleted: false,
      }),
      (e: any) =>
        e.code === "PROTOCOL_CHANGED" &&
        e.message.includes(`relationship=${key}`) &&
        !e.message.includes("_foreign-owner"),
    );
  });
}

test("zone ownership and record zone mismatches fail closed on direct reads", async () => {
  const wrongOwner = clientWith(
    [
      {
        body: {
          zones: [
            {
              zoneID: {
                zoneName: "Reminders",
                zoneType: "REGULAR_CUSTOM_ZONE",
                ownerRecordName: "_other-user",
              },
            },
          ],
        },
      },
    ],
    { ...connection, remindersZoneOwner: "_current-user" },
  );
  await assert.rejects(wrongOwner.api.listZones(), AppError);

  const canonicalOwner = "_synthetic-current-user";
  const canonicalZone = {
    zoneName: "Reminders",
    zoneType: "REGULAR_CUSTOM_ZONE",
    ownerRecordName: canonicalOwner,
  };
  const ownedReminder = {
    ...reminderRecord("Owner-bound task"),
    zoneID: canonicalZone,
    fields: {
      ...reminderRecord("Owner-bound task").fields,
      ParentReminder: { type: "REFERENCE", value: null },
    },
  };
  const listReference = ownedReminder.fields.List.value as {
    recordName: string;
    action: string;
    zoneID?: typeof canonicalZone;
  };
  listReference.zoneID = canonicalZone;
  const scoped = clientWith([
    { body: { zones: [{ zoneID: canonicalZone }] } },
    { body: { records: [ownedReminder] } },
    {
      body: {
        records: [
          {
            ...ownedReminder,
            fields: {
              ...ownedReminder.fields,
              List: {
                type: "REFERENCE",
                value: {
                  recordName: "List/LIST-A",
                  action: "VALIDATE",
                  zoneID: {
                    ...canonicalZone,
                    ownerRecordName: "_different-user",
                  },
                },
              },
            },
          },
        ],
      },
    },
  ]);
  assert.equal((await scoped.api.listZones()).available, true);
  assert.equal(scoped.api.remindersZoneOwner, canonicalOwner);
  const ownedPage = await scoped.api.queryRemindersPage({
    listId: "List/LIST-A",
    includeCompleted: true,
  });
  assert.equal(ownedPage.records.length, 1);
  assert.equal(
    normalizeReminder(
      ownedPage.records[0] as Extract<
        (typeof ownedPage.records)[number],
        { recordType: string }
      >,
      canonicalOwner,
    ).parentReminderId,
    null,
  );
  await assert.rejects(
    scoped.api.queryRemindersPage({
      listId: "List/LIST-A",
      includeCompleted: true,
    }),
    AppError,
  );
  assert.deepEqual(scoped.requests[1].body.zoneID, canonicalZone);
  const ambiguous = clientWith([
    {
      body: {
        zones: [
          { zoneID: canonicalZone },
          { zoneID: { ...canonicalZone, ownerRecordName: "_different-user" } },
        ],
      },
    },
  ]);
  await assert.rejects(ambiguous.api.listZones(), AppError);
  assert.equal(ambiguous.api.remindersZoneOwner, undefined);
  const absent = clientWith([{ body: { zones: [] } }]);
  assert.equal((await absent.api.listZones()).available, false);
  assert.equal(absent.api.remindersZoneOwner, undefined);

  const wrongZoneRecord = clientWith([
    {
      body: {
        records: [
          {
            ...listRecord(),
            zoneID: { zoneName: "Calendar", zoneType: "REGULAR_CUSTOM_ZONE" },
          },
        ],
      },
    },
  ]);
  await assert.rejects(wrongZoneRecord.api.lookup(["List/LIST-A"]), AppError);
});

test("HTTP 200 record errors remain visible and HTTP auth/rate-limit failures stay typed", async () => {
  const perRecord = clientWith([
    {
      body: {
        records: [
          {
            recordName: "Reminder/REM-MISSING",
            serverErrorCode: "UNKNOWN_ITEM",
            reason: "not found",
          },
        ],
      },
    },
  ]);
  const lookup = await perRecord.api.lookup(["Reminder/REM-MISSING"]);
  assert.equal(lookup.complete, false);
  assert.equal(lookup.recordErrors[0]?.serverErrorCode, "UNKNOWN_ITEM");
  assert.deepEqual(lookup.unresolvedRecordNames, []);

  const unauthenticated = clientWith([
    { status: 401, body: { reason: "expired" } },
  ]);
  await assert.rejects(
    unauthenticated.api.listZones(),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "REAUTH_REQUIRED" &&
      error.status === 409,
  );
  const limited = clientWith([
    { status: 429, headers: { "retry-after": "30" }, body: {} },
  ]);
  await assert.rejects(
    limited.api.listZones(),
    (error: unknown) =>
      error instanceof CloudKitRateLimitedError &&
      error.retryAfterSeconds === 30,
  );
  const malformed = clientWith([{ body: { continuationMarker: null } }]);
  await assert.rejects(
    malformed.api.queryPage({ recordType: "List" }),
    (error: unknown) =>
      error instanceof AppError && error.code === "PROTOCOL_CHANGED",
  );
  const forbidden = clientWith([{ status: 403, body: {} }]);
  await assert.rejects(
    forbidden.api.listZones(),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
});

test("discovery URL validation rejects a non-Reminders Apple CloudKit URL", () => {
  assert.throws(
    () =>
      new CloudKitRemindersClient(new AppleHTTP(), {
        ...connection,
        cloudKitURL:
          "https://p01-ckdatabasews.icloud.com/database/1/com.apple.notes/production/private",
      }),
    AppError,
  );
  assert.throws(
    () =>
      new CloudKitRemindersClient(new AppleHTTP(), {
        ...connection,
        cloudKitURL:
          "https://attacker.example/database/1/com.apple.reminders/production/private",
      }),
    AppError,
  );
});
