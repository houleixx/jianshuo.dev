import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore, type Job } from "../src/store.ts";

function sampleJob(id: string): Job {
  return {
    id, status: "queued", mode: "generate", prompt: "cat",
    params: { size: "2K", format: "png", quality: "high", transparent: false },
    percent: 0, error: null, createdAt: new Date().toISOString(),
  };
}

test("create/get roundtrip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create(sampleJob("a1"));
  const got = await store.get("a1");
  assert.equal(got?.prompt, "cat");
  assert.equal(await store.get("missing"), null);
});

test("update merges patch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create(sampleJob("a1"));
  const up = await store.update("a1", { status: "running", percent: 50 });
  assert.equal(up.status, "running");
  assert.equal(up.percent, 50);
  assert.equal((await store.get("a1"))?.percent, 50);
});

test("list sorted desc by createdAt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create({ ...sampleJob("old"), createdAt: "2026-01-01T00:00:00Z" });
  await store.create({ ...sampleJob("new"), createdAt: "2026-02-01T00:00:00Z" });
  const list = await store.list(10);
  assert.deepEqual(list.map((j) => j.id), ["new", "old"]);
});

test("recover flips running to queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create({ ...sampleJob("r1"), status: "running" });
  await store.create({ ...sampleJob("q1"), status: "queued" });
  await store.create({ ...sampleJob("d1"), status: "done" });
  const ids = (await store.recover()).sort();
  assert.deepEqual(ids, ["q1", "r1"]);
  assert.equal((await store.get("r1"))?.status, "queued");
});

test("list ignores stray dot/temp files", async () => {
  // The stray file is valid Job JSON so JSON.parse succeeds - the only thing
  // that can exclude it from list() is the dotfile filter (!f.startsWith(".")).
  // A plain "not json" payload would be swallowed by list()'s try/catch
  // regardless of the filter, so it wouldn't gate the fix.
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create(sampleJob("a1"));
  await writeFile(join(dir, ".stray.tmp.json"), JSON.stringify(sampleJob("stray")));
  const list = await store.list(10);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "a1");
});

test("list handles many entries with equal createdAt", async () => {
  // Guards against entries being dropped or duplicated when the comparator
  // sees many equal timestamps (a 2-element array can't structurally lose
  // elements under Array#sort, so this uses 12). Note: this does not by
  // itself reproduce the old comparator's spec violation - it only checks
  // that ties don't cause data loss/duplication.
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  const createdAt = "2026-03-01T00:00:00Z";
  const ids = Array.from({ length: 12 }, (_, i) => `tie${i}`);
  for (const id of ids) {
    await store.create({ ...sampleJob(id), createdAt });
  }
  const list = await store.list(20);
  assert.equal(list.length, 12);
  assert.deepEqual(list.map((j) => j.id).sort(), ids.slice().sort());
});

test("concurrent updates both apply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create(sampleJob("c1"));
  await Promise.all([
    store.update("c1", { percent: 50 }),
    store.update("c1", { status: "running" }),
  ]);
  const got = await store.get("c1");
  assert.equal(got?.percent, 50);
  assert.equal(got?.status, "running");
});

test("update chain survives a rejected update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);

  // A rejected update on a nonexistent id must still reject to the caller...
  await assert.rejects(store.update("nope", { percent: 1 }));

  // ...and must not wedge that id's (or any other id's) update chain.
  await store.create(sampleJob("ok1"));
  await store.update("ok1", { percent: 42 });
  assert.equal((await store.get("ok1"))?.percent, 42);

  // Fire a doomed update and a good update on different ids concurrently,
  // without awaiting the first: the rejection must not block the other.
  await store.create(sampleJob("ok2"));
  const bad = store.update("nope2", {});
  const good = store.update("ok2", { status: "running" });
  await assert.rejects(bad);
  await good;
  assert.equal((await store.get("ok2"))?.status, "running");
});
