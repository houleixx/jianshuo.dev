import { describe, it, expect } from "vitest";
import { runTool, TOOL_DEFS } from "../src/tools.js";
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

// A schema-3 doc: current content lives in versions[head], not top-level.
function seedSchema3() {
  return {
    "users/u/articles/s3a.json": JSON.stringify({
      createdAt: 3000, transcript: "tx3", head: 2,
      versions: [
        { v: 1, savedAt: 1, source: "mine", articles: [{ title: "OLD", body: "old" }] },
        { v: 2, savedAt: 2, source: "agent", articles: [{ title: "NEW", body: "new" }] },
      ],
    }),
  };
}

describe("list_articles", () => {
  it("lists json articles newest-first and skips .empty/.srt", async () => {
    const env = fakeEnv(seedTwoArticles());
    const r = await rt("list_articles", {}, CTX(env));
    expect(r.articles.map((a) => a.stem)).toEqual(["s2", "s1"]);
    expect(r.articles[0]).toMatchObject({ stem: "s2", title: "A2", createdAt: 2000 });
  });
  it("reads the head version's title for a schema-3 doc", async () => {
    const env = fakeEnv(seedSchema3());
    const r = await rt("list_articles", {}, CTX(env));
    expect(r.articles[0]).toMatchObject({ stem: "s3a", title: "NEW" });
  });

  // 上面两条用数字 createdAt seed，但 miner 在生产里写的是 ISO 字符串
  // （new Date().toISOString()）。字符串相减 = NaN → 排序静默失效。
  // 这里更狠：排序在 slice(0,30) 之前，排错了就等于只把「最老的 30 篇」交给
  // 语音 agent，用户让它「改最近那篇」时它根本看不到。
  it("按 createdAt 倒序 —— 即使 createdAt 是 miner 写的 ISO 字符串", async () => {
    const env = fakeEnv({
      "users/u/articles/s1.json": JSON.stringify({ schema: 2, createdAt: "2026-06-20T07:01:41.489Z", articles: [{ title: "老", body: "b" }] }),
      "users/u/articles/s2.json": JSON.stringify({ schema: 2, createdAt: "2026-07-06T07:29:25.673Z", articles: [{ title: "新", body: "b" }] }),
      "users/u/articles/s3.json": JSON.stringify({ schema: 2, createdAt: "2026-06-21T03:50:00.685Z", articles: [{ title: "中", body: "b" }] }),
    });

    const r = await rt("list_articles", {}, CTX(env));

    expect(r.articles.map((a) => a.stem)).toEqual(["s2", "s3", "s1"]);
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
  it("returns the head version's articles for a schema-3 doc", async () => {
    const env = fakeEnv(seedSchema3());
    const r = await rt("read_article", { stem: "s3a" }, CTX(env));
    expect(r).toEqual({ transcript: "tx3", articles: [{ title: "NEW", body: "new" }] });
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

describe("style tools", () => {
  it("read_style returns the resolved 文风 from CLAUDE.json (head version)", async () => {
    const env = fakeEnv({ "users/u/CLAUDE.json": JSON.stringify({
      schema: 3, head: 2, versions: [
        { v: 1, savedAt: 1, source: "app", style: "老" },
        { v: 2, savedAt: 2, source: "agent", style: "口语一点" },
      ],
    }) });
    expect(await rt("read_style", {}, CTX(env))).toEqual({ style: "口语一点" });
  });
  it("read_style falls back to the legacy CLAUDE.md 文风 section", async () => {
    const env = fakeEnv({ "users/u/CLAUDE.md": "# 我的名字\n王建硕\n\n# 我的文风\n回退" });
    expect(await rt("read_style", {}, CTX(env))).toEqual({ style: "回退" });
  });
  it("read_style returns empty when neither CLAUDE.json nor CLAUDE.md exists", async () => {
    expect(await rt("read_style", {}, CTX(fakeEnv({})))).toEqual({ style: "" });
  });
  it("write_style PUTs the 文风 to /files/api/style (source=agent) and returns ok", async () => {
    globalThis.fetch = fakeFetch({
      "PUT https://jianshuo.dev/files/api/style": () => ({ ok: true, body: { ok: true, head: 1 } }),
    });
    expect(await rt("write_style", { content: "new style" }, CTX(fakeEnv({})))).toEqual({ ok: true });
    expect(JSON.parse(globalThis.fetch.calls[0].body)).toMatchObject({ style: "new style", source: "agent" });
  });
  it("write_style surfaces an upload failure", async () => {
    globalThis.fetch = fakeFetch({
      "PUT https://jianshuo.dev/files/api/style": () => ({ ok: false, status: 500, body: {} }),
    });
    expect((await rt("write_style", { content: "x" }, CTX(fakeEnv({})))).error).toMatch(/upload_failed/);
  });
  it("write_style rejects empty content", async () => {
    expect(await rt("write_style", { content: "" }, CTX(fakeEnv({})))).toEqual({ error: "empty_content" });
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

describe("write_article stamps lastEditId", () => {
  it("includes lastEditId in the PUT body when ctx.editId is set", async () => {
    const env = fakeEnv({
      "users/u/articles/s2.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "tx", articles: [{ title: "A", body: "b" }] }),
    });
    let putBody = null;
    const fetchFake = fakeFetch({
      "PUT https://jianshuo.dev/files/api/articles/s2": ({ init }) => { putBody = JSON.parse(init.body); return { ok: true, body: { ok: true, head: 2 } }; },
    });
    const orig = globalThis.fetch; globalThis.fetch = fetchFake;
    try {
      const ctx = { env, scope: "users/u/", articleKey: "users/u/articles/s2.json", token: "t", origin: "https://jianshuo.dev", editId: "edit-123" };
      const r = await rt("write_article", { articles: [{ title: "A2", body: "b2" }] }, ctx);
      expect(r).toMatchObject({ ok: true });
      expect(putBody.lastEditId).toBe("edit-123");
    } finally { globalThis.fetch = orig; }
  });

  it("omits lastEditId from the PUT body when ctx.editId is absent", async () => {
    const env = fakeEnv({
      "users/u/articles/s2.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "tx", articles: [{ title: "A", body: "b" }] }),
    });
    let putBody = null;
    const fetchFake = fakeFetch({
      "PUT https://jianshuo.dev/files/api/articles/s2": ({ init }) => { putBody = JSON.parse(init.body); return { ok: true, body: { ok: true, head: 2 } }; },
    });
    const orig = globalThis.fetch; globalThis.fetch = fetchFake;
    try {
      const ctx = { env, scope: "users/u/", articleKey: "users/u/articles/s2.json", token: "t", origin: "https://jianshuo.dev" };
      const r = await rt("write_article", { articles: [{ title: "A2", body: "b2" }] }, ctx);
      expect(r).toMatchObject({ ok: true });
      expect(putBody.lastEditId).toBeUndefined();
    } finally { globalThis.fetch = orig; }
  });
});

describe("edit_current_article", () => {
  it("patches the body by 第N行 and PUTs it, preserving wechatMediaId + transcript", async () => {
    const env = fakeEnv({
      "users/u/articles/s2.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "tx2", articles: [{ title: "T", body: "一\n\n二\n\n三", wechatMediaId: "m2" }] }),
    });
    globalThis.fetch = fakeFetch({
      "PUT https://jianshuo.dev/files/api/articles/s2": () => ({ ok: true, body: { ok: true, head: 2 } }),
    });
    const r = await rt("edit_current_article", { ops: [{ op: "delete_lines", lines: [2] }] }, CTX(env));
    expect(r).toEqual({ ok: true });
    const sent = JSON.parse(globalThis.fetch.calls[0].body);
    expect(sent.articles[0]).toEqual({ title: "T", body: "一\n\n三", wechatMediaId: "m2" });
    expect(sent.transcript).toBe("tx2"); // metadata carried through
  });

  it("targets the article at ctx.articleIndex, leaving other articles untouched", async () => {
    const env = fakeEnv({
      "users/u/articles/s2.json": JSON.stringify({ schema: 2, transcript: "t", articles: [{ title: "A", body: "a1\n\na2" }, { title: "B", body: "b1\n\nb2" }] }),
    });
    globalThis.fetch = fakeFetch({ "PUT https://jianshuo.dev/files/api/articles/s2": () => ({ ok: true, body: {} }) });
    const r = await rt("edit_current_article", { ops: [{ op: "replace_line", line: 1, text: "B1新" }] }, { ...CTX(env), articleIndex: 1 });
    expect(r).toEqual({ ok: true });
    const sent = JSON.parse(globalThis.fetch.calls[0].body);
    expect(sent.articles[0].body).toBe("a1\n\na2");   // article 0 untouched
    expect(sent.articles[1].body).toBe("B1新\n\nb2");  // article 1 patched
  });

  it("changes the title with set_title", async () => {
    const env = fakeEnv({ "users/u/articles/s2.json": JSON.stringify({ schema: 2, transcript: "t", articles: [{ title: "旧", body: "x" }] }) });
    globalThis.fetch = fakeFetch({ "PUT https://jianshuo.dev/files/api/articles/s2": () => ({ ok: true, body: {} }) });
    await rt("edit_current_article", { ops: [{ op: "set_title", title: "新标题" }] }, CTX(env));
    expect(JSON.parse(globalThis.fetch.calls[0].body).articles[0]).toEqual({ title: "新标题", body: "x" });
  });

  it("surfaces line_not_found back to the model and PUTs nothing", async () => {
    const env = fakeEnv({ "users/u/articles/s2.json": JSON.stringify({ schema: 2, transcript: "t", articles: [{ title: "T", body: "一" }] }) });
    globalThis.fetch = fakeFetch({ "PUT https://jianshuo.dev/files/api/articles/s2": () => ({ ok: true, body: {} }) });
    const r = await rt("edit_current_article", { ops: [{ op: "delete_lines", lines: [9] }] }, CTX(env));
    expect(r).toEqual({ error: "line_not_found", line: 9 });
    expect(globalThis.fetch.calls.length).toBe(0);
  });

  it("rejects empty ops", async () => {
    const env = fakeEnv({ "users/u/articles/s2.json": JSON.stringify({ schema: 2, transcript: "t", articles: [{ title: "T", body: "一" }] }) });
    expect(await rt("edit_current_article", { ops: [] }, CTX(env))).toEqual({ error: "empty_ops" });
  });

  it("stamps lastEditId when ctx.editId is set", async () => {
    const env = fakeEnv({ "users/u/articles/s2.json": JSON.stringify({ schema: 2, transcript: "t", articles: [{ title: "T", body: "一\n\n二" }] }) });
    let putBody;
    globalThis.fetch = fakeFetch({ "PUT https://jianshuo.dev/files/api/articles/s2": ({ init }) => { putBody = JSON.parse(init.body); return { ok: true, body: {} }; } });
    await rt("edit_current_article", { ops: [{ op: "delete_lines", lines: [1] }] }, { ...CTX(env), editId: "e9" });
    expect(putBody.lastEditId).toBe("e9");
  });
});
