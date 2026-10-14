import test from "node:test";
import assert from "node:assert/strict";
import { AppleHTTP } from "../src/transport/apple-http.ts";
import { CookieJar } from "../src/transport/cookie-jar.ts";

test("bounded CloudKit read can finish after the previous eight-second cutoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let finish!: (r: Response) => void;
  let signal!: AbortSignal;
  const http = new AppleHTTP(new CookieJar(), (async (_url, init) => {
    signal = init!.signal!;
    return new Promise<Response>((resolve, reject) => {
      finish = resolve;
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  }) as typeof fetch);
  try {
    const read = http.request(
      "https://p123-ckdatabasews.icloud.com.cn/database/1/com.apple.reminders/production/private/records/query",
      { discovered: true, timeoutMs: 16000 },
    );
    t.mock.timers.tick(9000);
    assert.equal(signal.aborted, false);
    finish(Response.json({ records: [] }));
    assert.equal((await read).status, 200);
  } finally {
    t.mock.timers.reset();
  }
});

test("slow read stays bounded and reports safe endpoint and elapsed-time diagnostics", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const http = new AppleHTTP(
    new CookieJar(),
    (async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("private-sentinel")),
          { once: true },
        );
      })) as typeof fetch,
  );
  try {
    const read = http.request(
      "https://p123-ckdatabasews.icloud.com.cn/database/1/com.apple.reminders/production/private/records/query?dsid=private-sentinel",
      { discovered: true, timeoutMs: 16000 },
    );
    const rejected = assert.rejects(
      read,
      (e: any) =>
        e.code === "UPSTREAM_UNAVAILABLE" &&
        e.message.includes("endpoint=/records/query") &&
        e.message.includes("elapsedMs=16000") &&
        !e.message.includes("private-sentinel"),
    );
    t.mock.timers.tick(16000);
    await rejected;
  } finally {
    t.mock.timers.reset();
  }
});

test("network failures are not misreported as timeouts and never expose raw exception text", async () => {
  const http = new AppleHTTP(new CookieJar(), async () => {
    throw new Error("private-sentinel");
  });
  await assert.rejects(
    http.request("https://setup.icloud.com.cn/setup/ws/1/validate"),
    (e: any) =>
      e.code === "UPSTREAM_UNAVAILABLE" &&
      e.message.includes("network request failed") &&
      !e.message.includes("private-sentinel"),
  );
});
