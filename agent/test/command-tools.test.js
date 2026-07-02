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
