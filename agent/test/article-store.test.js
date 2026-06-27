import { describe, it, expect } from "vitest";
import {
  readArticleDoc, writeArticleDoc, setHead, MAX_VERSIONS,
  resolveArticles, withTopLevelArticles,
} from "../../functions/lib/article-store.js";
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

  it("migrates a v1 doc (top-level body, no articles[]) without losing content", async () => {
    const env = seed({
      version: 1, _source: "mine", updatedAt: 1500,
      title: "老标题", body: "v1 正文内容", transcript: "tx",
    });
    const doc = await readArticleDoc(env, KEY);
    expect(Array.isArray(doc.versions)).toBe(true);
    expect(doc.versions).toHaveLength(1);
    expect(doc.versions[0].articles).toHaveLength(1);
    expect(doc.versions[0].articles[0].title).toBe("老标题");
    expect(doc.versions[0].articles[0].body).toBe("v1 正文内容");  // body NOT dropped
    expect(doc.head).toBe(doc.versions[0].v);
    expect(doc.body).toBeUndefined();        // v1 body field gone after migrate
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

// ── resolveArticles / withTopLevelArticles — THE single source of truth ───────
// Every reader (Files API read/list, /download for old builds, the relay publish
// path, the agent worker, the public share page, the community pages) resolves
// "what are the current articles" through THIS one function. A future build (say
// build 94) that changes the doc shape must keep all three legacy shapes —
// schema-3 versions[head], schema-2 top-level articles, and the original v1
// title/body — resolving correctly, or every old-data surface silently breaks.
// These pin the contract directly so it can't drift through any single caller.

describe("resolveArticles — across every stored schema", () => {
  it("schema-3: returns the head version's articles", () => {
    const doc = {
      head: 2,
      versions: [
        { v: 1, articles: [{ title: "old", body: "o" }] },
        { v: 2, articles: [{ title: "new", body: "n" }] },
      ],
    };
    expect(resolveArticles(doc)).toEqual([{ title: "new", body: "n" }]);
  });

  it("schema-3: honors head pointing back at an earlier version (after an undo)", () => {
    const doc = {
      head: 1,   // head < latest: an undo
      versions: [
        { v: 1, articles: [{ title: "V1", body: "b1" }] },
        { v: 2, articles: [{ title: "V2", body: "b2" }] },
      ],
    };
    expect(resolveArticles(doc)[0].title).toBe("V1");
  });

  it("schema-2: returns the top-level articles when there are no versions", () => {
    const doc = { schema: 2, articles: [{ title: "T", body: "B" }], transcript: "tx" };
    expect(resolveArticles(doc)).toEqual([{ title: "T", body: "B" }]);
  });

  it("v1: synthesizes one article from top-level title/body", () => {
    expect(resolveArticles({ version: 1, title: "老标题", body: "正文" }))
      .toEqual([{ title: "老标题", body: "正文" }]);
  });

  it("v1 without a title falls back to (无题)", () => {
    expect(resolveArticles({ body: "正文" })).toEqual([{ title: "(无题)", body: "正文" }]);
  });

  it("empty/contentless doc → [] (never throws)", () => {
    expect(resolveArticles({})).toEqual([]);
    expect(resolveArticles({ head: 1, versions: [{ v: 1, articles: [] }] })).toEqual([]);
  });

  it("schema-3 head version wins over a stale top-level articles field", () => {
    // A doc that still carries a legacy top-level `articles` AND new versions[head]
    // must prefer versions[head] — otherwise an old field would shadow live edits.
    const doc = {
      articles: [{ title: "STALE", body: "x" }],
      head: 1,
      versions: [{ v: 1, articles: [{ title: "LIVE", body: "y" }] }],
    };
    expect(resolveArticles(doc)[0].title).toBe("LIVE");
  });
});

describe("withTopLevelArticles — rebuilds the legacy top-level field", () => {
  it("adds top-level articles for a schema-3 doc, keeping head/versions intact", () => {
    const doc = {
      transcript: "tx", head: 1,
      versions: [{ v: 1, articles: [{ title: "T", body: "B" }] }],
    };
    const out = withTopLevelArticles(doc);
    expect(out.articles).toEqual([{ title: "T", body: "B" }]);
    expect(out.head).toBe(1);                 // additive — version-aware readers unaffected
    expect(out.versions).toHaveLength(1);
    expect(out.transcript).toBe("tx");
  });

  it("returns the same object when a non-empty top-level articles already exists", () => {
    const doc = { articles: [{ title: "T", body: "B" }] };
    expect(withTopLevelArticles(doc)).toBe(doc);   // no needless rewrite
  });

  it("rebuilds articles from a v1 body so old /download clients see content", () => {
    const out = withTopLevelArticles({ version: 1, title: "标题", body: "正文" });
    expect(out.articles).toEqual([{ title: "标题", body: "正文" }]);
  });
});
