import { resolveScope } from "./auth.js";
import { recordEngagement, countsFor, likedBy } from "./store.js";
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
      if (!["view", "finish", "like"].includes(action)) return json({ error: "bad action" }, 400);
      if (!env.DB) return json({ ok: true });   // D1 缺失 → no-op,绝不崩
      await recordEngagement(env, shareId, scope, action, body.on, Date.now());
      return json(action === "like" ? { ok: true, liked: body.on !== false } : { ok: true });
    }

    // POST /reco/rank
    if (request.method === "POST" && parts[1] === "rank") {
      const body = await request.json().catch(() => ({}));
      const posts = Array.isArray(body.posts) ? body.posts : [];
      if (!posts.length) return json({ order: [], liked: [] });
      if (!env.DB) return json({ order: posts.map((p) => p.shareId), liked: [] }); // 回退:保持输入序
      const ids = posts.map((p) => p.shareId);
      const [engMap, likedSet] = await Promise.all([countsFor(env, ids), likedBy(env, scope, ids)]);
      return json({ order: rankPosts(posts, engMap, Date.now()), liked: [...likedSet] });
    }

    return json({ error: "not found" }, 404);
  },
};
