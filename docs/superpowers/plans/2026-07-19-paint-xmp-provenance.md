# paint 出图自带 XMP 溯源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** paint 出的每张图（PNG/JPEG）在出图之后、回调之前，文件内写入 XMP 溯源元数据：prompt 全文（可关）、job_id、模型、时间，以及调用方经 `xmp_meta` 传入的业务字段（如 VoiceDrop 7 位魔法数字）。

**Architecture:** 新增零依赖 `src/xmp.ts`（拼 XMP 包 + 按文件签名嗅探插块：PNG 插 iTXt、JPEG 插 APP1、其余跳过）；`server.ts` 收参校验 `xmp_prompt`/`xmp_meta` 存进 Job；`worker.ts` 在产物 stat 成功后、标记 done 前嵌入，失败绝不连累任务。

**Tech Stack:** 纯 `node:*`（零运行时依赖，paint 既有哲学）、TypeScript、node:test + tsx。

**Spec:** `docs/superpowers/specs/2026-07-19-paint-xmp-provenance-design.md`（仓库根目录下）。

## Global Constraints

- 零运行时依赖：只许 `node:*` 内置模块，不装任何 npm 包、不装系统工具。
- 所有命令在 `paint/` 目录下执行；测试命令：`npm test`（= `node --import tsx --test test/*.test.ts`）。
- `xmp_meta`：只收字符串值；key 必须匹配 `^[A-Za-z0-9_]{1,32}$`；`JSON.stringify` 总长 > 4096 → 整个请求 400（不静默截断）。
- `xmp_prompt` 默认 `true`；只有显式 `false` 才不写 prompt。
- 元数据写入失败绝不让任务失败：catch + log，照常 done + 回调。
- WebP 与无法识别的文件格式：跳过写入，log 一行。
- 提交信息末尾带（原样两行）：
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01T2h44zj2mNFt6joJnv6Lj4`

---

### Task 1: `src/xmp.ts` — buildXmp（拼 XMP 包）

**Files:**
- Create: `paint/src/xmp.ts`
- Test: `paint/test/xmp.test.ts`

**Interfaces:**
- Produces: `buildXmp(f: XmpFields): string`，其中
  `XmpFields = { prompt?: string; jobId: string; model: string; createDate: string; meta?: Record<string, string> }`。
  `prompt` 为 `undefined` 时输出不含 `dc:description`。Task 2 的 `embedXmp` 与 Task 4 的 worker 都消费它。

- [ ] **Step 1: 写失败测试**

创建 `paint/test/xmp.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL（`Cannot find module '../src/xmp.ts'`）

- [ ] **Step 3: 最小实现**

创建 `paint/src/xmp.ts`：

```ts
// src/xmp.ts — 出图文件内嵌 XMP 溯源（spec: docs/superpowers/specs/2026-07-19-paint-xmp-provenance-design.md）
// 零依赖：XMP 包手拼；PNG/JPEG 的插块在本文件（Task 2 的 embedXmp）。

export interface XmpFields {
  /** undefined = 不写 dc:description（调用方 xmp_prompt:false） */
  prompt?: string;
  jobId: string;
  model: string;
  /** ISO 8601 */
  createDate: string;
  meta?: Record<string, string>;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);

export function buildXmp(f: XmpFields): string {
  const attrs = [
    `xmp:CreatorTool="gpt-image-2 via paint.jianshuo.dev"`,
    `xmp:CreateDate="${esc(f.createDate)}"`,
    `paint:JobId="${esc(f.jobId)}"`,
    `paint:Model="${esc(f.model)}"`,
    ...Object.entries(f.meta ?? {}).map(([k, v]) => `paint:${cap(k)}="${esc(v)}"`),
  ];
  const desc = f.prompt === undefined
    ? ""
    : `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(f.prompt)}</rdf:li></rdf:Alt></dc:description>`;
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:paint="https://paint.jianshuo.dev/ns/1.0/" ${attrs.join(" ")}>${desc}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS（新增 2 条全绿，既有测试不受影响）

- [ ] **Step 5: Commit**

```bash
git add paint/src/xmp.ts paint/test/xmp.test.ts
git commit -m "feat(paint): buildXmp 拼 XMP 溯源包"
```

---

### Task 2: `src/xmp.ts` — embedXmp（PNG iTXt / JPEG APP1 插块）

**Files:**
- Modify: `paint/src/xmp.ts`（追加）
- Test: `paint/test/xmp.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `buildXmp`。
- Produces: `embedXmp(path: string, xmp: string): Promise<{ embedded: boolean; reason?: string }>`。
  按文件**内容签名**（不是扩展名）嗅探格式；不认识 → `{embedded:false, reason}` 不改文件；
  写入 = 临时文件 + rename 原子落盘。Task 4 的 worker 消费它。

- [ ] **Step 1: 写失败测试**

`paint/test/xmp.test.ts` 追加（文件顶部 import 区补上这几行）：

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { embedXmp } from "../src/xmp.ts";
```

测试体追加：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: FAIL（`embedXmp` 未导出）

- [ ] **Step 3: 最小实现**

`paint/src/xmp.ts` 顶部加 import，文件末尾追加：

```ts
import { readFile, writeFile, rename } from "node:fs/promises";

export interface EmbedResult {
  embedded: boolean;
  reason?: string;
}

// PNG CRC32（不用 node:zlib 的 crc32——那是 v22.2+ 才有，查表 10 行更稳）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** IHDR 块之后插 iTXt（keyword XML:com.adobe.xmp），XMP 的 PNG 标准位置 */
function pngInsert(data: Buffer, xmp: string): Buffer {
  const ihdrLen = data.readUInt32BE(8);
  const insertAt = 8 + 12 + ihdrLen; // 签名 + IHDR(len+type+data+crc)
  // iTXt payload: keyword\0 compressionFlag(0) compressionMethod(0) langTag\0 translatedKeyword\0 text
  const payload = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(xmp, "utf8")]);
  const chunk = Buffer.concat([
    Buffer.alloc(4), Buffer.from("iTXt", "latin1"), payload, Buffer.alloc(4),
  ]);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return Buffer.concat([data.subarray(0, insertAt), chunk, data.subarray(insertAt)]);
}

/** SOI 之后插 APP1 XMP 段；段长上限 0xFFFF，超了返回原因字符串 */
function jpegInsert(data: Buffer, xmp: string): Buffer | string {
  const payload = Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(xmp, "utf8")]);
  if (payload.length + 2 > 0xffff) return "xmp too large for jpeg APP1";
  const seg = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), payload]);
  seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([data.subarray(0, 2), seg, data.subarray(2)]);
}

/** 按内容签名嗅探（webp/未知格式跳过），临时文件 + rename 原子写回 */
export async function embedXmp(path: string, xmp: string): Promise<EmbedResult> {
  const data = await readFile(path);
  let out: Buffer | null = null;
  let reason = "unsupported format";
  if (data.length > 33 && data.subarray(0, 8).equals(PNG_SIG)) {
    out = pngInsert(data, xmp);
  } else if (data.length > 2 && data[0] === 0xff && data[1] === 0xd8) {
    const r = jpegInsert(data, xmp);
    if (typeof r === "string") reason = r;
    else out = r;
  }
  if (!out) return { embedded: false, reason };
  const tmp = `${path}.xmp-tmp`;
  await writeFile(tmp, out);
  await rename(tmp, path);
  return { embedded: true };
}
```

同时把文件原有的（Task 1 写的）无 import 状态改为顶部统一 import——`readFile/writeFile/rename` 只在这一处 import。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS（xmp.test.ts 5 条全绿）

- [ ] **Step 5: Commit**

```bash
git add paint/src/xmp.ts paint/test/xmp.test.ts
git commit -m "feat(paint): embedXmp — PNG iTXt / JPEG APP1 原子插块"
```

---

### Task 3: API 契约 — `xmp_prompt` / `xmp_meta` 收参校验入库

**Files:**
- Modify: `paint/src/store.ts`（`Job` interface，约 :29 `callbackMeta` 之后）
- Modify: `paint/src/server.ts`（`submitJob`，约 :188 `transparent` 之后）
- Test: `paint/test/routes.test.ts`（追加）

**Interfaces:**
- Produces: `Job` 新增字段 `xmpPrompt?: boolean`（`false` = 不写 prompt，缺省/`true` = 写）、
  `xmpMeta?: Record<string, string>`。Task 4 的 worker 消费这两个字段。

- [ ] **Step 1: 写失败测试**

`paint/test/routes.test.ts` 追加（沿用文件里现成的 `boot()`）：

```ts
test("POST /api/jobs accepts xmp_prompt and xmp_meta", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
    body: JSON.stringify({ prompt: "a cat", xmp_prompt: false, xmp_meta: { magic: "1234567" } }),
  });
  assert.equal(res.status, 202);
  app.close();
});

test("POST /api/jobs 400 on bad xmp_meta", async () => {
  const { app, base } = await boot();
  const post = (body: unknown) =>
    fetch(`${base}/api/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify(body),
    });
  // 非对象
  assert.equal((await post({ prompt: "a cat", xmp_meta: "nope" })).status, 400);
  // 坏 key（带连字符）
  assert.equal((await post({ prompt: "a cat", xmp_meta: { "bad-key": "v" } })).status, 400);
  // 非字符串值
  assert.equal((await post({ prompt: "a cat", xmp_meta: { magic: 123 } })).status, 400);
  // 总量超 4KB
  assert.equal((await post({ prompt: "a cat", xmp_meta: { big: "x".repeat(5000) } })).status, 400);
  app.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: 第一条 PASS（未知字段本就被忽略），第二条 FAIL（坏 `xmp_meta` 目前返回 202 不是 400）——失败证明校验尚不存在。

- [ ] **Step 3: 实现**

`paint/src/store.ts` 的 `Job` interface，`callbackMeta?: unknown;` 之后加：

```ts
  /** false = 不把 prompt 写入图片 XMP（默认写）；spec 2026-07-19-paint-xmp-provenance */
  xmpPrompt?: boolean;
  xmpMeta?: Record<string, string>;
```

`paint/src/server.ts` 的 `submitJob`，`const transparent = ...`（:188）之后加：

```ts
  // XMP 溯源参数（spec: docs/superpowers/specs/2026-07-19-paint-xmp-provenance-design.md）
  let xmpMeta: Record<string, string> | undefined;
  if (body.xmp_meta !== undefined) {
    if (typeof body.xmp_meta !== "object" || body.xmp_meta === null || Array.isArray(body.xmp_meta))
      return sendJson(res, 400, { error: "xmp_meta must be an object" });
    for (const [k, v] of Object.entries(body.xmp_meta)) {
      if (!/^[A-Za-z0-9_]{1,32}$/.test(k)) return sendJson(res, 400, { error: `xmp_meta bad key: ${k}` });
      if (typeof v !== "string") return sendJson(res, 400, { error: "xmp_meta values must be strings" });
    }
    if (JSON.stringify(body.xmp_meta).length > 4096) return sendJson(res, 400, { error: "xmp_meta too large (4KB)" });
    xmpMeta = body.xmp_meta;
  }
```

同函数的 `const job: Job = {...}` 字面量里，`callbackMeta: body.callback_meta,` 之后加：

```ts
    xmpPrompt: body.xmp_prompt !== false,
    xmpMeta,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git add paint/src/store.ts paint/src/server.ts paint/test/routes.test.ts
git commit -m "feat(paint): POST /api/jobs 收 xmp_prompt / xmp_meta（校验 + 入库）"
```

---

### Task 4: worker 集成 — 出图后、回调前嵌入

**Files:**
- Modify: `paint/src/worker.ts`（`run()` 内 :83 附近，`if (!ok)` 之后、`store.update` done 之前）
- Modify: `paint/test/fixtures/fake-gpt-image-2-skill.mjs`（加 REALPNG 模式）
- Test: `paint/test/worker.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1/2 的 `buildXmp` + `embedXmp`；Task 3 的 `job.xmpPrompt` / `job.xmpMeta`。
- Produces: 行为——done 时 `resultPath` 文件已含 XMP；`bytes` 反映嵌入后的实际大小。

- [ ] **Step 1: 给打桩 CLI 加 REALPNG 模式**

`paint/test/fixtures/fake-gpt-image-2-skill.mjs`，`if (out) writeFileSync(out, "FAKEPNGDATA");`（:46）改为：

```js
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
if (out) writeFileSync(out, prompt.includes("REALPNG") ? TINY_PNG : "FAKEPNGDATA");
```

并在文件头注释里补一行：`// prompt 含 "REALPNG"：写一张真实 1×1 PNG（测 XMP 嵌入用）。`

- [ ] **Step 2: 写失败测试**

`paint/test/worker.test.ts` 追加：

```ts
test("worker embeds XMP into real PNG result before done", async () => {
  const { store, worker, cfg } = await setup();
  await store.create(job("x1", { prompt: "REALPNG a cat", xmpMeta: { magic: "1234567" } }));
  worker.enqueue("x1");
  await waitFor(async () => (await store.get("x1"))?.status === "done");
  const buf = await readFile(join(cfg.resultsDir, "x1.png"));
  assert.ok(buf.includes(Buffer.from("W5M0MpCehiHzreSzNTczkc9d"))); // XMP 已入文件
  assert.ok(buf.includes(Buffer.from("REALPNG a cat")));            // prompt 默认写入
  assert.ok(buf.includes(Buffer.from('paint:Magic="1234567"')));    // xmp_meta 透传
  const j = await store.get("x1");
  assert.equal(j?.bytes, buf.length); // bytes 是嵌入后的大小
});

test("worker respects xmpPrompt=false (no prompt in file)", async () => {
  const { store, worker, cfg } = await setup();
  await store.create(job("x2", { prompt: "REALPNG secret words", xmpPrompt: false }));
  worker.enqueue("x2");
  await waitFor(async () => (await store.get("x2"))?.status === "done");
  const buf = await readFile(join(cfg.resultsDir, "x2.png"));
  assert.ok(buf.includes(Buffer.from("W5M0MpCehiHzreSzNTczkc9d"))); // 基础字段仍写
  assert.ok(!buf.includes(Buffer.from("secret words")));            // prompt 不写
});

test("worker still completes when result is not embeddable", async () => {
  const { store, worker, cfg } = await setup();
  await store.create(job("x3")); // 默认 fake 写 "FAKEPNGDATA"，非 PNG → 跳过嵌入
  worker.enqueue("x3");
  await waitFor(async () => (await store.get("x3"))?.status === "done");
  assert.equal(await readFile(join(cfg.resultsDir, "x3.png"), "utf8"), "FAKEPNGDATA"); // 文件原样
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd paint && npm test`
Expected: 前两条 FAIL（文件里没有 XMP），第三条 PASS（现状本来就 done）

- [ ] **Step 4: 实现**

`paint/src/worker.ts` 顶部 import 区加：

```ts
import { buildXmp, embedXmp } from "./xmp.js";
```

`run()` 内，`if (!ok) { ... return; }` 之后、`const done = await this.store.update(...)` 之前插入：

```ts
    // 出图后、回调前：嵌 XMP 溯源。失败绝不连累任务（spec §4）。
    try {
      const xmp = buildXmp({
        prompt: job.xmpPrompt === false ? undefined : job.prompt,
        jobId: id,
        model: "gpt-image-2",
        createDate: new Date().toISOString(),
        meta: job.xmpMeta,
      });
      const embed = await embedXmp(outPath, xmp);
      if (embed.embedded) bytes = (await stat(outPath)).size; // 文件变大了，bytes 取嵌入后的
      else console.log(`[worker] xmp skipped for ${id}: ${embed.reason}`);
    } catch (e) {
      console.error(`[worker] xmp embed failed for ${id}`, e);
    }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd paint && npm test`
Expected: PASS（全部，含既有 worker/routes/callback 等测试——FAKEPNGDATA 路径行为不变是回归关键）

- [ ] **Step 6: Commit**

```bash
git add paint/src/worker.ts paint/test/worker.test.ts paint/test/fixtures/fake-gpt-image-2-skill.mjs
git commit -m "feat(paint): worker 出图后回调前嵌入 XMP 溯源"
```

---

### Task 5: 构建、部署、线上验证

**Files:**
- 无代码改动（构建 + 部署 + 验证）

- [ ] **Step 1: 本地构建 + 全量测试**

Run: `cd paint && npm run build && npm test`
Expected: tsc 零错误，测试全绿

- [ ] **Step 2: 部署到 VPS**

Run: `cd paint && ./deploy.sh`
Expected: 脚本走完 build+test → rsync → 重启，无报错

- [ ] **Step 3: 线上出一张真图**

```bash
API_TOKEN=$(ssh root@66.42.45.128 "grep '^API_TOKEN=' /opt/paint/.env | cut -d= -f2")
JOB=$(curl -s -X POST https://paint.jianshuo.dev/api/jobs \
  -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"a single red apple on a white table, soft light","size":"1024x1024","xmp_meta":{"magic":"1234567","source":"deploy-verify"}}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['job_id'])")
echo "job: $JOB"
# 轮询到 done（出图约 1-2 分钟）
curl -s https://paint.jianshuo.dev/api/jobs/$JOB -H "Authorization: Bearer $API_TOKEN" | python3 -m json.tool
```

Expected: `status: "done"`，拿到 `result_url`

- [ ] **Step 4: 下载结果验证 XMP**

```bash
curl -s -o /tmp/paint-verify.png "<上一步的 result_url>"
python3 - <<'EOF'
import struct
data = open("/tmp/paint-verify.png","rb").read()
assert data[:8] == b'\x89PNG\r\n\x1a\n', "not a PNG"
found = False
i = 8
while i < len(data):
    l = struct.unpack('>I', data[i:i+4])[0]; t = data[i+4:i+8]
    if t == b'iTXt':
        text = data[i+8:i+8+l].decode('utf-8','replace')
        assert 'paint:Magic="1234567"' in text, "magic missing"
        assert 'paint:JobId=' in text and 'red apple' in text, "fields missing"
        found = True
    i += 12 + l
assert found, "no iTXt chunk"
print("XMP verified: magic/jobId/prompt all present, image opens fine")
EOF
sips -g pixelWidth /tmp/paint-verify.png
```

Expected: `XMP verified...` + sips 正常报尺寸

- [ ] **Step 5: 收尾提交（如有 deploy 期间的小修）并推送**

```bash
git push origin HEAD:main
```

---

## 后续（不在本计划内，各自单独做）

- prompt-lab 代理端点带 `xmp_meta: {source, prompt_id, magic?}`（voicedrop-agent 仓库）。
- VoiceDrop `edit_photo` 传 `xmp_prompt:false` + `xmp_meta: {source:"voicedrop"}`（voicedrop-agent 仓库；注意其部署纪律：先合 origin/main 再 deploy）。
