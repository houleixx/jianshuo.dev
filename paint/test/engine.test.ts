import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs, parseResult, parseEventLine } from "../src/engine.ts";
import type { Job } from "../src/store.ts";

const base: Job = {
  id: "j1", status: "queued", mode: "generate", prompt: "a red cat",
  params: { size: "2K", format: "png", quality: "high", transparent: false },
  percent: 0, error: null, createdAt: "2026-07-01T00:00:00Z",
};

test("buildArgs generate", () => {
  const a = buildArgs(base, "/out/j1.png");
  assert.deepEqual(a, [
    "--json", "--json-events", "images", "generate", "--provider", "codex",
    "--prompt", "a red cat", "--out", "/out/j1.png",
    "--format", "png", "--size", "2K", "--quality", "high",
  ]);
});

test("buildArgs edit adds --ref-image", () => {
  const a = buildArgs({ ...base, mode: "edit", inputPath: "/in/j1.png" }, "/out/j1.png");
  assert.ok(a.includes("edit"));
  assert.ok(a.includes("--ref-image"));
  assert.equal(a[a.indexOf("--ref-image") + 1], "/in/j1.png");
});

test("buildArgs compression when set", () => {
  const a = buildArgs({ ...base, params: { ...base.params, format: "jpeg", compression: 80 } }, "/o.jpeg");
  assert.equal(a[a.indexOf("--compression") + 1], "80");
});

test("buildArgs transparent generate", () => {
  const a = buildArgs({ ...base, params: { ...base.params, transparent: true } }, "/out/j1.png");
  assert.deepEqual(a.slice(0, 5), ["--json", "--json-events", "transparent", "generate", "--provider"]);
});

test("buildArgs transparent+edit throws", () => {
  assert.throws(
    () => buildArgs({ ...base, mode: "edit", inputPath: "/in.png", params: { ...base.params, transparent: true } }, "/o.png"),
    /transparent.*edit/i
  );
});

test("parseResult success/error", () => {
  assert.deepEqual(parseResult('{"ok":true,"output":{"path":"/x"}}'), { ok: true });
  const r = parseResult('{"ok":false,"error":{"code":"http_error","message":"boom"}}');
  assert.equal(r.ok, false);
  assert.equal(r.error?.code, "http_error");
});

test("parseResult tolerates junk before json", () => {
  assert.equal(parseResult('warn line\n{"ok":true}').ok, true);
  assert.equal(parseResult("not json at all").ok, false);
});

test("parseEventLine maps percent, skips sse", () => {
  assert.deepEqual(
    parseEventLine('{"data":{"percent":95,"phase":"request_completed"},"kind":"progress","type":"request_completed"}'),
    { percent: 95, phase: "request_completed" }
  );
  assert.equal(parseEventLine('{"kind":"sse","type":"keepalive","data":{}}'), null);
  assert.equal(parseEventLine("garbage"), null);
});
