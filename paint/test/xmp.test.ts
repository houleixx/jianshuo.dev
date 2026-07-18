import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildXmp, embedXmp } from "../src/xmp.ts";

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

// 1×1 有效 PNG（IHDR/IDAT/IEND 齐全）
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function tmpFile(name: string, data: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "paint-xmp-"));
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}

test("embedXmp inserts iTXt into PNG after IHDR, image structure intact", async () => {
  const p = await tmpFile("a.png", TINY_PNG);
  const r = await embedXmp(p, buildXmp({ jobId: "j", model: "m", createDate: "2026-01-01T00:00:00Z" }));
  assert.equal(r.embedded, true);
  const out = await readFile(p);
  // PNG 签名保留
  assert.ok(out.subarray(0, 8).equals(TINY_PNG.subarray(0, 8)));
  // iTXt 块出现在 IHDR（8+25=33 字节处）之后，keyword 正确
  assert.equal(out.subarray(33 + 4, 33 + 8).toString("latin1"), "iTXt");
  assert.ok(out.includes(Buffer.from("XML:com.adobe.xmp")));
  assert.ok(out.includes(Buffer.from("W5M0MpCehiHzreSzNTczkc9d")));
  // 原图数据一个字节不少（IHDR 之后的原内容整体后移）
  assert.ok(out.includes(TINY_PNG.subarray(33)));
});

test("embedXmp inserts APP1 into JPEG after SOI", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // SOI + EOI（结构最小 JPEG）
  const p = await tmpFile("a.jpg", jpeg);
  const r = await embedXmp(p, buildXmp({ jobId: "j", model: "m", createDate: "2026-01-01T00:00:00Z" }));
  assert.equal(r.embedded, true);
  const out = await readFile(p);
  assert.equal(out[0], 0xff); assert.equal(out[1], 0xd8); // SOI
  assert.equal(out[2], 0xff); assert.equal(out[3], 0xe1); // APP1 紧随其后
  assert.ok(out.includes(Buffer.from("http://ns.adobe.com/xap/1.0/\0")));
  assert.equal(out[out.length - 2], 0xff); assert.equal(out[out.length - 1], 0xd9); // EOI 仍在结尾
});

test("embedXmp skips unknown format without touching file", async () => {
  const p = await tmpFile("a.bin", Buffer.from("FAKEPNGDATA"));
  const r = await embedXmp(p, "<xmp/>");
  assert.equal(r.embedded, false);
  assert.ok(r.reason);
  assert.equal((await readFile(p)).toString(), "FAKEPNGDATA"); // 文件原封不动
});
