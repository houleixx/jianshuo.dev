import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JobStore, type Job } from "../src/store.ts";
import { EventHub } from "../src/events.ts";
import { Worker } from "../src/worker.ts";
import { loadConfig } from "../src/config.ts";

const FAKE = resolve("test/fixtures/fake-gpt-image-2-skill.mjs");

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-worker-"));
  const cfg = loadConfig({ API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE } as any);
  const store = new JobStore(cfg.jobsDir);
  const hub = new EventHub();
  const worker = new Worker(store, hub, cfg);
  return { cfg, store, hub, worker };
}

function job(id: string, over: Partial<Job> = {}): Job {
  return {
    id, status: "queued", mode: "generate", prompt: "a cat",
    params: { size: "2K", format: "png", quality: "high", transparent: false },
    percent: 0, error: null, createdAt: new Date().toISOString(), ...over,
  };
}

async function waitFor(fn: () => Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout waiting for condition");
}

test("worker completes a generate job and writes result", async () => {
  const { store, worker, cfg } = await setup();
  await store.create(job("g1"));
  worker.enqueue("g1");
  await waitFor(async () => (await store.get("g1"))?.status === "done");
  const j = await store.get("g1");
  assert.equal(j?.percent, 100);
  assert.ok(j?.resultPath?.endsWith("g1.png"));
  assert.equal(await readFile(join(cfg.resultsDir, "g1.png"), "utf8"), "FAKEPNGDATA");
});

test("worker marks failed on engine error", async () => {
  const { store, worker } = await setup();
  await store.create(job("f1", { prompt: "please FAIL" }));
  worker.enqueue("f1");
  await waitFor(async () => (await store.get("f1"))?.status === "failed");
  const j = await store.get("f1");
  assert.equal(j?.error?.code, "http_error");
  assert.equal(j?.attempts, 1); // http_error 不可重试，只跑一次
});

test("missing_image_result 重试一次后成功", async () => {
  const { store, worker, cfg } = await setup();
  await store.create(job("r1", { prompt: "a FLAKY cat" }));
  worker.enqueue("r1");
  await waitFor(async () => (await store.get("r1"))?.status === "done");
  const j = await store.get("r1");
  assert.equal(j?.attempts, 2);
  assert.equal(j?.percent, 100);
  assert.equal(await readFile(join(cfg.resultsDir, "r1.png"), "utf8"), "FAKEPNGDATA");
});

test("missing_image_result 重试后仍失败：留痕 detail + attempts", async () => {
  const { store, worker } = await setup();
  await store.create(job("r2", { prompt: "ALWAYSMISSING" }));
  worker.enqueue("r2");
  await waitFor(async () => (await store.get("r2"))?.status === "failed");
  const j = await store.get("r2");
  assert.equal(j?.error?.code, "missing_image_result");
  assert.equal(j?.attempts, 2);
  // 失败留痕：CLI 返回的 detail 原样存进 job JSON，下次诊断不用猜
  assert.deepEqual((j?.error as any)?.detail, { response_id: "resp_stub", output_text: "stub refusal text" });
});

test("重试失败的回调 error 只带 code/message，不带 detail", async () => {
  const { store, worker } = await setup();
  const { createServer } = await import("node:http");
  const received: any[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { received.push(JSON.parse(b)); res.writeHead(200); res.end(); });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;

  await store.create(job("r3", { prompt: "ALWAYSMISSING", callbackUrl: `http://127.0.0.1:${port}/cb` }));
  worker.enqueue("r3");
  await waitFor(async () => received.length > 0);
  srv.close();

  assert.equal(received[0].status, "failed");
  assert.deepEqual(received[0].error, {
    code: "missing_image_result",
    message: "The response did not include an image_generation_call result.",
  });
});

test("worker fires callback on done", async () => {
  const { store, worker, cfg } = await setup();
  // local callback receiver
  const { createServer } = await import("node:http");
  const received: any[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { received.push({ headers: req.headers, body: JSON.parse(b) }); res.writeHead(200); res.end(); });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;

  await store.create(job("c1", { callbackUrl: `http://127.0.0.1:${port}/cb`, callbackToken: "xyz", callbackMeta: { note_id: "n1" } }));
  worker.enqueue("c1");
  await waitFor(async () => received.length > 0);
  srv.close();

  assert.equal(received[0].body.status, "done");
  assert.deepEqual(received[0].body.callback_meta, { note_id: "n1" });
  assert.ok(received[0].body.result_url.endsWith("/results/c1.png"));
  assert.equal(received[0].headers["authorization"], "Bearer xyz");
});

test("buildArgs failure → failed, input cleaned, pool still processes next", async () => {
  const { store, worker, cfg } = await setup();
  await mkdir(cfg.inputsDir, { recursive: true });
  const inputPath = join(cfg.inputsDir, "te.img");
  await writeFile(inputPath, "IN");
  await store.create(job("te", { mode: "edit", inputPath, params: { size: "2K", format: "png", quality: "high", transparent: true } }));
  worker.enqueue("te");
  await waitFor(async () => (await store.get("te"))?.status === "failed");
  await assert.rejects(readFile(inputPath)); // input cleaned despite early buildArgs throw
  // pool still alive: a normal job completes afterward
  await store.create(job("after"));
  worker.enqueue("after");
  await waitFor(async () => (await store.get("after"))?.status === "done");
});

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

test("pool drains all queued jobs", async () => {
  const { store, worker } = await setup();
  const ids = ["m1", "m2", "m3", "m4"];
  for (const id of ids) await store.create(job(id));
  for (const id of ids) worker.enqueue(id);
  for (const id of ids) await waitFor(async () => (await store.get(id))?.status === "done");
  for (const id of ids) assert.equal((await store.get(id))?.status, "done");
});
