import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  assert.equal((await store.get("f1"))?.error?.code, "http_error");
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
