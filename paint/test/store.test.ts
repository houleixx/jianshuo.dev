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
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  await store.create(sampleJob("a1"));
  await writeFile(join(dir, ".zzz.tmp.json"), "not json");
  await writeFile(join(dir, ".zzz.tmp"), "not json either");
  const list = await store.list(10);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "a1");
});

test("list is stable with equal createdAt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "paint-store-"));
  const store = new JobStore(dir);
  const createdAt = "2026-03-01T00:00:00.000Z";
  await store.create({ ...sampleJob("x1"), createdAt });
  await store.create({ ...sampleJob("x2"), createdAt });
  const list = await store.list(10);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((j) => j.id).sort(), ["x1", "x2"]);
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
