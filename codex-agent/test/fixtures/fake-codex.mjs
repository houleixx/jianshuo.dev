#!/usr/bin/env node
// 打桩版 codex exec：不联网。按真实 --json 的 JSONL 形状吐事件。
// - `exec resume <id> <prompt>` → thread_id 沿用 <id>，回声里带 "resumed:<id>"
// - prompt 含 "CMD"  → 多吐一条 command_execution
// - prompt 含 "FAIL" → turn.failed + 退出码 1
// - prompt 含 "SLOW" → 出结果前睡 300ms（测并发闸用）
const args = process.argv.slice(2);
const isResume = args[0] === "exec" && args[1] === "resume";
const threadId = isResume ? args[2] : "t-fake-0001";
const positional = args.filter(
  (a, i) => !a.startsWith("-") && !["exec", "resume"].includes(a) && !/^(-s|-C|-c)$/.test(args[i - 1] ?? ""),
);
const prompt = positional[positional.length - 1] ?? "";

const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
line({ type: "thread.started", thread_id: threadId });

if (prompt.includes("SLOW")) await new Promise((r) => setTimeout(r, 300));

if (prompt.includes("FAIL")) {
  line({ type: "turn.failed", error: { message: "stub turn failure" } });
  process.exit(1);
}
if (prompt.includes("CMD")) {
  line({ type: "item.completed", item: { type: "command_execution", command: "echo hi", exit_code: 0, aggregated_output: "hi\n" } });
}
line({ type: "item.completed", item: { type: "agent_message", text: (isResume ? `resumed:${threadId} ` : "") + "echo: " + prompt } });
line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
process.exit(0);
