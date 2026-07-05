import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { translate } from "../src/codex.ts";

// 权威 fixture：2026-07-05 在 VPS 上用真凭证录的 codex exec --json 输出
// （codex-cli 0.142.5）。CLI 升级后若解析失败，重录这个文件再校准 translate()。
test("真实事件流：translate 全程不抛异常，且产出 session + text", () => {
  const lines = readFileSync("test/fixtures/real-events.jsonl", "utf8").split("\n");
  const events = lines.flatMap((l) => translate(l));
  assert.ok(events.some((e) => e.event === "session" && e.data.threadId), "应从 thread.started 取到 threadId");
  assert.ok(events.some((e) => e.event === "text" && e.data.text === "PONG"), "应取到 agent_message 文本");
  assert.ok(events.some((e) => e.event === "result"), "应取到 turn.completed");
});
