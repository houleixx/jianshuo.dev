// 请求体上限的单测（2026-09-12）：超限 413 且连接被掐、坏 JSON 400、空体 = {}。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readJsonBody, BodyError } from "../dist/http-body.js";

function fakeReq(chunks, headers = {}) {
  const r = Readable.from(chunks.map((c) => Buffer.from(c)));
  r.headers = headers;
  return r;
}

test("正常 JSON", async () => {
  assert.deepEqual(await readJsonBody(fakeReq(['{"a":', "1}"]), 1024), { a: 1 });
});

test("空体当 {}", async () => {
  assert.deepEqual(await readJsonBody(fakeReq([]), 1024), {});
});

test("坏 JSON → 400", async () => {
  await assert.rejects(readJsonBody(fakeReq(["{oops"]), 1024), (e) => e instanceof BodyError && e.status === 400);
});

test("流式超限 → 413 并停读，不再攒", async () => {
  const req = fakeReq(["x".repeat(600), "y".repeat(600)]);
  await assert.rejects(readJsonBody(req, 1000), (e) => e instanceof BodyError && e.status === 413);
  assert.equal(req.isPaused(), true);
});

test("Content-Length 明说超限 → 413，一个字节不读", async () => {
  const req = fakeReq(["{}"], { "content-length": "999999" });
  await assert.rejects(readJsonBody(req, 1000), (e) => e instanceof BodyError && e.status === 413);
  assert.equal(req.isPaused(), true);
});
