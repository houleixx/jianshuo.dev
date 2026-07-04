import { describe, it, expect, vi } from "vitest";
import { runTool, deleteArticleFiles } from "../src/tools.js";
import { toolDefsFor, COMMAND_TOOL_NAMES } from "../src/tools.js";

// 极简 env.FILES（内存 R2），够工具读写。
function memFiles(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    _store: store,
    async get(k) { return store.has(k) ? { async text() { return store.get(k); }, async json() { return JSON.parse(store.get(k)); } } : null; },
    async put(k, v) { store.set(k, typeof v === "string" ? v : "BYTES"); },
    async head(k) { return store.has(k) ? {} : null; },
    async delete(k) { store.delete(k); },
    async list({ prefix }) { return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
const SCOPE = "users/abc/";
function art(stem, title, body, extra = {}) { return JSON.stringify({ schema: 2, articles: [{ title, body }], transcript: "", createdAt: 1, ...extra }); }

describe("merge_articles", () => {
  it("读多篇→Claude 揉成一篇→写新文章+静音 m4a→原文保留", async () => {
    const env = { FILES: memFiles({
      [`${SCOPE}articles/A.json`]: art("A", "甲", "甲的正文"),
      [`${SCOPE}articles/B.json`]: art("B", "乙", "乙的正文"),
    }) };
    // ctx.callClaude 返回合并结果（第一行标题，其余正文）
    const callClaude = vi.fn(async () => ({ content: [{ type: "text", text: "合璧\n甲乙合一的正文" }], usage: {} }));
    // 拦截 Files API PUT（新文章写回）
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const r = await runTool("merge_articles", { stems: ["A", "B"] },
      { env, scope: SCOPE, token: "tk", origin: "https://jianshuo.dev", callClaude });

    expect(r.ok).toBe(true);
    expect(r.newStem).toMatch(/^VoiceDrop-merged-/);
    // 新文章通过 Files API PUT 写出，标题「合璧」
    const put = fetchSpy.mock.calls.find(([u, o]) => o?.method === "PUT" && String(u).includes(`/files/api/articles/${r.newStem}`));
    expect(put).toBeTruthy();
    expect(JSON.parse(put[1].body).articles[0].title).toBe("合璧");
    // 静音 m4a 锚点写了
    expect(env.FILES._store.has(`${SCOPE}${r.newStem}.m4a`)).toBe(true);
    // 原文保留
    expect(env.FILES._store.has(`${SCOPE}articles/A.json`)).toBe(true);
    expect(env.FILES._store.has(`${SCOPE}articles/B.json`)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("新文章打上当前文风 head 的 style 字段；无 CLAUDE.json 则不带", async () => {
    const seed = {
      [`${SCOPE}articles/A.json`]: art("A", "甲", "甲的正文"),
      [`${SCOPE}articles/B.json`]: art("B", "乙", "乙的正文"),
      [`${SCOPE}CLAUDE.json`]: JSON.stringify({ schema: 3, head: 7, versions: [{ v: 7, style: "王建硕风格\n…" }] }),
    };
    const env = { FILES: memFiles(seed) };
    const callClaude = vi.fn(async () => ({ content: [{ type: "text", text: "合璧\n正文" }], usage: {} }));
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const r = await runTool("merge_articles", { stems: ["A", "B"] },
      { env, scope: SCOPE, token: "tk", origin: "https://jianshuo.dev", callClaude });
    expect(r.ok).toBe(true);
    const put = fetchSpy.mock.calls.find(([u, o]) => o?.method === "PUT" && String(u).includes("/files/api/articles/"));
    expect(JSON.parse(put[1].body).articles[0].style).toBe(7);

    // 无 CLAUDE.json → style 字段不出现（而不是 null/NaN）
    const env2 = { FILES: memFiles({
      [`${SCOPE}articles/A.json`]: art("A", "甲", "x"),
      [`${SCOPE}articles/B.json`]: art("B", "乙", "y"),
    }) };
    fetchSpy.mockClear();
    const r2 = await runTool("merge_articles", { stems: ["A", "B"] },
      { env: env2, scope: SCOPE, token: "tk", origin: "https://jianshuo.dev", callClaude, idemKey: "k2" });
    expect(r2.ok).toBe(true);
    const put2 = fetchSpy.mock.calls.find(([u, o]) => o?.method === "PUT" && String(u).includes("/files/api/articles/"));
    expect("style" in JSON.parse(put2[1].body).articles[0]).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("delete_article 暂存 + deleteArticleFiles 执行", () => {
  it("delete_article 只暂存 pending，不删文件", async () => {
    const env = { FILES: memFiles({ [`${SCOPE}articles/A.json`]: art("A", "甲", "x"), [`${SCOPE}A.m4a`]: "BYTES" }) };
    const r = await runTool("delete_article", { stem: "A" }, { env, scope: SCOPE });
    expect(r).toEqual({ ok: true, pending: { action: "delete", stem: "A", title: "甲" } });
    expect(env.FILES._store.has(`${SCOPE}articles/A.json`)).toBe(true);  // 没删
  });
  it("deleteArticleFiles 删文章 JSON + m4a 锚点", async () => {
    const env = { FILES: memFiles({ [`${SCOPE}articles/A.json`]: art("A", "甲", "x"), [`${SCOPE}A.m4a`]: "BYTES" }) };
    await deleteArticleFiles(env, SCOPE, "A");
    expect(env.FILES._store.has(`${SCOPE}articles/A.json`)).toBe(false);
    expect(env.FILES._store.has(`${SCOPE}A.m4a`)).toBe(false);
  });
});

describe("命令工具子集", () => {
  it("toolDefsFor 只返回指定工具，且命令集不含单篇编辑工具", () => {
    const defs = toolDefsFor(COMMAND_TOOL_NAMES);
    const names = defs.map((d) => d.name);
    expect(names).toContain("merge_articles");
    expect(names).toContain("delete_article");
    expect(names).toContain("list_articles");
    expect(names).not.toContain("edit_current_article");   // 单篇编辑不进命令集
    expect(names).not.toContain("write_article");
  });
});

describe("tool defs are valid Anthropic tool schemas (no extra keys)", () => {
  it("every command tool def has ONLY name/description/input_schema (Anthropic 400s on extras like `destructive`)", () => {
    const allowed = new Set(["name", "description", "input_schema", "type", "cache_control"]);
    for (const def of toolDefsFor(COMMAND_TOOL_NAMES)) {
      const extras = Object.keys(def).filter((k) => !allowed.has(k));
      expect(extras, `tool ${def.name} has extra keys: ${extras.join(",")}`).toEqual([]);
    }
  });
});

describe("tag_article", () => {
  const ORIGIN = "https://jianshuo.dev";
  function putBody(fetchSpy, stem) {
    const call = fetchSpy.mock.calls.find(([u, o]) => o?.method === "PUT" && String(u).includes(`/files/api/articles/${stem}`));
    return call ? JSON.parse(call[1].body) : null;
  }

  it("打标签：去重追加到 doc.tags，经 Files API PUT 写回", async () => {
    const env = { FILES: memFiles({ [`${SCOPE}articles/A.json`]: art("A", "甲", "正文", { tags: ["旧类"] }) }) };
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await runTool("tag_article", { stems: ["A"], tag: "创业" }, { env, scope: SCOPE, token: "tk", origin: ORIGIN });
    expect(r).toEqual({ ok: true, tagged: 1, tag: "创业" });
    expect(putBody(fetchSpy, "A").tags).toEqual(["旧类", "创业"]);
    // 重复打同一标签不产生重复项
    fetchSpy.mockClear();
    await runTool("tag_article", { stems: ["A"], tag: "旧类" }, { env, scope: SCOPE, token: "tk", origin: ORIGIN });
    expect(putBody(fetchSpy, "A").tags).toEqual(["旧类"]);
    vi.unstubAllGlobals();
  });

  it("schema-3 文档打标签不吃掉正文：PUT 带上当前 head 版本的 articles", async () => {
    const doc3 = JSON.stringify({ schema: 3, createdAt: 1, transcript: "tx", head: 2, versions: [
      { v: 1, savedAt: 1, source: "mine", articles: [{ title: "旧", body: "旧文" }] },
      { v: 2, savedAt: 2, source: "agent", articles: [{ title: "新", body: "新文" }] },
    ] });
    const env = { FILES: memFiles({ [`${SCOPE}articles/C.json`]: doc3 }) };
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await runTool("tag_article", { stems: ["C"], tag: "创业" }, { env, scope: SCOPE, token: "tk", origin: ORIGIN });
    expect(r.ok).toBe(true);
    expect(putBody(fetchSpy, "C").tags).toEqual(["创业"]);
    expect(putBody(fetchSpy, "C").articles).toEqual([{ title: "新", body: "新文" }]);
    vi.unstubAllGlobals();
  });

  it("remove=true 移除标签；删空后 tags 字段整个消失", async () => {
    const env = { FILES: memFiles({
      [`${SCOPE}articles/A.json`]: art("A", "甲", "正文", { tags: ["甲类", "乙类"] }),
      [`${SCOPE}articles/B.json`]: art("B", "乙", "正文", { tags: ["甲类"] }),
    }) };
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await runTool("tag_article", { stems: ["A", "B"], tag: "甲类", remove: true },
      { env, scope: SCOPE, token: "tk", origin: ORIGIN });
    expect(r).toEqual({ ok: true, untagged: 2, tag: "甲类" });
    expect(putBody(fetchSpy, "A").tags).toEqual(["乙类"]);
    expect("tags" in putBody(fetchSpy, "B")).toBe(false);   // 删空 → 字段消失
    vi.unstubAllGlobals();
  });
});

describe("tags 读取（list_articles / read_article）", () => {
  it("list_articles 带出 tags；无 tag 的条目不带该字段", async () => {
    const env = { FILES: memFiles({
      [`${SCOPE}articles/A.json`]: art("A", "甲", "正文", { tags: ["创业"] }),
      [`${SCOPE}articles/B.json`]: art("B", "乙", "正文"),
    }) };
    const r = await runTool("list_articles", {}, { env, scope: SCOPE });
    const a = r.articles.find((x) => x.stem === "A");
    const b = r.articles.find((x) => x.stem === "B");
    expect(a.tags).toEqual(["创业"]);
    expect("tags" in b).toBe(false);
  });

  it("read_article 带出 tags", async () => {
    const env = { FILES: memFiles({ [`${SCOPE}articles/A.json`]: art("A", "甲", "正文", { tags: ["创业", "东京"] }) }) };
    const r = await runTool("read_article", { stem: "A" }, { env, scope: SCOPE });
    expect(r.tags).toEqual(["创业", "东京"]);
    // 无 tag 的文章不带该字段
    const env2 = { FILES: memFiles({ [`${SCOPE}articles/B.json`]: art("B", "乙", "正文") }) };
    const r2 = await runTool("read_article", { stem: "B" }, { env: env2, scope: SCOPE });
    expect("tags" in r2).toBe(false);
  });
});
