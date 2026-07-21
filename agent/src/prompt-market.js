// src/prompt-market.js — 提示词市场（Prompt Manager 设计定稿第 8 轮 8a 的数据端）。
//
// GET /agent/prompt-market?sort=hot|new&scope=text|image&limit=N
//   → { items: [{ code, label, appliesTo, kind?, author, importCount, createdAt }] }
//
// 2026-07-22 提示词退出社区 feed 后，这里是提示词公共曝光的唯一列表端。
// 数据源全是现存结构，零新表：
//   · D1 prompt_shares（全部铸过的码 + created_at）
//   · D1 share_stats（importCount，原子计数）
//   · R2 shares/<code>（写穿副本：label/appliesTo/kind/sub；对象在 = 分享中）
// 活码判定即 R2 get 命中——关掉的分享自然消失，与落地页/兑换同一语义。
//
// 热度分（MVP）：importCount 的时间衰减 score = (imports+1) / (ageDays+2)^1.5
// ——HN 重力公式，防老码霸榜。设计稿的留存率/好评加权等有互动数据后再迭代。
// 响应缓存 5 分钟（边缘 + 客户端），列表不需要实时。
import { verifySession, anonScopeFromToken, bearerToken } from "../../functions/lib/auth.js";
import { readProfileName } from "../../functions/lib/style-store.js";

const J = (x, status = 200, extra = {}) =>
  new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json", ...extra } });

const DAY_MS = 86400000;

function hotScore(imports, createdAtMs, now) {
  const ageDays = Math.max(0, (now - createdAtMs) / DAY_MS);
  return (imports + 1) / Math.pow(ageDays + 2, 1.5);
}

// 并发上限的 map（与 files API 的 mapLimit 同思路；agent 侧本文件私用）。
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

export async function handlePromptMarket(url, request, env) {
  if (url.pathname !== "/agent/prompt-market" || request.method !== "GET") return null;

  // 与 feed 同门槛：任意登录态（session 或 anon token）即可浏览。
  const tok = bearerToken(request);
  let scope = null;
  if (env.SESSION_SECRET) { const s = await verifySession(tok, env.SESSION_SECRET); if (s) scope = s.scope; }
  if (!scope) scope = await anonScopeFromToken(tok);
  if (!scope) return J({ error: "unauthorized" }, 401);

  const sort = url.searchParams.get("sort") === "new" ? "new" : "hot";
  const scopeFilter = url.searchParams.get("scope"); // text | image | null(全部)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 100);

  try {
    if (!env.CORE) return J({ items: [] });
    // 候选码：全部铸过的码（含已关的——下面 R2 命中过滤掉），带 importCount。
    const rows = (await env.CORE.prepare(
      "SELECT ps.code, ps.user_sub, ps.created_at, COALESCE(ss.import_count, 0) AS imports " +
      "FROM prompt_shares ps LEFT JOIN share_stats ss ON ss.code = ps.code " +
      "ORDER BY ps.created_at DESC LIMIT 500"
    ).all()).results || [];

    const now = Date.now();
    // 活码 + 内容：读写穿副本（副本在 = 分享中；label/appliesTo/kind 都在副本里）。
    const hydrated = (await mapLimit(rows, 16, async (r) => {
      try {
        const o = await env.FILES.get(`shares/${r.code}`);
        if (!o) return null; // 已关闭
        const doc = JSON.parse(await o.text());
        if (!doc || doc.type !== "prompt" || typeof doc.instruction !== "string") return null;
        const applies = Array.isArray(doc.appliesTo) && doc.appliesTo.length ? doc.appliesTo : ["text", "image"];
        if (scopeFilter && !applies.includes(scopeFilter)) return null;
        const createdMs = Date.parse(r.created_at) || 0;
        return {
          code: r.code,
          label: doc.label || "分享指令",
          appliesTo: applies,
          ...(doc.kind !== undefined ? { kind: doc.kind } : {}),
          ownerScope: r.user_sub,
          importCount: Math.max(r.imports, doc.importCount || 0),
          createdAt: r.created_at,
          _score: hotScore(Math.max(r.imports, doc.importCount || 0), createdMs, now),
          _createdMs: createdMs,
        };
      } catch { return null; }
    })).filter(Boolean);

    hydrated.sort(sort === "new" ? (a, b) => b._createdMs - a._createdMs : (a, b) => b._score - a._score);
    const top = hydrated.slice(0, limit);

    // 作者显示名（best-effort；同作者去重后再读，控制子请求）。
    const names = {};
    await mapLimit([...new Set(top.map((x) => x.ownerScope))], 8, async (s) => {
      try { names[s] = (await readProfileName(env, s, { fallback: "none" })) || ""; } catch { names[s] = ""; }
    });

    return J({
      items: top.map(({ _score, _createdMs, ownerScope, ...x }) => ({ ...x, author: names[ownerScope] || "" })),
    }, 200, { "cache-control": "public, max-age=300" });
  } catch (e) {
    console.error("[prompt-market] failed:", e && e.message);
    return J({ error: "market-failed" }, 500);
  }
}
