import { describe, it, expect } from "vitest";
import { readArticleDoc, writeArticleDoc, setHead, MAX_VERSIONS } from "../../functions/lib/article-store.js";
import { fakeEnv } from "./fakes.js";

const KEY = "users/u/articles/stem.json";

function seed(doc) {
  return fakeEnv({ [KEY]: JSON.stringify(doc) });
}

// ── readArticleDoc ──────────────────────────────────────────────────────────

describe("readArticleDoc", () => {
  it("returns null for a missing key", async () => {
    expect(await readArticleDoc(fakeEnv(), KEY)).toBeNull();
  });

  it("returns null for unparseable JSON", async () => {
    const env = fakeEnv({ [KEY]: "not json" });
    expect(await readArticleDoc(env, KEY)).toBeNull();
  });

  it("returns schema-3 doc unchanged", async () => {
    const env = seed({
      head: 2,
      versions: [
        { v: 1, savedAt: 1000, source: "mine",  articles: [{ title: "T1", body: "B1" }] },
        { v: 2, savedAt: 2000, source: "agent", articles: [{ title: "T2", body: "B2" }] },
      ],
    });
    const doc = await readArticleDoc(env, KEY);
    expect(doc.head).toBe(2);
    expect(doc.versions).toHaveLength(2);
    expect(doc.versions[1].articles[0].title).toBe("T2");
  });

  it("migrates schema-2 doc (top-level articles + history) to schema-3", async () => {
    const env = seed({
      version: 2, _source: "agent", updatedAt: 2000,
      articles: [{ title: "current", body: "C" }],
      history: [{ v: 1, savedAt: 1000, source: "mine", articles: [{ title: "old", body: "O" }] }],
      transcript: "tx",
    });
    const doc = await readArticleDoc(env, KEY);
    expect(Array.isArray(doc.versions)).toBe(true);
    expect(doc.versions).toHaveLength(2);
    expect(doc.versions[0].articles[0].title).toBe("old");   // oldest first
    expect(doc.versions[1].articles[0].title).toBe("current");
    expect(doc.head).toBe(doc.versions[1].v);
    expect(doc.articles).toBeUndefined();    // top-level articles gone
    expect(doc.history).toBeUndefined();     // history gone
    expect(doc.transcript).toBe("tx");       // other metadata preserved
  });
});

// ── writeArticleDoc ─────────────────────────────────────────────────────────

describe("writeArticleDoc — first write", () => {
  it("sets head=1 and versions=[{v:1}] on a new key", async () => {
    const env = fakeEnv();
    const doc = await writeArticleDoc(env, KEY, { articles: [{ title: "T", body: "B" }] }, "mine");
    expect(doc.head).toBe(1);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0].v).toBe(1);
    expect(doc.versions[0].source).toBe("mine");
  });

  it("persists the doc to R2", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "T", body: "B" }] }, "mine");
    const stored = JSON.parse(env.FILES._store.get(KEY));
    expect(stored.head).toBe(1);
    expect(stored.versions[0].articles[0].title).toBe("T");
  });
});

describe("writeArticleDoc — subsequent writes", () => {
  it("increments head on each write", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "v1", body: "" }] }, "mine");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v2", body: "" }] }, "agent");
    const doc = await readArticleDoc(env, KEY);
    expect(doc.head).toBe(2);
    expect(doc.versions).toHaveLength(2);
  });

  it("versions is oldest-first", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "v1", body: "" }] }, "mine");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v2", body: "" }] }, "agent");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v3", body: "" }] }, "agent");
    const doc = await readArticleDoc(env, KEY);
    expect(doc.versions.map((e) => e.v)).toEqual([1, 2, 3]);
    expect(doc.head).toBe(3);
  });

  it(`caps at MAX_VERSIONS (${MAX_VERSIONS}) entries`, async () => {
    const env = fakeEnv();
    for (let i = 0; i <= MAX_VERSIONS + 2; i++) {
      await writeArticleDoc(env, KEY, { articles: [{ title: `v${i}`, body: "" }] }, "mine");
    }
    const doc = await readArticleDoc(env, KEY);
    expect(doc.versions.length).toBeLessThanOrEqual(MAX_VERSIONS);
  });

  it("truncates future versions (after head) before writing", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "v1", body: "" }] }, "mine");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v2", body: "" }] }, "agent");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v3", body: "" }] }, "agent");
    // Simulate undo: move head back to 1
    await setHead(env, KEY, 1);
    // Now write a new version — v2 and v3 should be discarded
    await writeArticleDoc(env, KEY, { articles: [{ title: "v2-alt", body: "" }] }, "agent");
    const doc = await readArticleDoc(env, KEY);
    expect(doc.head).toBe(2);
    expect(doc.versions).toHaveLength(2);
    expect(doc.versions[1].articles[0].title).toBe("v2-alt");
  });

  it("sets updatedAt on every write", async () => {
    const env = fakeEnv();
    const doc = await writeArticleDoc(env, KEY, { articles: [] }, "mine");
    expect(typeof doc.updatedAt).toBe("number");
    expect(doc.updatedAt).toBeGreaterThan(0);
  });
});

// ── setHead ─────────────────────────────────────────────────────────────────

describe("setHead", () => {
  it("moves head to a valid previous version", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "v1", body: "" }] }, "mine");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v2", body: "" }] }, "agent");
    const doc = await setHead(env, KEY, 1);
    expect(doc.head).toBe(1);
    // versions unchanged
    expect(doc.versions).toHaveLength(2);
  });

  it("returns null for a version not in versions array", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [] }, "mine");
    expect(await setHead(env, KEY, 99)).toBeNull();
  });

  it("returns null for a missing key", async () => {
    expect(await setHead(fakeEnv(), KEY, 1)).toBeNull();
  });
});
