// VoiceDrop agent tools — general primitives the article-editing agent composes.
// Each handler takes (args, ctx) where ctx = {env, scope, articleKey, token, origin}.

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
      const title = (doc.articles && doc.articles[0] && doc.articles[0].title) || "(无题)";
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
    const articles = Array.isArray(doc.articles) ? doc.articles.map((a) => ({ title: a.title, body: a.body })) : [];
    return { transcript: doc.transcript || "", articles };
  }
);

register(
  { name: "write_article", description: "把改写后的全部文章写回当前正在编辑的这一篇（只能写当前篇）。输入是完整的文章数组。", input_schema: { type: "object", properties: { articles: { type: "array", items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"], additionalProperties: false } } }, required: ["articles"], additionalProperties: false } },
  async ({ articles }, { env, articleKey }) => {
    if (!Array.isArray(articles) || !articles.length) return { error: "empty_articles" };
    const obj = await env.FILES.get(articleKey);
    if (!obj) return { error: "not_found" };
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
    const prev = Array.isArray(doc.articles) ? doc.articles : [];
    doc.articles = articles.map((a, i) => {
      const out = { title: String(a.title || "(无题)"), body: String(a.body || "") };
      if (prev[i] && prev[i].wechatMediaId) out.wechatMediaId = prev[i].wechatMediaId;
      return out;
    });
    delete doc.title; delete doc.body; // collapse any v1 remnants
    await env.FILES.put(articleKey, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
    return { ok: true, count: doc.articles.length };
  }
);

register(
  { name: "read_style", description: "读取用户的写作文风（CLAUDE.md 的内容）。调整文风前先读出来。", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  async (_args, { env, scope }) => {
    const obj = await env.FILES.get(scope + "CLAUDE.md");
    return { style: obj ? (await obj.text()) : "" };
  }
);

register(
  { name: "write_style", description: "整体覆盖写用户的写作文风（CLAUDE.md）。先 read_style 读出当前内容，改完再整体写回。影响以后所有挖矿和编辑。", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false } },
  async ({ content }, { env, scope }) => {
    if (!content || !String(content).trim()) return { error: "empty_content" };
    await env.FILES.put(scope + "CLAUDE.md", String(content), { httpMetadata: { contentType: "text/markdown" } });
    return { ok: true };
  }
);
