// VoiceDrop agent tools — general primitives the article-editing agent composes.
// Each handler takes (args, ctx) where ctx = {env, scope, articleKey, token, origin}.

import { TITLE_FALLBACK, resolveArticles, appendQuestions, byNewestFirst } from "../../functions/lib/article-store.js";
import { readStyleText, readStyleDoc } from "../../functions/lib/style-store.js";
import { applyArticleEdits } from "./linenum.js";
import { imageCostUY, IMAGE_SUANLI } from "./usage.js";
import { ensureAccount } from "./usage_store.js";
import { restyleArticle, ensurePhotoMarkers } from "./miner.js";
import { silentM4aBytes } from "./silent-m4a.js";
import { snapSize, jpegDims, fitSize } from "./paint-size.js";
import { MERGE_ARTICLES_DESC, ADD_FOLLOWUPS_DESC, EDIT_PHOTO_DESC, NEW_PHOTO_DESC } from "./prompts/tool-desc.js";

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
      const title = resolveArticles(doc)[0]?.title || TITLE_FALLBACK;
      const entry = { stem, title, createdAt: doc.createdAt || 0 };
      if (Array.isArray(doc.tags) && doc.tags.length) entry.tags = doc.tags;
      out.push(entry);
    }
    // 排序必须先于 slice：排错了，取的就是最老的 30 篇而不是最新的 30 篇。
    out.sort(byNewestFirst);
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
    const out = { transcript: doc.transcript || "", articles };
    if (Array.isArray(doc.tags) && doc.tags.length) out.tags = doc.tags;
    return out;
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
    // 继承+覆盖（不要白名单重建）：按 index 保留旧文章的一切字段（style / wechatMediaId /
    // 未来新字段），只覆盖模型真正改的 title/body。白名单会在每次编辑时静默丢新字段。
    doc.articles = articles.map((a, i) => ({
      ...(prev[i] || {}),
      title: String(a.title || TITLE_FALLBACK), body: String(a.body || ""),
    }));
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
    doc.articles = articles.map((a, i) => ({
      ...a, // 继承一切字段（style / wechatMediaId / …），只覆盖改动
      title: String((i === idx ? newTitle : a.title) || TITLE_FALLBACK),
      body: String(i === idx ? newBody : (a.body || "")),
    }));
    delete doc.title; delete doc.body; // collapse any v1 remnants

    const err = await putArticleDoc(doc, ctx);
    if (err) return err;
    return { ok: true };
  }
);

register(
  // 追问 sidecar 追加：模型在本回合上下文里（转写 + 全文都在手上）自己出题，
  // 这里只负责去重落库（元数据写，不铸版本）。App 收到 updated doc 后星标/
  // 卡片自动接上新题。
  { name: "add_followups",
    description: ADD_FOLLOWUPS_DESC,
    input_schema: { type: "object", properties: {
      questions: { type: "array", items: { type: "string" }, description: "1–3 个新问题" },
    }, required: ["questions"], additionalProperties: false } },
  async ({ questions }, ctx) => {
    const { env, articleKey, articleIndex } = ctx;
    const texts = (Array.isArray(questions) ? questions : []).map((q) => String(q || "").trim()).filter(Boolean);
    if (!texts.length) return { error: "empty_questions" };
    const idx = (Number.isInteger(articleIndex) && articleIndex >= 0) ? articleIndex : 0;
    const r = await appendQuestions(env, articleKey, texts, idx);
    if (!r) return { error: "not_found" };
    // added=0 → 全是问过的（含已答/已跳过），告诉模型别再重复。
    return { ok: true, added: r.added, total: (r.doc.questions || []).length };
  }
);

register(
  // 文风现在存 CLAUDE.json（schema-3 版本化，与文章同格式）；老 CLAUDE.md 的「# 我的文风」
  // 段仅作读回退。返回的是文风正文（不含名字——名字暂留老 CLAUDE.md，另行管理）。
  { name: "read_style", description: "读取用户的写作文风（文风正文）。调整文风前先读出来。", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  async (_args, { env, scope }) => {
    return { style: await readStyleText(env, scope) };
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

// 编辑结果的新 R2 相对键：保留原图的 session 目录、换新时间戳文件名 + 随机后缀、
// 跟原图一样的 .jpg（paint 走 jpeg 输出）。scope+此键必须匹配公开 /photo 端点的
// photos/*.(jpg|png)。
export function makeEditedKey(oldKey, nowMs, rand = "0") {
  const m = /^photos\/([^/]+)\//.exec(String(oldKey || ""));
  const session = m ? m[1] : String(nowMs);
  return `photos/${session}/${nowMs}-${rand}.jpg`;
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

// Shared paint-job POST for both edit_photo (oldKey present → edit mode with
// image_url) and new_photo (no oldKey → generate mode, no image_url). Returns
// the fetch Response, or null on network failure (caller checks status).
async function postPaintJob(ctx, { prompt, newKey, oldKey, size }) {
  const { env, scope, articleKey, origin, editId } = ctx;
  const paintBase = env.PAINT_BASE || "https://paint.jianshuo.dev";
  const meta = { scope, newKey, articleKey, editId: editId || null };
  const body = {
    prompt,
    size: snapSize(size, "1024x1024"), // 对齐 16 的倍数：paint 拒绝非 16 倍数的宽高
    format: "jpeg",
    callback_url: `${origin}/agent/paint-callback`,
    callback_token: env.PAINT_CALLBACK_TOKEN,
    callback_meta: meta,
  };
  if (oldKey) {
    body.image_url = `${origin}/files/api/photo/${scope}${oldKey}`;
    meta.oldKey = oldKey;
  }
  try {
    return await globalThis.fetch(`${paintBase}/api/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.PAINT_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

register(
  {
    name: "edit_photo",
    description: EDIT_PHOTO_DESC,
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
    const { env, scope, articleKey, articleIndex } = ctx;
    if (!key || !prompt) return { error: "missing_key_or_prompt" };

    const now = Date.now();
    const bal = await ensureAccount(env.USAGE, scope, now);
    if (bal < imageCostUY()) return { error: `算力不足，生成一张图 ${IMAGE_SUANLI} 算力，请充值` };

    const obj = await env.FILES.get(articleKey);
    if (!obj) return { error: "not_found" };
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
    const articles = resolveArticles(doc);
    if (!articles.length) return { error: "no_article" };
    const idx = (Number.isInteger(articleIndex) && articleIndex >= 0 && articleIndex < articles.length) ? articleIndex : 0;

    const marker = `[[photo:${key}]]`;
    if (!String(articles[idx].body || "").includes(marker)) return { error: "找不到这张图" };

    const rand = Math.random().toString(36).slice(2, 8);
    const newKey = makeEditedKey(key, now, rand);
    const newMarker = `[[photo:${newKey}]]`;
    const swap = (b) => String(b).split(marker).join(newMarker);
    doc.articles = articles.map((a, i) => ({
      ...a, title: String(a.title || TITLE_FALLBACK), body: i === idx ? swap(a.body) : String(a.body || ""),
    }));
    delete doc.title; delete doc.body;
    const werr = await putArticleDoc(doc, ctx);
    if (werr) return werr;

    // 输出尺寸对齐原图比例：相册导入的图不是方的（App b07ad15 起），写死
    // 1024x1024 会把横竖图重画成方形。读 R2 原图的 JPEG 头拿宽高；读不到
    // （缺图/非 JPEG）回退方图，即老行为。
    let size;
    try {
      const photo = await env.FILES.get(`${scope}${key}`);
      const dims = photo ? jpegDims(await photo.arrayBuffer()) : null;
      if (dims) size = fitSize(dims.w, dims.h) || undefined;
    } catch { /* 尺寸探测失败不阻塞编辑 */ }

    const resp = await postPaintJob(ctx, { prompt, newKey, oldKey: key, size });

    if (!resp || resp.status !== 202) {
      // 回退指针：把 newKey 换回 oldKey，保持文档与"没有在跑的任务"一致
      const revert = resolveArticles(doc).map((a, i) => ({
        ...a, body: i === idx ? String(a.body).split(newMarker).join(marker) : a.body,
      }));
      await putArticleDoc({ ...doc, articles: revert }, ctx);
      return { error: "图片服务提交失败" };
    }
    return { ok: true, message: "🎨 正在把图片改成…，约 1 分钟完成" };
  }
);

register(
  {
    name: "new_photo",
    description: NEW_PHOTO_DESC,
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "图像生成指令，完整清晰，例如：一张扁平插画风格的城市夜景，暖色调，简洁留白。" },
        after_line: { type: "integer", description: "插到当前正文第 N 行之后；0 = 插到正文最前面。" },
        size: { type: "string", description: "图片尺寸「宽x高」，按用途选比例：缺省 1024x1024 方图；公众号题图等 2.45:1 横幅用 1568x640；竖幅插画用 1024x1536。指令里提到横幅/竖幅/比例时必须带上对应尺寸。" },
      },
      required: ["prompt", "after_line"],
      additionalProperties: false,
    },
  },
  async ({ prompt, after_line, size }, ctx) => {
    const { env, scope, articleKey, articleIndex } = ctx;
    if (!prompt) return { error: "missing_prompt" };

    const now = Date.now();
    const bal = await ensureAccount(env.USAGE, scope, now);
    if (bal < imageCostUY()) return { error: `算力不足，生成一张图 ${IMAGE_SUANLI} 算力，请充值` };

    const obj = await env.FILES.get(articleKey);
    if (!obj) return { error: "not_found" };
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
    const articles = resolveArticles(doc);
    if (!articles.length) return { error: "no_article" };
    const idx = (Number.isInteger(articleIndex) && articleIndex >= 0 && articleIndex < articles.length) ? articleIndex : 0;

    const newKey = makeEditedKey("", now, Math.random().toString(36).slice(2, 8));
    const marker = `[[photo:${newKey}]]`;
    const r = applyArticleEdits(String(articles[idx].body || ""), [{ op: "insert_after", line: Number(after_line) || 0, text: marker }]);
    if (r.error) return r; // surface line_not_found etc.

    const origBodies = articles.map((a) => String(a.body || ""));
    doc.articles = articles.map((a, i) => ({
      ...a, title: String(a.title || TITLE_FALLBACK), body: i === idx ? r.body : String(a.body || ""),
    }));
    delete doc.title; delete doc.body;
    const werr = await putArticleDoc(doc, ctx);
    if (werr) return werr;

    const resp = await postPaintJob(ctx, { prompt, newKey, size }); // generate: no oldKey

    if (!resp || resp.status !== 202) {
      // 回退：撤掉插入的新图 marker，保持文档与"没有在跑的任务"一致
      const revert = articles.map((a, i) => ({
        ...a, title: String(a.title || TITLE_FALLBACK), body: origBodies[i],
      }));
      await putArticleDoc({ ...doc, articles: revert }, ctx);
      return { error: "图片服务提交失败" };
    }
    return { ok: true, message: "🎨 正在生成新图，约 1 分钟出现" };
  }
);

// 生成合并/新文章的 stem。ts 用调用时刻（普通 Worker 运行时，Date 可用）。
function mergedStem() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `VoiceDrop-merged-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 把一篇「无录音的独立文章」写进库并让它出现在「我的录音」：先写 article JSON（版本化
// Files API），再写 0s 静音 m4a 锚点。返回 { ok, stem } 或 { error }。
async function writeStandaloneArticle({ env, scope, token, origin }, stem, title, body, styleV) {
  const article = { title, body, ...(Number.isInteger(styleV) ? { style: styleV } : {}) };
  const doc = { schema: 2, id: stem, sourceAudio: `${stem}.m4a`, createdAt: new Date().toISOString(), transcript: "", srt: "", articles: [article], status: "ready", model: "merge" };
  const resp = await globalThis.fetch(`${origin}/files/api/articles/${stem}`, {
    method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(doc),
  });
  if (!resp.ok) return { error: `upload_failed_${resp.status}` };
  await env.FILES.put(`${scope}${stem}.m4a`, silentM4aBytes(), { httpMetadata: { contentType: "audio/mp4" } });
  return { ok: true, stem };
}

register(
  { name: "merge_articles",
    description: MERGE_ARTICLES_DESC,
    input_schema: { type: "object", properties: { stems: { type: "array", items: { type: "string" } }, guidance: { type: "string", description: "可选，合并侧重" } }, required: ["stems"], additionalProperties: false } },
  async ({ stems, guidance }, ctx) => {
    const { env, scope, callClaude } = ctx;
    if (!Array.isArray(stems) || stems.length < 2) return { error: "need_two_stems" };
    const parts = [];
    for (const stem of stems) {
      if (badStem(stem)) return { error: "bad_stem" };
      const obj = await env.FILES.get(`${scope}articles/${stem}.json`);
      if (!obj) return { error: `not_found:${stem}` };
      let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: `bad_article:${stem}` }; }
      const a = resolveArticles(doc)[0] || {};
      parts.push(`《${a.title || TITLE_FALLBACK}》\n${a.body || ""}`);
    }
    const style = (await readStyleText(env, scope).catch(() => "")) || "";
    const system = `你是${"王建硕"}的写作助手。把用户给的几篇文章揉成一篇连贯的新文章：去重、顺逻辑、保持下面这套写作风格。第一行只写标题（不加书名号/引号），其余为正文。\n原文里的 [[photo:…]] 照片标记必须全部保留到合并稿：key 一字不改、独占一行、放到语义对应的段落处，一张都不能丢。\n\n【写作风格】\n${style}`.trim();
    const user = `${guidance ? `合并侧重：${guidance}\n\n` : ""}请把以下 ${parts.length} 篇合并成一篇：\n\n${parts.join("\n\n---\n\n")}`;
    const resp = await callClaude({ system, messages: [{ role: "user", content: user }] });
    const text = (resp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!text) return { error: "empty_merge" };
    const nl = text.indexOf("\n");
    const title = (nl === -1 ? text : text.slice(0, nl)).trim().slice(0, 40) || "合并文章";
    let body = (nl === -1 ? "" : text.slice(nl + 1)).trim();
    // 保底：源文章里的每个照片标记都必须活着走进合并稿（prompt 之外的硬保证）。
    body = ensurePhotoMarkers(
      parts.map((p) => ({ body: p })), [{ title, body }])[0].body;
    // 确定性 stem：从稳定的 idemKey（队列行 id）派生，重跑同一 turn 不会造出第二篇。
    // 无 idemKey（旧调用）退回墙钟 mergedStem()。
    const stem = "VoiceDrop-merged-" + String(ctx.idemKey || mergedStem()).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    // 幂等：这篇已存在（上次跑到一半被驱逐后重跑）→ 直接返回已有的，不再造第二篇。
    if (await env.FILES.head(`${scope}articles/${stem}.json`)) return { ok: true, newStem: stem, title: "(已合并)", merged: stems.length };
    // 合并用的就是当前文风 head 的风格文本，所以新文章的 style 字段也打 head 的版本号。
    const headV = await readStyleDoc(env, scope).then((d) => (d && Number.isInteger(d.head) ? d.head : null)).catch(() => null);
    const w = await writeStandaloneArticle(ctx, stem, title, body, headV);
    if (w.error) return w;
    return { ok: true, newStem: stem, title, merged: stems.length };
  }
);

register(
  { name: "restyle_article",
    description: "用当前写作风格把某篇文章重写一遍（换个风格/口吻）。stem 是要重写的文章。",
    input_schema: { type: "object", properties: { stem: { type: "string" } }, required: ["stem"], additionalProperties: false } },
  async ({ stem }, { env, scope }) => {
    if (badStem(stem)) return { error: "bad_stem" };
    const r = await restyleArticle(env, scope, stem, null);   // null → 用当前文风 head
    return r && r.ok === false ? { error: r.reason || "restyle_failed" } : { ok: true, stem };
  }
);

register(
  { name: "delete_article",
    description: "删除一篇文章（破坏性，需用户确认后才真正删）。stem 是要删的文章。",
    input_schema: { type: "object", properties: { stem: { type: "string" } }, required: ["stem"], additionalProperties: false } },
  async ({ stem }, { env, scope }) => {
    if (badStem(stem)) return { error: "bad_stem" };
    const obj = await env.FILES.get(`${scope}articles/${stem}.json`);
    let title = stem;
    if (obj) { try { title = resolveArticles(JSON.parse(await obj.text()))[0]?.title || stem; } catch {} }
    // 破坏性：只暂存，等 DO 收到 confirm 再删。
    return { ok: true, pending: { action: "delete", stem, title } };
  }
);

// 真正删除一篇文章：文章 JSON + 其 m4a 锚点 + 常见 marker。供 DO 的 confirm 执行。
export async function deleteArticleFiles(env, scope, stem) {
  if (badStem(stem)) return;
  const keys = [
    `${scope}articles/${stem}.json`,
    `${scope}${stem}.m4a`,
    `${scope}articles/${stem}.empty`,
    `${scope}articles/${stem}.asr.json`,
    `${scope}articles/${stem}.tags`,
  ];
  for (const k of keys) { try { await env.FILES.delete(k); } catch {} }
}

register(
  { name: "tag_article",
    description: "给一篇或多篇文章打标签/归类；remove 为 true 时改为移除该标签。stems 是文章数组，tag 是标签名。",
    input_schema: { type: "object", properties: { stems: { type: "array", items: { type: "string" } }, tag: { type: "string" }, remove: { type: "boolean" } }, required: ["stems", "tag"], additionalProperties: false } },
  async ({ stems, tag, remove }, { env, scope, token, origin }) => {
    if (!Array.isArray(stems) || !stems.length || !tag) return { error: "bad_args" };
    for (const stem of stems) {
      if (badStem(stem)) return { error: "bad_stem" };
      const obj = await env.FILES.get(`${scope}articles/${stem}.json`);
      if (!obj) continue;
      let doc; try { doc = JSON.parse(await obj.text()); } catch { continue; }
      doc.tags = remove
        ? (doc.tags || []).filter((t) => t !== String(tag))
        : Array.from(new Set([...(doc.tags || []), String(tag)]));
      if (!doc.tags.length) delete doc.tags;
      // Schema-3 docs keep content in versions[head], not top-level `articles` —
      // but writeArticleDoc takes newDoc.articles as the new version's content.
      // Carry the current articles or tagging would append an empty version.
      doc.articles = resolveArticles(doc);
      const resp = await globalThis.fetch(`${origin}/files/api/articles/${stem}`, {
        method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(doc),
      });
      if (!resp.ok) return { error: `upload_failed_${resp.status}` };
    }
    return remove ? { ok: true, untagged: stems.length, tag } : { ok: true, tagged: stems.length, tag };
  }
);

// 库级（命令）agent 能用的工具：多篇读、合并、删除、重写、归类、风格。
// 刻意不含 edit_current_article / write_article / publish_wechat / share_to_community
//（那些都绑定单一 articleKey，库级命令 turn 不设 articleKey，调了会报错）。
export const COMMAND_TOOL_NAMES = [
  "list_articles", "read_article",
  "merge_articles", "delete_article", "restyle_article", "tag_article",
  "read_style", "write_style",
];
export const COMMAND_TERMINAL = new Set([
  "merge_articles", "delete_article", "restyle_article", "tag_article",
  "write_style",
]);
export function toolDefsFor(names) {
  const set = new Set(names);
  return TOOL_DEFS.filter((d) => set.has(d.name));
}
