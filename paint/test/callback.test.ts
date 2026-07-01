import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sign, deliver, type CallbackPayload } from "../src/callback.ts";

const payload: CallbackPayload = {
  job_id: "j1", status: "done", result_url: "https://x/r.png",
  format: "png", size: "2048x2048", bytes: 10, error: null,
  callback_meta: { note_id: "n1", orig_key: "k1" },
};

test("sign is stable hmac", () => {
  const body = JSON.stringify(payload);
  const expected = "sha256=" + createHmac("sha256", "sec").update(body).digest("hex");
  assert.equal(sign(body, "sec"), expected);
});

test("deliver posts signed body with bearer + meta echoed", async () => {
  let seen: any = null;
  const fetchImpl = (async (url: string, init: any) => {
    seen = { url, init };
    return { ok: true, status: 200 } as any;
  }) as unknown as typeof fetch;
  const res = await deliver("https://cb", "tok", payload, "sec", { fetchImpl, delayMs: () => 0 });
  assert.equal(res.ok, true);
  assert.equal(res.attempts, 1);
  assert.equal(seen.url, "https://cb");
  assert.equal(seen.init.headers["Authorization"], "Bearer tok");
  assert.equal(seen.init.headers["X-Paint-Job"], "j1");
  assert.equal(seen.init.headers["X-Paint-Signature"], sign(seen.init.body, "sec"));
  assert.deepEqual(JSON.parse(seen.init.body).callback_meta, { note_id: "n1", orig_key: "k1" });
});

test("deliver retries on 500 then gives up", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return { ok: false, status: 500 } as any; }) as unknown as typeof fetch;
  const res = await deliver("https://cb", undefined, payload, "sec", { fetchImpl, retries: 3, delayMs: () => 0 });
  assert.equal(res.ok, false);
  assert.equal(calls, 3);
});

test("deliver no bearer header when token omitted", async () => {
  let seen: any = null;
  const fetchImpl = (async (_u: string, init: any) => { seen = init; return { ok: true, status: 200 } as any; }) as unknown as typeof fetch;
  await deliver("https://cb", undefined, payload, "sec", { fetchImpl, delayMs: () => 0 });
  assert.equal(seen.headers["Authorization"], undefined);
});
