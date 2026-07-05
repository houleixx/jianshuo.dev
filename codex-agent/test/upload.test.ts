import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FAKE = resolve("test/fixtures/fake-codex.mjs");

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "codex-files-"));
  process.env.CODEX_BIN = process.execPath;
  process.env.CODEX_ARGS_PREFIX = FAKE;
  process.env.SESSIONS_FILE = join(dir, "sessions.json");
  process.env.WORKSPACE = dir;
  const { createApp } = await import("../src/server.ts");
  const app = createApp();
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  return { app, base, dir };
}

function upload(base: string, filename: string, content: string) {
  const fd = new FormData();
  fd.append("file", new Blob([content]), filename);
  return fetch(`${base}/api/upload`, { method: "POST", body: fd });
}

test("上传：文件落进 workspace，返回 name+size", async () => {
  const { app, base, dir } = await boot();
  const res = await upload(base, "hello.txt", "你好 codex");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, "hello.txt");
  assert.equal(await readFile(join(dir, "hello.txt"), "utf8"), "你好 codex");
  app.close();
});

test("上传：文件名穿越被压平（../../evil.txt → evil.txt 落在 workspace）", async () => {
  const { app, base, dir } = await boot();
  const res = await upload(base, "../../evil.txt", "x");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, "evil.txt");
  assert.equal(await readFile(join(dir, "evil.txt"), "utf8"), "x");
  app.close();
});

test("列表：/api/files 列出 workspace 顶层文件", async () => {
  const { app, base, dir } = await boot();
  await writeFile(join(dir, "a.txt"), "aaa");
  await writeFile(join(dir, "b.csv"), "b,b");
  const res = await fetch(`${base}/api/files`);
  const list = await res.json();
  const names = list.map((f: any) => f.name).sort();
  assert.deepEqual(names, ["a.txt", "b.csv"]);
  assert.equal(list.find((f: any) => f.name === "a.txt").size, 3);
  app.close();
});

test("下载：/api/files/<name> 返回原字节 + attachment 头", async () => {
  const { app, base, dir } = await boot();
  await writeFile(join(dir, "data.txt"), "下载内容");
  const res = await fetch(`${base}/api/files/data.txt`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(await res.text(), "下载内容");
  app.close();
});

test("下载：不存在的文件 → 404", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/files/nope.txt`);
  assert.equal(res.status, 404);
  app.close();
});

test("下载：穿越串被压平后找不到 → 404（不泄露 workspace 外文件）", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/files/${encodeURIComponent("../../../etc/passwd")}`);
  assert.equal(res.status, 404); // basename → passwd，workspace 里没有
  app.close();
});
