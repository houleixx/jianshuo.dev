#!/usr/bin/env node
// 打桩版 gpt-image-2-skill：不联网。--out 写个假文件，stderr 吐 JSONL 进度，
// stdout 吐 --json 信封。prompt 含 "FAIL" 则返回错误信封 + 退出码 1。
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : null;
const promptIdx = args.indexOf("--prompt");
const prompt = promptIdx >= 0 ? args[promptIdx + 1] : "";

process.stderr.write(JSON.stringify({ data: { percent: 0, phase: "request_started" }, kind: "progress", type: "request_started" }) + "\n");
process.stderr.write(JSON.stringify({ kind: "sse", type: "keepalive", data: {} }) + "\n");
process.stderr.write(JSON.stringify({ data: { percent: 95, phase: "request_completed" }, kind: "progress", type: "request_completed" }) + "\n");

if (prompt.includes("FAIL")) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "http_error", message: "stub failure" } }));
  process.exit(1);
}

if (out) writeFileSync(out, "FAKEPNGDATA");
process.stderr.write(JSON.stringify({ data: { percent: 100, phase: "output_saved" }, kind: "progress", type: "output_saved" }) + "\n");
process.stdout.write(JSON.stringify({ ok: true, output: { path: out, bytes: 11 } }));
process.exit(0);
