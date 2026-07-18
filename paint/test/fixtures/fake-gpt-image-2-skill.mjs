#!/usr/bin/env node
// 打桩版 gpt-image-2-skill：不联网。--out 写个假文件，stderr 吐 JSONL 进度，
// stdout 吐 --json 信封。prompt 含 "FAIL" 则返回错误信封 + 退出码 1。
// prompt 含 "FLAKY"：第一次调用报 missing_image_result，第二次成功（用 out 旁的
// marker 文件记次数）。prompt 含 "ALWAYSMISSING"：每次都报 missing_image_result。
// prompt 含 "REALPNG"：写一张真实 1×1 PNG（测 XMP 嵌入用）。
import { writeFileSync, existsSync } from "node:fs";

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

const missing = {
  ok: false,
  error: {
    code: "missing_image_result",
    message: "The response did not include an image_generation_call result.",
    detail: { response_id: "resp_stub", output_text: "stub refusal text" },
  },
};

if (prompt.includes("ALWAYSMISSING")) {
  process.stdout.write(JSON.stringify(missing));
  process.exit(1);
}

if (prompt.includes("FLAKY")) {
  const marker = out + ".flaky-marker";
  if (!existsSync(marker)) {
    writeFileSync(marker, "1");
    process.stdout.write(JSON.stringify(missing));
    process.exit(1);
  }
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
if (out) writeFileSync(out, prompt.includes("REALPNG") ? TINY_PNG : "FAKEPNGDATA");
process.stderr.write(JSON.stringify({ data: { percent: 100, phase: "output_saved" }, kind: "progress", type: "output_saved" }) + "\n");
process.stdout.write(JSON.stringify({ ok: true, output: { path: out, bytes: 11 } }));
process.exit(0);
