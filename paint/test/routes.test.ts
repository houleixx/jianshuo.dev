import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { JobStore } from "../src/store.ts";
import { EventHub } from "../src/events.ts";
import { Worker } from "../src/worker.ts";
import { createApp } from "../src/server.ts";

const FAKE = resolve("test/fixtures/fake-gpt-image-2-skill.mjs");

async function boot() {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-routes-"));
  const cfg = loadConfig({ API_TOKEN: "secret", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE, PUBLIC_BASE_URL: "http://localhost" } as any);
  const store = new JobStore(cfg.jobsDir);
  const hub = new EventHub();
  const worker = new Worker(store, hub, cfg);
  const app = createApp(cfg, { store, hub, worker });
  await new Promise<void>((r) => app.listen(0, r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  return { app, base };
}

test("POST /api/jobs requires bearer", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  app.close();
});

test("POST /api/jobs 400 when prompt missing", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
  app.close();
});

test("full generate flow: submit → poll done → fetch result", async () => {
  const { app, base } = await boot();
  const sub = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "a cat" }) });
  assert.equal(sub.status, 202);
  const { job_id } = await sub.json();
  assert.ok(job_id);

  let status = "";
  for (let i = 0; i < 200; i++) {
    const r = await fetch(`${base}/api/jobs/${job_id}`, { headers: { Authorization: "Bearer secret" } });
    const j = await r.json();
    status = j.status;
    if (status === "done" || status === "failed") {
      if (status === "done") {
        const img = await fetch(`${base}${new URL(j.result_url).pathname}`);
        assert.equal(img.status, 200);
        assert.equal(await img.text(), "FAKEPNGDATA");
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(status, "done");
  app.close();
});

test("results path traversal blocked", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/results/..%2f..%2fetc%2fpasswd`);
  assert.ok(res.status === 400 || res.status === 404);
  app.close();
});
