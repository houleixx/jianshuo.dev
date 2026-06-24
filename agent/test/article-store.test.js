import { describe, it, expect } from "vitest";
import { readArticleDoc, writeArticleDoc, MAX_HISTORY } from "../../functions/lib/article-store.js";
import { fakeEnv } from "./fakes.js";

const KEY = "users/u/articles/stem.json";

function seed(doc) {
  return fakeEnv({ [KEY]: JSON.stringify(doc) });
}

describe("readArticleDoc", () => {
  it("returns null for a missing key", async () => {
    expect(await readArticleDoc(fakeEnv(), KEY)).toBeNull();
  });

  it("returns parsed doc for an existing key", async () => {
    const env = seed({ articles: [{ title: "T", body: "B" }], version: 1 });
    const doc = await readArticleDoc(env, KEY);
    expect(doc.articles[0].title).toBe("T");
  });

  it("returns null for unparseable JSON", async () => {
    const env = fakeEnv({ [KEY]: "not json" });
    expect(await readArticleDoc(env, KEY)).toBeNull();
  });
});

describe("writeArticleDoc — first write", () => {
  it("sets version=1 and empty history on a new key", async () => {
    const env = fakeEnv();
    const doc = await writeArticleDoc(env, KEY, { articles: [{ title: "T", body: "B" }] }, "mine");
    expect(doc.version).toBe(1);
    expect(doc._source).toBe("mine");
    expect(doc.history).toEqual([]);
  });

  it("persists the doc to R2", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "T", body: "B" }] }, "mine");
    const stored = JSON.parse(env.FILES._store.get(KEY));
    expect(stored.version).toBe(1);
    expect(stored.articles[0].title).toBe("T");
  });
});

describe("writeArticleDoc — subsequent writes", () => {
  it("increments version on each write", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "v1", body: "" }] }, "mine");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v2", body: "" }] }, "agent");
    const doc = await readArticleDoc(env, KEY);
    expect(doc.version).toBe(2);
  });

  it("pushes previous articles into history", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "first", body: "" }] }, "mine");
    await writeArticleDoc(env, KEY, { articles: [{ title: "second", body: "" }] }, "agent");
    const doc = await readArticleDoc(env, KEY);
    expect(doc.history).toHaveLength(1);
    expect(doc.history[0].v).toBe(1);
    expect(doc.history[0].source).toBe("mine");
    expect(doc.history[0].articles[0].title).toBe("first");
  });

  it("history is newest-first (most recent previous version at index 0)", async () => {
    const env = fakeEnv();
    await writeArticleDoc(env, KEY, { articles: [{ title: "v1", body: "" }] }, "mine");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v2", body: "" }] }, "agent");
    await writeArticleDoc(env, KEY, { articles: [{ title: "v3", body: "" }] }, "agent");
    const doc = await readArticleDoc(env, KEY);
    expect(doc.version).toBe(3);
    expect(doc.history[0].v).toBe(2);
    expect(doc.history[1].v).toBe(1);
  });

  it(`caps history at MAX_HISTORY (${MAX_HISTORY}) entries`, async () => {
    const env = fakeEnv();
    for (let i = 0; i <= MAX_HISTORY + 2; i++) {
      await writeArticleDoc(env, KEY, { articles: [{ title: `v${i}`, body: "" }] }, "mine");
    }
    const doc = await readArticleDoc(env, KEY);
    expect(doc.history.length).toBeLessThanOrEqual(MAX_HISTORY);
  });

  it("sets updatedAt on every write", async () => {
    const env = fakeEnv();
    const doc = await writeArticleDoc(env, KEY, { articles: [] }, "mine");
    expect(typeof doc.updatedAt).toBe("number");
    expect(doc.updatedAt).toBeGreaterThan(0);
  });
});
