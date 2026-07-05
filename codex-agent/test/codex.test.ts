import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs, translate } from "../src/codex.ts";

const WS = "/opt/codex-agent/workspace";
const FLAGS = ["--json", "-s", "danger-full-access", "-C", WS, "--skip-git-repo-check"];

test("buildArgs 新会话：exec + flags + prompt 收尾", () => {
  assert.deepEqual(buildArgs("你好", null, WS), ["exec", ...FLAGS, "你好"]);
});

test("buildArgs 续聊：flags 在 resume 子命令之前（resume 不认后置 flag，实机验证）", () => {
  assert.deepEqual(buildArgs("继续", "t-123", WS), ["exec", ...FLAGS, "resume", "t-123", "继续"]);
});

test("translate: thread.started → session(threadId)", () => {
  const out = translate(JSON.stringify({ type: "thread.started", thread_id: "t-9" }));
  assert.deepEqual(out, [{ event: "session", data: { threadId: "t-9" } }]);
});

test("translate: agent_message → text", () => {
  const out = translate(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "答案是 2" } }));
  assert.deepEqual(out, [{ event: "text", data: { text: "答案是 2" } }]);
});

test("translate: command_execution → cmd，超长输出截断", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command: "ls -la", exit_code: 0, aggregated_output: "x".repeat(9000) },
  });
  const [o] = translate(line);
  assert.equal(o.event, "cmd");
  assert.equal(o.data.command, "ls -la");
  assert.equal(o.data.exitCode, 0);
  assert.ok(o.data.output.length < 8100);
  assert.ok(o.data.output.endsWith("…[truncated]"));
});

test("translate: file_change → files", () => {
  const out = translate(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.txt", kind: "add" }] } }));
  assert.deepEqual(out, [{ event: "files", data: { changes: [{ path: "a.txt", kind: "add" }] } }]);
});

test("translate: turn.completed → result；turn.failed / error → error", () => {
  assert.deepEqual(translate(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5 } })), [
    { event: "result", data: { usage: { input_tokens: 5 } } },
  ]);
  assert.equal(translate(JSON.stringify({ type: "turn.failed", error: { message: "boom" } }))[0].event, "error");
  assert.equal(translate(JSON.stringify({ type: "error", message: "bad" }))[0].event, "error");
});

test("translate: 空行 / 非 JSON / 不认识的事件 → []", () => {
  assert.deepEqual(translate(""), []);
  assert.deepEqual(translate("codex started"), []);
  assert.deepEqual(translate(JSON.stringify({ type: "item.started", item: { type: "agent_message" } })), []);
});
