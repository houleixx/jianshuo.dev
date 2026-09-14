// 增量 JSONL 读取的单测（2026-09-12）。钉的是：续读只吐新增行、半行不吐也不越过、
// 超长行丢弃且不影响后面的行、yieldTail 只在一次性读时吐末尾无换行的行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonlLinesFrom, jsonlLines } from "../dist/jsonl.js";

async function collect(gen) {
  const out = [];
  for await (const l of gen) out.push(l);
  return out;
}
async function withFile(fn) {
  const dir = await mkdtemp(join(tmpdir(), "jsonl-"));
  try { await fn(join(dir, "a.jsonl")); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("续读：第二次只吐新追加的行，offset 跟着走", async () => {
  await withFile(async (p) => {
    await writeFile(p, '{"n":1}\n{"n":2}\n');
    const cur = { offset: 0 };
    assert.deepEqual(await collect(jsonlLinesFrom(p, cur)), ['{"n":1}', '{"n":2}']);
    const after2 = cur.offset;
    assert.equal(after2, Buffer.byteLength('{"n":1}\n{"n":2}\n'));
    await appendFile(p, '{"n":3,"汉":"字"}\n');
    assert.deepEqual(await collect(jsonlLinesFrom(p, cur)), ['{"n":3,"汉":"字"}']);
    assert.deepEqual(await collect(jsonlLinesFrom(p, cur)), []);
  });
});

test("半行不吐、offset 不越过；补齐换行后才吐一次", async () => {
  await withFile(async (p) => {
    await writeFile(p, '{"n":1}\n{"n":2');
    const cur = { offset: 0 };
    assert.deepEqual(await collect(jsonlLinesFrom(p, cur)), ['{"n":1}']);
    assert.equal(cur.offset, Buffer.byteLength('{"n":1}\n'));
    await appendFile(p, '}\n');
    assert.deepEqual(await collect(jsonlLinesFrom(p, cur)), ['{"n":2}']);
  });
});

test("超长行整行丢弃，后面的行照常", async () => {
  await withFile(async (p) => {
    const big = '{"x":"' + "a".repeat(5000) + '"}';
    await writeFile(p, '{"n":1}\n' + big + '\n{"n":3}\n');
    const cur = { offset: 0 };
    assert.deepEqual(await collect(jsonlLinesFrom(p, cur, { maxLineBytes: 1000 })), ['{"n":1}', '{"n":3}']);
    assert.equal(cur.offset, Buffer.byteLength('{"n":1}\n' + big + '\n{"n":3}\n'));
  });
});

test("一次性读（jsonlLines）吐末尾没有换行符的行；增量读不吐", async () => {
  await withFile(async (p) => {
    await writeFile(p, '{"n":1}\n{"n":2}');
    assert.deepEqual(await collect(jsonlLines(p)), ['{"n":1}', '{"n":2}']);
    assert.deepEqual(await collect(jsonlLinesFrom(p, { offset: 0 })), ['{"n":1}']);
  });
});
