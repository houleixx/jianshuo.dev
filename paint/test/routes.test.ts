import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";
import { JobStore } from "../src/store.ts";
import { EventHub } from "../src/events.ts";
import { Worker } from "../src/worker.ts";
import { createApp, isBlockedHost } from "../src/server.ts";

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
        assert.equal(j.attempts, 1); // API 暴露 attempts，供诊断
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

test("GET /results/<missing> returns 404", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/results/does-not-exist-0000.png`);
  assert.equal(res.status, 404);
  app.close();
});

test("isBlockedHost blocks private/loopback/link-local incl IPv4-mapped IPv6, allows public", () => {
  const blocked = ["http://127.0.0.1/","http://10.0.0.1/","http://192.168.1.1/","http://169.254.169.254/","http://172.16.0.1/","http://172.31.9.9/","http://0.0.0.0/","http://localhost/","http://[::1]/","http://[fd00::1]/","http://[fe80::1]/","http://[::ffff:169.254.169.254]/","http://[::ffff:127.0.0.1]/"];
  for (const u of blocked) assert.equal(isBlockedHost(new URL(u).hostname), true, `should block ${u}`);
  const allowed = ["http://example.com/","http://fda.gov/","http://fdic.gov/","http://172.15.0.1/","http://172.32.0.1/","http://11.0.0.1/","http://8.8.8.8/","http://jianshuo.dev/"];
  for (const u of allowed) assert.equal(isBlockedHost(new URL(u).hostname), false, `should allow ${u}`);
});

test("POST image_url to a blocked host is rejected by the SSRF guard", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "x", image_url: "http://[::ffff:169.254.169.254]/x.png" }) });
  assert.equal(res.status, 400);
  const j = await res.json();
  assert.equal(j.error, "image_url host not allowed"); // gates the guard specifically, not a fetch failure
  app.close();
});

test("POST image_b64 over size cap is rejected", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-routes-"));
  const cfg = loadConfig({ API_TOKEN: "secret", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, GPT_IMAGE_BIN: FAKE, PUBLIC_BASE_URL: "http://localhost", MAX_INPUT_BYTES: "10" } as any);
  const store = new JobStore(cfg.jobsDir); const hub = new EventHub(); const worker = new Worker(store, hub, cfg);
  const app = createApp(cfg, { store, hub, worker });
  await new Promise((r) => app.listen(0, r));
  const b = `http://127.0.0.1:${(app.address()).port}`;
  const big = Buffer.from("A".repeat(1000)).toString("base64");
  const res = await fetch(`${b}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "x", image_b64: big }) });
  assert.equal(res.status, 400);
  app.close();
});

test("GET /api/jobs?limit=abc does not crash", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs?limit=abc`, { headers: { Authorization: "Bearer secret" } });
  assert.equal(res.status, 200);
  app.close();
});

test("SSE streams to a terminal event for a generate job", async () => {
  const { app, base } = await boot();
  const sub = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "a cat" }) });
  const { job_id } = await sub.json();
  const es = await fetch(`${base}/api/jobs/${job_id}/events`, { headers: { Authorization: "Bearer secret" } });
  const reader = es.body.getReader();
  const dec = new TextDecoder();
  let buf = "", saw = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    if (buf.includes("event: done") || buf.includes("event: failed")) { saw = true; break; }
  }
  await reader.cancel().catch(() => {});
  assert.ok(saw);
  app.close();
});

test("GET /api/jobs/<missing>/events returns 404", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs/does-not-exist/events`, { headers: { Authorization: "Bearer secret" } });
  assert.equal(res.status, 404);
  app.close();
});

test("POST /api/jobs with malformed JSON returns 400", async () => {
  const { app, base } = await boot();
  const res = await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: "{not json" });
  assert.equal(res.status, 400);
  app.close();
});

test("GET /log renders a jobs table with prompts", async () => {
  const { app, base } = await boot();
  await fetch(`${base}/api/jobs`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer secret" }, body: JSON.stringify({ prompt: "LOGTEST-PROMPT-xyz" }) });
  const res = await fetch(`${base}/log`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /paint 任务日志/);
  assert.match(html, /LOGTEST-PROMPT-xyz/);
  app.close();
});
