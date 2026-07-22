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
// 【物化缓存（2026-07-23 提速）】现算一次要「D1 500 行 + 每行一次 R2 GET + 逐作者
// 读名」，实测 TTFB 3-5 秒；带 Authorization 的请求边缘也不缓存，等于每个用户每次
// 打开都全额付费。改成：完整 hydrated 列表物化在 R2 `market/prompt-market-cache.json`
// 一个对象里，请求只读它（一次 R2 GET），排序/筛选/截断在内存做；超过 TTL 用
// ctx.waitUntil 后台重建、本次照样先回旧数据（stale-while-revalidate）。没有缓存
// （首次/被删）才内联现算。列表本就接受 5 分钟延迟（老实现的 cache-control 就是
// 300s），语义没有收紧。
//
// 热度分（MVP）：importCount 的时间衰减 score = (imports+1) / (ageDays+2)^1.5
// ——HN 重力公式，防老码霸榜。分数在【服务时】按当前时刻现算（缓存只存
// imports/createdMs），时间衰减不吃缓存年龄的偏差。
import { verifySession, anonScopeFromToken, bearerToken } from "../../functions/lib/auth.js";
import { readProfileName } from "../../functions/lib/style-store.js";

const J = (x, status = 200, extra = {}) =>
  new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json", ...extra } });

const DAY_MS = 86400000;
const CACHE_KEY = "market/prompt-market-cache.json";
const CACHE_TTL_MS = 5 * 60 * 1000;

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

/// 全量重建：老实现的现算逻辑原样搬入，只是不再做 scope/limit/排序（那些在服务时
/// 按缓存内存做），并把作者名一并算好存进缓存。返回缓存文档 {builtAt, items}。
async function computeMarket(env) {
  // 候选码：全部铸过的码（含已关的——下面 R2 命中过滤掉），带 importCount。
  // borrowed 行是导入件的转发状态不是作品——同码的作品行在原作者名下，
  // 不排除会同码重复展示（spec 2026-07-22 溯源转发 §6）。
  const marketSql = (withBorrowed) =>
    "SELECT ps.code, ps.user_sub, ps.created_at, COALESCE(ss.import_count, 0) AS imports " +
    "FROM prompt_shares ps LEFT JOIN share_stats ss ON ss.code = ps.code " +
    (withBorrowed ? "WHERE ps.borrowed = 0 " : "") +
    "ORDER BY ps.created_at DESC LIMIT 500";
  let rowsRes;
  try {
    rowsRes = await env.CORE.prepare(marketSql(true)).all();
  } catch (e) {
    // borrowed 列不存在（回滚 Worker 之外单独缺了 migration 0004 的环境）——
    // 退回老 SQL 保端点可用，代价只是 borrowed 行短暂重复展示，好过全员 500。
    if (!/no such column|has no column named/i.test((e && e.message) || "")) throw e;
    rowsRes = await env.CORE.prepare(marketSql(false)).all();
  }
  const rows = rowsRes.results || [];

  // 活码 + 内容：读写穿副本（副本在 = 分享中；label/appliesTo/kind 都在副本里）。
  const hydrated = (await mapLimit(rows, 16, async (r) => {
    try {
      const o = await env.FILES.get(`shares/${r.code}`);
      if (!o) return null; // 已关闭
      const doc = JSON.parse(await o.text());
      if (!doc || doc.type !== "prompt" || typeof doc.instruction !== "string") return null;
      return {
        code: r.code,
        label: doc.label || "分享指令",
        appliesTo: Array.isArray(doc.appliesTo) && doc.appliesTo.length ? doc.appliesTo : ["text", "image"],
        ...(doc.kind !== undefined ? { kind: doc.kind } : {}),
        ownerScope: r.user_sub,
        importCount: Math.max(r.imports, doc.importCount || 0),
        createdAt: r.created_at,
        createdMs: Date.parse(r.created_at) || 0,
      };
    } catch { return null; }
  })).filter(Boolean);

  // 作者显示名（best-effort；同作者去重后再读，控制子请求）——build 时算好入缓存。
  const names = {};
  await mapLimit([...new Set(hydrated.map((x) => x.ownerScope))], 8, async (s) => {
    try { names[s] = (await readProfileName(env, s, { fallback: "none" })) || ""; } catch { names[s] = ""; }
  });
  for (const x of hydrated) { x.author = names[x.ownerScope] || ""; delete x.ownerScope; }

  return { builtAt: Date.now(), items: hydrated };
}

async function computeAndStore(env) {
  const doc = await computeMarket(env);
  try { await env.FILES.put(CACHE_KEY, JSON.stringify(doc)); } catch (e) { console.error("[prompt-market] cache write failed:", e && e.message); }
  return doc;
}

export async function handlePromptMarket(url, request, env, ctx) {
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

    // 缓存读取 → 过期后台刷 → 没有才内联算。
    let cache = null;
    try {
      const o = await env.FILES.get(CACHE_KEY);
      if (o) {
        const doc = JSON.parse(await o.text());
        if (doc && Array.isArray(doc.items) && typeof doc.builtAt === "number") cache = doc;
      }
    } catch { /* 坏缓存当没有 */ }
    if (!cache || Date.now() - cache.builtAt >= CACHE_TTL_MS) {
      if (cache && ctx && typeof ctx.waitUntil === "function") {
        // 有旧数据：先回旧的，后台重建（用户不等）。重建失败只是继续陈旧，不打断服务。
        ctx.waitUntil(computeAndStore(env).catch((e) => console.error("[prompt-market] refresh failed:", e && e.message)));
      } else {
        cache = await computeAndStore(env);
      }
    }

    const now = Date.now();
    const filtered = cache.items.filter((x) => !scopeFilter || (x.appliesTo || []).includes(scopeFilter));
    filtered.sort(sort === "new"
      ? (a, b) => (b.createdMs || 0) - (a.createdMs || 0)
      : (a, b) => hotScore(b.importCount, b.createdMs || 0, now) - hotScore(a.importCount, a.createdMs || 0, now));
    return J({
      items: filtered.slice(0, limit).map(({ createdMs, ...x }) => x),
    }, 200, { "cache-control": "public, max-age=300" });
  } catch (e) {
    console.error("[prompt-market] failed:", e && e.message);
    return J({ error: "market-failed" }, 500);
  }
}

/// 分享开/关时让缓存立即过期（prompt-share.js 调用，best-effort）：删缓存对象，
/// 下一个请求内联重建。不删也只是最长陈旧 5 分钟，删了体验更跟手。
export async function invalidateMarketCache(env) {
  try { await env.FILES.delete(CACHE_KEY); } catch { /* best-effort */ }
}
