// GET /articles list is backed by a per-user summary cache
// (users/<sub>/articles-index.json): steady state = prefix list + 1 index read,
// no per-article full-doc GETs. The cache is self-healing — the R2 listing stays
// authoritative, changed docs (etag/fingerprint mismatch) are re-read, deleted
// stems are pruned.
import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

function ctx(method, path, { body } = {}) {
  const segments = ["articles", ...path.split("/").filter(Boolean)];
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method,
    headers: { Authorization: `Bearer admin`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request, env, params: { path: segments } };
}

function seedArticle(env, stem = "s1", extra = {}) {
  const key = `users/u/articles/${stem}.json`;
  const base = {
    schema: 3, createdAt: 1000, transcript: "tx",
    head: 1,
    versions: [{ v: 1, savedAt: 1000, source: "mine", articles: [{ title: "T1", body: "B1" }] }],
  };
  env.FILES._store.set(key, JSON.stringify({ ...base, ...extra }));
  return key;
}

// Wrap FILES.get with a call counter, keyed by whether it's an article doc read.
function countDocGets(env) {
  const counts = { docs: 0 };
  const realGet = env.FILES.get.bind(env.FILES);
  env.FILES.get = async (key) => {
    if (/^users\/u\/articles\/.*\.json$/.test(key)) counts.docs += 1;
    return realGet(key);
  };
  return counts;
}

async function list(env) {
  const context = ctx("GET", "");
  context.env = env;
  context.params.path = ["articles", "u"];
  const resp = await onRequest(context);
  expect(resp.status).toBe(200);
  return (await resp.json()).articles;
}

describe("GET /articles — summary cache", () => {
  it("first list builds the index; second list reads no article docs", async () => {
    const env = ctx("GET", "").env;
    seedArticle(env, "s1", { createdAt: 1000 });
    seedArticle(env, "s2", { createdAt: 2000 });

    const first = await list(env);
    expect(first.map((a) => a.stem)).toEqual(["s2", "s1"]);
    expect(env.FILES._store.has("users/u/articles-index.json")).toBe(true);

    const counts = countDocGets(env);
    const second = await list(env);
    expect(second).toEqual(first);
    expect(counts.docs).toBe(0);   // served entirely from the index
  });

  it("a changed doc is re-read (fingerprint mismatch) and the entry refreshes", async () => {
    const env = ctx("GET", "").env;
    seedArticle(env, "s1");
    await list(env);

    // Rewrite with a new title — the fake fingerprint is size-based, so pad the
    // body to guarantee a size change (real R2 uses the etag).
    seedArticle(env, "s1", {
      versions: [{ v: 2, savedAt: 2000, source: "agent", articles: [{ title: "新标题", body: "B1 加长了一些以改变对象大小" }] }],
      head: 2,
    });
    const counts = countDocGets(env);
    const after = await list(env);
    expect(counts.docs).toBe(1);
    expect(after[0].title).toBe("新标题");

    // …and the refreshed entry is served from cache on the next call.
    const counts2 = countDocGets(env);
    await list(env);
    expect(counts2.docs).toBe(0);
  });

  it("a deleted doc disappears from the list and is pruned from the index", async () => {
    const env = ctx("GET", "").env;
    seedArticle(env, "s1", { createdAt: 1000 });
    seedArticle(env, "s2", { createdAt: 2000 });
    await list(env);

    env.FILES._store.delete("users/u/articles/s1.json");
    const after = await list(env);
    expect(after.map((a) => a.stem)).toEqual(["s2"]);
    const idx = JSON.parse(env.FILES._store.get("users/u/articles-index.json"));
    expect(Object.keys(idx.items)).toEqual(["s2"]);
  });

  it("a corrupt index is ignored and rebuilt", async () => {
    const env = ctx("GET", "").env;
    seedArticle(env, "s1");
    env.FILES._store.set("users/u/articles-index.json", "not json{{{");
    const out = await list(env);
    expect(out.map((a) => a.stem)).toEqual(["s1"]);
    const idx = JSON.parse(env.FILES._store.get("users/u/articles-index.json"));
    expect(idx.items.s1.entry.title).toBe("T1");
  });

  it("an unparseable article object is cached as a miss, not re-fetched every list", async () => {
    const env = ctx("GET", "").env;
    seedArticle(env, "s1");
    env.FILES._store.set("users/u/articles/ghost.json", "not json{{{");
    const first = await list(env);
    expect(first.map((a) => a.stem)).toEqual(["s1"]);

    const counts = countDocGets(env);
    const second = await list(env);
    expect(second.map((a) => a.stem)).toEqual(["s1"]);
    expect(counts.docs).toBe(0);
  });

  it("tags still ride the summary entries through the cache", async () => {
    const env = ctx("GET", "").env;
    seedArticle(env, "s1", { tags: ["创业"] });
    await list(env);          // build cache
    const second = await list(env);
    expect(second[0].tags).toEqual(["创业"]);
  });
});
