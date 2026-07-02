// style 出正文进 schema 字段（2026-07-03，spec: voicedrop docs/superpowers/specs/
// 2026-07-03-style-field-schema-design.md）。三个不变量：
//   1. linenum 编号永不把 `<!--…-->` 注释算作一行（对齐 iOS 的 stripOriginComment）；
//   2. per-article 未知字段（style / 未来任何字段）穿过每条编辑写路径都不丢；
//   3. 存量迁移 transform：注释 → style 字段、body 去注释、幂等。
import { describe, it, expect } from "vitest";
import { numberBodyRows, inlineNumberedBody, applyArticleEdits } from "../src/linenum.js";
import { migrateArticle, migrateDoc } from "../scripts/migrate-style-field/transform.js";
import { runTool } from "../src/tools.js";
import { fakeEnv, fakeFetch } from "./fakes.js";

const LEGACY_BODY = "<!-- style: 风格 v1 -->\n\n关于法语工具的想法。\n\n## 一、考官模式";

describe("linenum ignores HTML comments (mirror of iOS stripOriginComment)", () => {
  it("a leading style comment does not consume 第1行", () => {
    const rows = numberBodyRows(LEGACY_BODY);
    expect(rows[0]).toMatchObject({ n: 1, text: "关于法语工具的想法。" });
    expect(rows[1]).toMatchObject({ n: 2, text: "## 一、考官模式" });
  });
  it("inlineNumberedBody never shows a comment to the model", () => {
    expect(inlineNumberedBody(LEGACY_BODY)).not.toContain("<!--");
  });
  it("mid-body comments are ignored too", () => {
    const rows = numberBodyRows("一\n\n<!-- x -->\n\n二");
    expect(rows.map((r) => r.text)).toEqual(["一", "二"]);
  });
  it("applyArticleEdits targets the line the USER sees and self-heals the comment away", () => {
    const r = applyArticleEdits(LEGACY_BODY, [{ op: "replace_line", line: 1, text: "新第一段" }]);
    expect(r.body).toBe("新第一段\n\n## 一、考官模式");
    expect(r.body).not.toContain("<!--");
  });
});

const CTX = (env, extra = {}) => ({
  env, scope: "users/u/", articleKey: "users/u/articles/s.json",
  token: "t", origin: "https://jianshuo.dev", ...extra,
});
const PUT_OK = { "PUT https://jianshuo.dev/files/api/articles/s": () => ({ ok: true, body: { ok: true } }) };

describe("per-article unknown fields survive every edit write path", () => {
  const seed = () => fakeEnv({
    "users/u/articles/s.json": JSON.stringify({
      schema: 2, transcript: "tx",
      articles: [{ title: "T", body: "一\n\n二", style: 3, wechatMediaId: "m1", futureField: "keep-me" }],
    }),
  });

  it("edit_current_article keeps style + any future field", async () => {
    const env = seed();
    globalThis.fetch = fakeFetch(PUT_OK);
    const r = await runTool("edit_current_article", { ops: [{ op: "delete_lines", lines: [2] }] }, CTX(env));
    expect(r).toEqual({ ok: true });
    const sent = JSON.parse(globalThis.fetch.calls[0].body);
    expect(sent.articles[0]).toEqual({
      title: "T", body: "一", style: 3, wechatMediaId: "m1", futureField: "keep-me",
    });
  });

  it("write_article inherits prev fields by index, model output only overrides title/body", async () => {
    const env = seed();
    globalThis.fetch = fakeFetch(PUT_OK);
    const r = await runTool("write_article", { articles: [{ title: "新T", body: "新正文" }] }, CTX(env));
    expect(r).toEqual({ ok: true, count: 1 });
    const sent = JSON.parse(globalThis.fetch.calls[0].body);
    expect(sent.articles[0]).toEqual({
      title: "新T", body: "新正文", style: 3, wechatMediaId: "m1", futureField: "keep-me",
    });
  });
});

describe("migrate-style-field transform", () => {
  it("hoists the comment into style and cleans the body", () => {
    const { article, changed } = migrateArticle({ title: "T", body: LEGACY_BODY });
    expect(changed).toBe(true);
    expect(article.style).toBe(1);
    expect(article.body).toBe("关于法语工具的想法。\n\n## 一、考官模式");
  });
  it("never overwrites an existing style field; still strips the comment", () => {
    const { article } = migrateArticle({ title: "T", body: "<!-- style: 风格 v2 -->\n\nx", style: 9 });
    expect(article.style).toBe(9);
    expect(article.body).toBe("x");
  });
  it("collapses the blank gap a mid-body comment leaves behind", () => {
    const { article } = migrateArticle({ title: "T", body: "一\n\n<!-- note -->\n\n二" });
    expect(article.body).toBe("一\n\n二");
  });
  it("is idempotent: a clean article is untouched", () => {
    const a = { title: "T", body: "一\n\n二", style: 1 };
    expect(migrateArticle(a)).toEqual({ article: a, changed: false });
  });
  it("migrates every schema-3 version entry", () => {
    const doc = {
      head: 2,
      versions: [
        { v: 1, articles: [{ title: "旧", body: "<!-- style: 风格 v1 -->\n\n旧文" }] },
        { v: 2, articles: [{ title: "新", body: "<!-- style: 风格 v2 -->\n\n新文" }] },
      ],
    };
    const r = migrateDoc(doc);
    expect(r.changed).toBe(true);
    expect(r.doc.versions[0].articles[0]).toMatchObject({ style: 1, body: "旧文" });
    expect(r.doc.versions[1].articles[0]).toMatchObject({ style: 2, body: "新文" });
  });
  it("migrates schema-2 top-level articles + history", () => {
    const doc = {
      schema: 2,
      articles: [{ title: "A", body: "<!-- style: 风格 v3 -->\n\n正文" }],
      history: [{ v: 1, articles: [{ title: "A0", body: "<!-- style: 风格 v1 -->\n\n老正文" }] }],
    };
    const r = migrateDoc(doc);
    expect(r.changed).toBe(true);
    expect(r.doc.articles[0]).toMatchObject({ style: 3, body: "正文" });
    expect(r.doc.history[0].articles[0]).toMatchObject({ style: 1, body: "老正文" });
  });
  it("leaves a comment-free doc unchanged (safe to re-run)", () => {
    const doc = { head: 1, versions: [{ v: 1, articles: [{ title: "T", body: "干净" }] }] };
    expect(migrateDoc(doc).changed).toBe(false);
  });
});
