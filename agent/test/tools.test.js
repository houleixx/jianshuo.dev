import { describe, it, expect } from "vitest";
import { runTool, TOOL_DEFS, appendVersion } from "../src/tools.js";
import { fakeEnv } from "./fakes.js";

describe("runTool dispatcher", () => {
  it("returns unknown_tool for an unrecognized name", async () => {
    const ctx = { env: fakeEnv(), scope: "users/u/", articleKey: "users/u/articles/s.json", token: "t", origin: "https://jianshuo.dev" };
    expect(await runTool("nope", {}, ctx)).toEqual({ error: "unknown_tool" });
  });

  it("exposes a tool definition array", () => {
    expect(Array.isArray(TOOL_DEFS)).toBe(true);
  });
});

import { runTool as rt } from "../src/tools.js";

const CTX = (env) => ({ env, scope: "users/u/", articleKey: "users/u/articles/s2.json", token: "t", origin: "https://jianshuo.dev" });

function seedTwoArticles() {
  return {
    "users/u/articles/s1.json": JSON.stringify({ schema: 2, createdAt: 1000, transcript: "tx1", articles: [{ title: "A1", body: "b1" }] }),
    "users/u/articles/s2.json": JSON.stringify({ schema: 2, createdAt: 2000, transcript: "tx2", articles: [{ title: "A2", body: "b2", wechatMediaId: "m2" }] }),
    "users/u/articles/s3.empty": JSON.stringify({ status: "empty" }),
    "users/u/articles/s2.srt": "1\n00:00",
  };
}

describe("list_articles", () => {
  it("lists json articles newest-first and skips .empty/.srt", async () => {
    const env = fakeEnv(seedTwoArticles());
    const r = await rt("list_articles", {}, CTX(env));
    expect(r.articles.map((a) => a.stem)).toEqual(["s2", "s1"]);
    expect(r.articles[0]).toMatchObject({ stem: "s2", title: "A2", createdAt: 2000 });
  });
});

describe("read_article", () => {
  it("returns transcript and articles for a stem", async () => {
    const env = fakeEnv(seedTwoArticles());
    const r = await rt("read_article", { stem: "s1" }, CTX(env));
    expect(r).toEqual({ transcript: "tx1", articles: [{ title: "A1", body: "b1" }] });
  });
  it("rejects a stem that escapes scope", async () => {
    const env = fakeEnv(seedTwoArticles());
    expect(await rt("read_article", { stem: "../x" }, CTX(env))).toEqual({ error: "bad_stem" });
  });
  it("404s a missing stem", async () => {
    const env = fakeEnv(seedTwoArticles());
    expect(await rt("read_article", { stem: "nope" }, CTX(env))).toEqual({ error: "not_found" });
  });
});

describe("write_article", () => {
  it("POSTs to the article API and preserves wechatMediaId by index", async () => {
    const env = fakeEnv(seedTwoArticles());
    globalThis.fetch = fakeFetch({
      "PUT https://jianshuo.dev/files/api/articles/s2": () => ({ ok: true, body: { ok: true, version: 2 } }),
    });
    const r = await rt("write_article", { articles: [{ title: "A2x", body: "b2x" }] }, CTX(env));
    expect(r).toEqual({ ok: true, count: 1 });
    const call = globalThis.fetch.calls[0];
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("https://jianshuo.dev/files/api/articles/s2");
    expect(call.headers.Authorization).toBe("Bearer t");
    const sent = JSON.parse(call.body);
    expect(sent.articles[0]).toEqual({ title: "A2x", body: "b2x", wechatMediaId: "m2" });
    expect(sent.transcript).toBe("tx2");
  });
  it("saves a version snapshot to _versions.json before writing", async () => {
    const env = fakeEnv(seedTwoArticles());
    globalThis.fetch = fakeFetch({
      "PUT https://jianshuo.dev/files/api/articles/s2": () => ({ ok: true, body: { ok: true, version: 2 } }),
    });
    await rt("write_article", { articles: [{ title: "A2x", body: "b2x" }] }, CTX(env));
    const hist = JSON.parse(env.FILES._store.get("users/u/articles/s2_versions.json"));
    expect(hist.versions).toHaveLength(1);
    expect(hist.versions[0].articles[0].title).toBe("A2");
  });
  it("rejects empty articles before calling the API", async () => {
    const env = fakeEnv(seedTwoArticles());
    expect(await rt("write_article", { articles: [] }, CTX(env))).toEqual({ error: "empty_articles" });
  });
  it("returns upload_failed when the API responds non-ok", async () => {
    const env = fakeEnv(seedTwoArticles());
    globalThis.fetch = fakeFetch({
      "PUT https://jianshuo.dev/files/api/articles/s2": () => ({ ok: false, status: 500, body: {} }),
    });
    const r = await rt("write_article", { articles: [{ title: "T", body: "B" }] }, CTX(env));
    expect(r.error).toMatch(/upload_failed/);
  });
});

describe("appendVersion", () => {
  it("creates _versions.json with first snapshot", async () => {
    const env = fakeEnv({});
    const doc = { articles: [{ title: "T1", body: "B1" }], photos: ["photos/p1.jpg"] };
    await appendVersion(env, "users/u/articles/s1.json", doc);
    const hist = JSON.parse(env.FILES._store.get("users/u/articles/s1_versions.json"));
    expect(hist.versions).toHaveLength(1);
    expect(hist.versions[0].articles[0].title).toBe("T1");
    expect(hist.versions[0].photos).toEqual(["photos/p1.jpg"]);
    expect(typeof hist.versions[0].savedAt).toBe("number");
  });
  it("prepends new snapshots and keeps max 20", async () => {
    const env = fakeEnv({});
    // Seed 20 existing versions
    const seed = { versions: Array.from({ length: 20 }, (_, i) => ({ savedAt: i, articles: [{ title: `v${i}`, body: "" }], photos: null })) };
    env.FILES._store.set("users/u/articles/s1_versions.json", JSON.stringify(seed));
    const doc = { articles: [{ title: "new", body: "" }] };
    await appendVersion(env, "users/u/articles/s1.json", doc);
    const hist = JSON.parse(env.FILES._store.get("users/u/articles/s1_versions.json"));
    expect(hist.versions).toHaveLength(20);
    expect(hist.versions[0].articles[0].title).toBe("new");
  });
});

describe("style tools", () => {
  it("read_style returns the CLAUDE.md text, empty when absent", async () => {
    const env = fakeEnv({ "users/u/CLAUDE.md": "# 我的名字\n王建硕\n\n口语一点" });
    expect(await rt("read_style", {}, CTX(env))).toEqual({ style: "# 我的名字\n王建硕\n\n口语一点" });
    const env2 = fakeEnv({});
    expect(await rt("read_style", {}, CTX(env2))).toEqual({ style: "" });
  });
  it("write_style overwrites CLAUDE.md", async () => {
    const env = fakeEnv({ "users/u/CLAUDE.md": "old" });
    expect(await rt("write_style", { content: "new style" }, CTX(env))).toEqual({ ok: true });
    expect(env.FILES._store.get("users/u/CLAUDE.md")).toBe("new style");
  });
  it("write_style rejects empty content", async () => {
    const env = fakeEnv({});
    expect(await rt("write_style", { content: "" }, CTX(env))).toEqual({ error: "empty_content" });
  });
});

import { fakeFetch } from "./fakes.js";
import { afterEach } from "vitest";

afterEach(() => { delete globalThis.fetch; });

describe("distribution tools", () => {
  it("publish_wechat POSTs the scope-relative key with the bearer token", async () => {
    const env = fakeEnv(seedTwoArticles());
    globalThis.fetch = fakeFetch({
      "POST https://jianshuo.dev/files/api/wechat/articles/s2.json": () => ({ ok: true, body: { ok: true, created: 1, updated: 0 } }),
    });
    const r = await rt("publish_wechat", {}, CTX(env));
    expect(r).toEqual({ ok: true, created: 1, updated: 0 });
    const call = globalThis.fetch.calls[0];
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer t");
  });

  it("share_to_community POSTs the scope-relative key and returns shareId", async () => {
    const env = fakeEnv(seedTwoArticles());
    globalThis.fetch = fakeFetch({
      "POST https://jianshuo.dev/files/api/community/share/articles/s2.json": () => ({ ok: true, body: { ok: true, shareId: "abc123" } }),
    });
    const r = await rt("share_to_community", {}, CTX(env));
    expect(r).toEqual({ ok: true, shareId: "abc123" });
    const call = globalThis.fetch.calls[0];
    expect(call.headers.Authorization).toBe("Bearer t");
  });

  it("surfaces a non-ok response body", async () => {
    const env = fakeEnv(seedTwoArticles());
    globalThis.fetch = fakeFetch({
      "POST https://jianshuo.dev/files/api/wechat/articles/s2.json": () => ({ ok: false, status: 409, body: { error: "wechat_not_configured" } }),
    });
    expect(await rt("publish_wechat", {}, CTX(env))).toEqual({ error: "wechat_not_configured" });
  });
});
