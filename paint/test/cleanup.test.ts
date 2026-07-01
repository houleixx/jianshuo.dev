import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, type Job } from "../src/store.ts";
import { loadConfig } from "../src/config.ts";
import { sweep } from "../src/cleanup.ts";

test("sweep deletes expired jobs and their files", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "paint-clean-"));
  const cfg = loadConfig({ API_TOKEN: "t", CALLBACK_SIGNING_SECRET: "s", DATA_DIR: dataDir, RETENTION_DAYS: "30" } as any);
  const store = new JobStore(cfg.jobsDir);
  await mkdir(cfg.resultsDir, { recursive: true });

  const now = Date.parse("2026-07-01T00:00:00Z");
  const oldPath = join(cfg.resultsDir, "old.png");
  await writeFile(oldPath, "x");
  const old: Job = { id: "old", status: "done", mode: "generate", prompt: "p", params: { size: "2K", format: "png", quality: "high", transparent: false }, percent: 100, error: null, createdAt: "2026-05-01T00:00:00Z", resultPath: oldPath };
  const fresh: Job = { ...old, id: "fresh", createdAt: "2026-06-30T00:00:00Z", resultPath: join(cfg.resultsDir, "fresh.png") };
  await writeFile(fresh.resultPath!, "y");
  await store.create(old);
  await store.create(fresh);

  const { deleted } = await sweep(store, cfg, now);
  assert.equal(deleted, 1);
  assert.equal(await store.get("old"), null);
  assert.ok(await store.get("fresh"));
  await assert.rejects(readFile(oldPath));
  assert.equal(await readFile(fresh.resultPath!, "utf8"), "y");
});
