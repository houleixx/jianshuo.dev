import { test } from "node:test";
import assert from "node:assert/strict";
import { buildXmp } from "../src/xmp.ts";

test("buildXmp includes prompt, standard fields, and meta", () => {
  const x = buildXmp({
    prompt: '画一只 <猫> & "狗"',
    jobId: "job-1", model: "gpt-image-2",
    createDate: "2026-07-19T00:00:00Z",
    meta: { magic: "1234567", source: "prompt-lab" },
  });
  assert.ok(x.includes("W5M0MpCehiHzreSzNTczkc9d")); // xpacket magic
  assert.ok(x.includes("画一只 &lt;猫&gt; &amp; &quot;狗&quot;")); // XML 转义
  assert.ok(x.includes('xmp:CreatorTool="gpt-image-2 via paint.jianshuo.dev"'));
  assert.ok(x.includes('xmp:CreateDate="2026-07-19T00:00:00Z"'));
  assert.ok(x.includes('paint:JobId="job-1"'));
  assert.ok(x.includes('paint:Model="gpt-image-2"'));
  assert.ok(x.includes('paint:Magic="1234567"')); // key 首字母大写
  assert.ok(x.includes('paint:Source="prompt-lab"'));
  assert.ok(x.includes('xmlns:paint="https://paint.jianshuo.dev/ns/1.0/"'));
});

test("buildXmp omits dc:description when prompt undefined", () => {
  const x = buildXmp({ jobId: "j", model: "m", createDate: "2026-01-01T00:00:00Z" });
  assert.ok(!x.includes("dc:description"));
  assert.ok(x.includes('paint:JobId="j"'));
});
