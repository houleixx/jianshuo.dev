// VoiceDrop agent tools — general primitives the article-editing agent composes.
// Each handler takes (args, ctx) where ctx = {env, scope, articleKey, token, origin}.

import { resolveArticles } from "../../functions/lib/article-store.js";
import { resolveStyle, parseStyleMarkdown } from "../../functions/lib/style-store.js";
import { applyArticleEdits } from "./linenum.js";
import { imageCostUY } from "./usage.js";
import { ensureAccount } from "./usage_store.js";

export const TOOL_DEFS = []; // populated in Tasks 2–4

const HANDLERS = {}; // name -> async (args, ctx) => result  (populated below)

export async function runTool(name, args, ctx) {
  const h = HANDLERS[name];
  if (!h) return { error: "unknown_tool" };
  try {
    return await h(args || {}, ctx);
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// Internal: register a tool definition + handler together.
export function register(def, handler) {
  TOOL_DEFS.push(def);
  HANDLERS[def.name] = handler;
}

function badStem(stem) {
  return !stem || typeof stem !== "string" || stem.includes("/") || stem.includes("..");
}

// currentArticles → resolveArticles, imported from the shared
// functions/lib/article-store.js (single source of truth).

register(
  { name: "list_articles", description: "列出当前用户的全部已成文文章（最新在前）。用来挑选要合并/参考的文章。", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  async (_args, { env, scope }) => {
    const prefix = scope + "articles/";
    const listed = await env.FILES.list({ prefix, limit: 1000 });
    const stems = listed.objects
      .map((o) => o.key)
      .filter((k) => k.endsWith(".json"))
      .map((k) => k.slice(prefix.length, -".json".length));
    const out = [];
    for (const stem of stems) {
      const obj = await env.FILES.get(prefix + stem + ".json");
      if (!obj) continue;
      let doc; try { doc = JSON.parse(await obj.text()); } catch { continue; }
      const title = resolveArticles(doc)[0]?.title || "(无题)";
      out.push({ stem, title, createdAt: doc.createdAt || 0 });
    }
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return { articles: out.slice(0, 30) };
  }
);

register(
  { name: "read_article", description: "读取某一篇文章的口述转写和正文。", input_schema: { type: "object", properties: { stem: { type: "string" } }, required: ["stem"], additionalProperties: false } },
  async ({ stem }, { env, scope }) => {
    if (badStem(stem)) return { error: "bad_stem" };
    const obj = await env.FILES.get(scope + "articles/" + stem + ".json");
    if (!obj) return { error: "not_found" };
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
    const articles = resolveArticles(doc).map((a) => ({ title: a.title, body: a.body }));
    return { transcript: doc.transcript || "", articles };
  }
);

register(
  { name: "write_article", description: "把改写后的全部文章写回当前正在编辑的这一篇（只能写当前篇）。输入是完整的文章数组。", input_schema: { type: "object", properties: { articles: { type: "array", items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"], additionalProperties: false } } }, required: ["articles"], additionalProperties: false } },
  async ({ articles }, { env, articleKey, token, origin, editId }) => {
    if (!Array.isArray(articles) || !articles.length) return { error: "empty_articles" };
    const obj = await env.FILES.get(articleKey);
    if (!obj) return { error: "not_found" };
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
    // Schema-3: current articles are in versions[head], not at top level.
    const prev = resolveArticles(doc);
    doc.articles = articles.map((a, i) => {
      const out = { title: String(a.title || "(无题)"), body: String(a.body || "") };
      if (prev[i] && prev[i].wechatMediaId) out.wechatMediaId = prev[i].wechatMediaId;
      return out;
    });
    delete doc.title; delete doc.body; // collapse any v1 remnants
    // Stamp the instruction id that produced this doc — drives crash-safe
    // exactly-once in the durable queue (queue.js _runRow). writeArticleDoc's
    // {...rest} preserves this top-level field.
    if (editId) doc.lastEditId = editId;
    // Write through the article API so version control is handled in one place.
    // articleKey = "users/<sub>/articles/<stem>.json"; stem = last segment without .json
    const stem = articleKey.split("/articles/").pop().replace(/\.json$/, "");
    const resp = await globalThis.fetch(`${origin}/files/api/articles/${stem}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(doc),
    });
    if (!resp.ok) return { error: `upload_failed_${resp.status}` };
    return { ok: true, count: doc.articles.length };
  }
);

// Shared write path for the article tools: stamp the editId, PUT through the
// versioned article API. Returns null on success or { error } on failure.
async function putArticleDoc(doc, { articleKey, token, origin, editId }) {
  if (editId) doc.lastEditId = editId;
  const stem = articleKey.split("/articles/").pop().replace(/\.json$/, "");
  const resp = await globalThis.fetch(`${origin}/files/api/articles/${stem}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  return resp.ok ? null : { error: `upload_failed_${resp.status}` };
}

register(
  {
    name: "edit_current_article",
    description:
      "定点修改当前正在编辑的这一篇——删一行 / 改一行 / 删图 / 插入一段 / 改标题。这是改当前篇的默认工具：只描述这次的改动，绝不要回传整篇正文。行号就用当前文章正文里标的第N行（删图也用图所在的第N行）。一次可以带多个 ops，行号都按改之前的原始编号算。",
    input_schema: {
      type: "object",
      properties: {
        ops: {
          type: "array",
          description: "一组改动，按顺序应用；行号一律指当前文章正文里改之前的第N行。",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["delete_lines", "replace_line", "insert_after", "set_title"] },
              line: { type: "integer", description: "第N行的 N。replace_line / insert_after 用；insert_after 用 0 表示插到正文最前面。" },
              lines: { type: "array", items: { type: "integer" }, description: "要删除的第N行号数组（delete_lines 用；删图也是删它所在的第N行）。" },
              text: { type: "string", description: "新的整行文本（replace_line / insert_after 用）。只写这一行，[[photo:…]] 标记原样保留、里面的 key 一个字都不要改。" },
              title: { type: "string", description: "新的文章标题（set_title 用）。" },
            },
            required: ["op"],
            additionalProperties: false,
          },
        },
      },
      required: ["ops"],
      additionalProperties: false,
    },
  },
  async ({ ops }, ctx) => {
    const { env, articleKey, articleIndex } = ctx;
    if (!Array.isArray(ops) || !ops.length) return { error: "empty_ops" };
    const obj = await env.FILES.get(articleKey);
    if (!obj) return { error: "not_found" };
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
    const articles = resolveArticles(doc);
    if (!articles.length) return { error: "no_article" };
    const idx = (Number.isInteger(articleIndex) && articleIndex >= 0 && articleIndex < articles.length) ? articleIndex : 0;
    const target = articles[idx];

    const titleOp = ops.find((o) => o && o.op === "set_title");
    const bodyOps = ops.filter((o) => o && o.op !== "set_title");

    let newBody = String(target.body || "");
    if (bodyOps.length) {
      const r = applyArticleEdits(newBody, bodyOps);
      if (r.error) return r; // surface line_not_found / cannot_replace_photo / … back to the model
      newBody = r.body;
    }
    const newTitle = (titleOp && typeof titleOp.title === "string" && titleOp.title.trim())
      ? titleOp.title.trim()
      : target.title;

    // Rebuild the full article list, replacing only the target; preserve every
    // other article verbatim and keep each article's wechatMediaId.
    doc.articles = articles.map((a, i) => {
      const next = { title: String((i === idx ? newTitle : a.title) || "(无题)"), body: String(i === idx ? newBody : (a.body || "")) };
      if (a.wechatMediaId) next.wechatMediaId = a.wechatMediaId;
      return next;
    });
    delete doc.title; delete doc.body; // collapse any v1 remnants

    const err = await putArticleDoc(doc, ctx);
    if (err) return err;
    return { ok: true };
  }
);

register(
  // 文风现在存 CLAUDE.json（schema-3 版本化，与文章同格式）；老 CLAUDE.md 的「# 我的文风」
  // 段仅作读回退。返回的是文风正文（不含名字——名字暂留老 CLAUDE.md，另行管理）。
  { name: "read_style", description: "读取用户的写作文风（文风正文）。调整文风前先读出来。", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  async (_args, { env, scope }) => {
    const obj = await env.FILES.get(scope + "CLAUDE.json");
    if (obj) { try { return { style: resolveStyle(JSON.parse(await obj.text())) }; } catch {} }
    const legacy = await env.FILES.get(scope + "CLAUDE.md");
    return { style: legacy ? parseStyleMarkdown(await legacy.text()) : "" };
  }
);

register(
  // 走 /files/api/style 端点做服务端版本化写（版本逻辑单一真源在 style-store.js）。
  { name: "write_style", description: "整体覆盖写用户的写作文风（版本化写回 CLAUDE.json）。先 read_style 读出当前内容，改完再整体写回。影响以后所有挖矿和编辑。", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false } },
  async ({ content }, { token, origin }) => {
    if (!content || !String(content).trim()) return { error: "empty_content" };
    const resp = await globalThis.fetch(`${origin}/files/api/style`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ style: String(content), source: "agent" }),
    });
    return resp.ok ? { ok: true } : { error: `upload_failed_${resp.status}` };
  }
);

function relKey({ articleKey, scope }) {
  if (!articleKey.startsWith(scope)) throw new Error("bad_scope");
  return articleKey.slice(scope.length);
}

// 编辑结果的新 R2 相对键：保留原图的 session 目录、换新时间戳文件名、强制 .png
// （paint 默认出 png）。scope+此键必须匹配公开 /photo 端点的 photos/*.(jpg|png)。
export function makeEditedKey(oldKey, nowMs) {
  const m = /^photos\/([^/]+)\//.exec(String(oldKey || ""));
  const session = m ? m[1] : String(nowMs);
  return `photos/${session}/${nowMs}.png`;
}

async function postFiles(path, { token, origin }) {
  const resp = await globalThis.fetch(`${origin}/files/api/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok) return body || { error: `http_${resp.status}` };
  return body;
}

register(
  { name: "publish_wechat", description: "把当前这篇文章发布为微信公众号草稿（说了直接发）。", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  async (_args, ctx) => postFiles(`wechat/${relKey(ctx)}`, ctx)
);

register(
  { name: "share_to_community", description: "把当前这篇文章分享到 VoiceDrop 社区（立即分享）。", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  async (_args, ctx) => postFiles(`community/share/${relKey(ctx)}`, ctx)
);

register(
  {
    name: "edit_photo",
    description:
      "把当前文章里某张图按指令重画/编辑（如变成广告、换背景、改风格）。参数 key 用该图 [[photo:KEY]] 里的 KEY（从当前正文图M那行读出）；prompt 是你把用户口述蒸馏成的完整图像编辑指令。异步：提交后约 1 分钟自动替换，本轮先告诉用户在处理，不要重复调用。",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "要编辑的图片的 [[photo:KEY]] 里的 KEY，原样照抄，一个字都不要改。" },
        prompt: { type: "string", description: "编辑指令蒸馏成的完整 prompt，例如：把这张产品照做成干净的电商广告主图，突出主体、简洁背景、留白舒适。" },
      },
      required: ["key", "prompt"],
      additionalProperties: false,
    },
  },
  async ({ key, prompt }, ctx) => {
    const { env, scope, articleKey, articleIndex, origin, editId } = ctx;
    if (!key || !prompt) return { error: "missing_key_or_prompt" };

    const now = Date.now();
    const bal = await ensureAccount(env.USAGE, scope, now);
    if (bal < imageCostUY()) return { error: "算力不足，生成一张图 4.2 算力，请充值" };

    const obj = await env.FILES.get(articleKey);
    if (!obj) return { error: "not_found" };
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
    const articles = resolveArticles(doc);
    if (!articles.length) return { error: "no_article" };
    const idx = (Number.isInteger(articleIndex) && articleIndex >= 0 && articleIndex < articles.length) ? articleIndex : 0;

    const marker = `[[photo:${key}]]`;
    if (!String(articles[idx].body || "").includes(marker)) return { error: "找不到这张图" };

    const newKey = makeEditedKey(key, now);
    const newMarker = `[[photo:${newKey}]]`;
    const swap = (b) => String(b).split(marker).join(newMarker);
    doc.articles = articles.map((a, i) => {
      const next = { title: String(a.title || "(无题)"), body: i === idx ? swap(a.body) : String(a.body || "") };
      if (a.wechatMediaId) next.wechatMediaId = a.wechatMediaId;
      return next;
    });
    delete doc.title; delete doc.body;
    const werr = await putArticleDoc(doc, ctx);
    if (werr) return werr;

    const paintBase = env.PAINT_BASE || "https://paint.jianshuo.dev";
    let resp = null;
    try {
      resp = await globalThis.fetch(`${paintBase}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.PAINT_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          size: "1024x1024",
          image_url: `${origin}/files/api/photo/${scope}${key}`,
          callback_url: `${origin}/agent/paint-callback`,
          callback_token: env.PAINT_CALLBACK_TOKEN,
          callback_meta: { scope, oldKey: key, newKey, articleKey, editId: editId || null },
        }),
      });
    } catch { resp = null; }

    if (!resp || resp.status !== 202) {
      // 回退指针：把 newKey 换回 oldKey，保持文档与"没有在跑的任务"一致
      const revert = resolveArticles(doc).map((a, i) => {
        const next = { title: a.title, body: i === idx ? String(a.body).split(newMarker).join(marker) : a.body };
        if (a.wechatMediaId) next.wechatMediaId = a.wechatMediaId;
        return next;
      });
      await putArticleDoc({ ...doc, articles: revert }, ctx);
      return { error: "图片服务提交失败" };
    }
    return { ok: true, message: "🎨 正在把图片改成…，约 1 分钟完成" };
  }
);
