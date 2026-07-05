// src/prompt-lab.js — 题图 prompt 调优桥接页（jianshuo.dev/a/prompt-lab/）的后端：
// 真实文章列表 + paint.jianshuo.dev 出图代理。全部只认管理 token（Bearer FILES_TOKEN），
// 页面与 /agent 同源，无需 CORS；paint 的 API_TOKEN 留在 Worker secret 里不下发浏览器。
//
// GET  /agent/prompt-lab/articles?limit=N → { articles: [{key, title, snippet, photos, uploaded}] }
// POST /agent/prompt-lab/paint            → body {prompt, size?} 转发 paint /api/jobs，回 {job_id}
// GET  /agent/prompt-lab/paint/<jobId>    → 转发 paint 任务状态（含 result_url）
import { readArticleDoc, withTopLevelArticles } from "../../functions/lib/article-store.js";

const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

async function listArticles(env, limit) {
  const { objects } = await env.FILES.list({ prefix: "users/", limit: 1000 });
  const keys = objects
    .filter((o) => o.key.includes("/articles/") && o.key.endsWith(".json"))
    .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
    .slice(0, limit);
  const out = [];
  for (const o of keys) {
    try {
      const doc = withTopLevelArticles(await readArticleDoc(env, o.key));
      const a = (doc.articles || [])[0];
      if (!a) continue;
      const body = String(a.body || "");
      out.push({
        key: o.key,
        title: String(a.title || "(无题)"),
        snippet: body.replace(/\[\[photo:[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 120),
        body,
        photos: (body.match(/\[\[photo:[^\]]*\]\]/g) || []).length,
        uploaded: o.uploaded,
      });
    } catch { /* 单篇坏文档跳过，不拖垮列表 */ }
  }
  return out;
}

export async function handlePromptLab(request, env, url) {
  const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.FILES_TOKEN || tok !== env.FILES_TOKEN) return J({ error: "unauthorized" }, 401);

  if (url.pathname === "/agent/prompt-lab/articles" && request.method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "8", 10) || 8, 30);
    return J({ articles: await listArticles(env, limit) });
  }

  const paintBase = env.PAINT_BASE || "https://paint.jianshuo.dev";

  if (url.pathname === "/agent/prompt-lab/paint" && request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) return J({ error: "expected {prompt}" }, 400);
    const size = typeof body.size === "string" && /^\d{2,4}x\d{2,4}$/.test(body.size) ? body.size : "1536x1024";
    let resp;
    try {
      resp = await globalThis.fetch(`${paintBase}/api/jobs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.PAINT_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: body.prompt, size, format: "jpeg" }),
      });
    } catch { resp = null; }
    if (!resp || (resp.status !== 202 && resp.status !== 200)) return J({ error: "paint-unavailable", status: resp?.status || 0 }, 502);
    return J(await resp.json());
  }

  const m = url.pathname.match(/^\/agent\/prompt-lab\/paint\/([A-Za-z0-9-]+)$/);
  if (m && request.method === "GET") {
    let resp;
    try { resp = await globalThis.fetch(`${paintBase}/api/jobs/${m[1]}`, { headers: { Authorization: `Bearer ${env.PAINT_API_TOKEN}` } }); }
    catch { resp = null; }
    if (!resp) return J({ error: "paint-unavailable" }, 502);
    return J(await resp.json(), resp.status);
  }

  return J({ error: "not-found" }, 404);
}
