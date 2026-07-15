import { resolveScope } from "./auth.js";
import { recordEngagement, countsFor, likedBy, feedRows } from "./store.js";
import { rankPosts } from "./ranking.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

const ID_RE = /^[0-9A-Za-z_-]{1,32}$/;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ['reco','engage','<id>'] | ['reco','rank']
    if (parts[0] !== "reco") return json({ error: "not found" }, 404);

    const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const scope = await resolveScope(token, env.SESSION_SECRET);
    if (!scope) return json({ error: "unauthorized" }, 401);

    // POST /reco/engage/<shareId>
    if (request.method === "POST" && parts[1] === "engage" && parts[2]) {
      const shareId = parts[2];
      if (!ID_RE.test(shareId)) return json({ error: "bad id" }, 400);
      const body = await request.json().catch(() => ({}));
      const action = body.action;
      if (!["view", "finish", "like", "report"].includes(action)) return json({ error: "bad action" }, 400);
      if (!env.DB) return json({ ok: true });   // D1 缺失 → no-op,绝不崩
      await recordEngagement(env, shareId, scope, action, body.on, Date.now());
      return json(action === "like" ? { ok: true, liked: body.on !== false } : { ok: true });
    }

    // GET /reco/feed — 社区列表页的合一后台（2026-07-14）：D1 展示索引一次带回
    // 列表元数据 + 推荐序 + 每帖红心/回应数 + 我赞过的。app 的 load+rank+赞数
    // 三步并成这一步；R2 真源的 community/list 保留给老版本 app 与重建兜底。
    if (request.method === "GET" && parts[1] === "feed") {
      if (!env.DB) return json({ error: "feed unavailable" }, 503);
      const rows = await feedRows(env);
      const ids = rows.map((r) => r.share_id);
      const replyCounts = {};
      for (const r of rows) if (r.reply_to) replyCounts[r.reply_to] = (replyCounts[r.reply_to] || 0) + 1;
      const [engMap, likedSet] = await Promise.all([countsFor(env, ids), likedBy(env, scope, ids)]);
      const posts = rows.map((r) => ({
        shareId: r.share_id, author: r.author, title: r.title,
        ...(r.preview ? { preview: r.preview } : {}),
        ...(r.cover_photo_key ? { coverPhotoKey: r.cover_photo_key } : {}),
        hasPhoto: !!r.has_photo, count: r.article_count,
        firstSharedAt: r.first_shared_at, updatedAt: r.updated_at || r.first_shared_at,
        ...(r.reply_to ? { replyTo: r.reply_to } : {}),
        mine: r.owner === scope,
        likes: (engMap[r.share_id] || {}).like || 0,
        replies: replyCounts[r.share_id] || 0,
        liked: likedSet.has(r.share_id),
        kind: r.kind || "article",
      }));
      const order = rankPosts(
        rows.map((r) => ({ shareId: r.share_id, firstSharedAt: r.first_shared_at,
                           author: r.author, replyCount: replyCounts[r.share_id] || 0 })),
        engMap, Date.now());
      return json({ posts, order });
    }

    // POST /reco/rank
    // likes = 每帖被赞数（shareId → n，0 不下发）——瀑布流卡片的红心数从这里来，
    // 顺路从已经算好的 engMap 里取，不多一次查询。
    if (request.method === "POST" && parts[1] === "rank") {
      const body = await request.json().catch(() => ({}));
      const posts = Array.isArray(body.posts) ? body.posts : [];
      if (!posts.length) return json({ order: [], liked: [], likes: {} });
      if (!env.DB) return json({ order: posts.map((p) => p.shareId), liked: [], likes: {} }); // 回退:保持输入序
      const ids = posts.map((p) => p.shareId);
      const [engMap, likedSet] = await Promise.all([countsFor(env, ids), likedBy(env, scope, ids)]);
      const likes = {};
      for (const [id, eng] of Object.entries(engMap)) if (eng.like) likes[id] = eng.like;
      return json({ order: rankPosts(posts, engMap, Date.now()), liked: [...likedSet], likes });
    }

    return json({ error: "not found" }, 404);
  },
};
