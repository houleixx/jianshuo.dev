// report 走默认 INSERT OR IGNORE 路径:每用户去重、一次性、不可撤销(无 on=false 分支)。
const ACTIONS = new Set(["view", "finish", "like", "report"]);

export async function recordEngagement(env, shareId, sub, action, on, now) {
  if (!ACTIONS.has(action)) return;
  if (action === "like" && on === false) {
    await env.DB.prepare(
      "DELETE FROM engagement WHERE share_id=? AND user_sub=? AND action='like'",
    ).bind(shareId, sub).run();
    return;
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO engagement (share_id, user_sub, action, created_at) VALUES (?,?,?,?)",
  ).bind(shareId, sub, action, now).run();
}

// D1(SQLite) 单条 SQL 绑定参数上限 100：社区一过 100 帖，IN (?,?,…) 一次绑
// 100+ 个参数直接 500，rank 整个挂掉（app 静默回退 → 推荐退化成时间序、卡片
// 赞数全 0）。按 90 一批分块查再合并（留出 likedBy 里 sub 那 1 个参数的余量）。
const IN_CHUNK = 90;

function chunks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(ids.slice(i, i + IN_CHUNK));
  return out;
}

export async function countsFor(env, shareIds) {
  const out = {};
  for (const ids of chunks(shareIds)) {
    const ph = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT share_id, action, COUNT(*) AS c FROM engagement WHERE share_id IN (${ph}) GROUP BY share_id, action`,
    ).bind(...ids).all();
    for (const r of results || []) {
      (out[r.share_id] ||= {})[r.action] = r.c;
    }
  }
  return out;
}

// 社区展示索引（community_posts,files API 双写维护）：feed 用的可见帖全量行,
// 时间倒序。500 封顶——超过再谈分页,现在整个社区才百余帖。
export async function feedRows(env) {
  const { results } = await env.DB.prepare(
    `SELECT share_id, owner, author, title, preview, cover_photo_key, has_photo,
            article_count, first_shared_at, updated_at, reply_to, kind
     FROM community_posts WHERE hidden=0
     ORDER BY first_shared_at DESC LIMIT 500`,
  ).all();
  return results || [];
}

export async function likedBy(env, sub, shareIds) {
  const set = new Set();
  for (const ids of chunks(shareIds)) {
    const ph = ids.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT share_id FROM engagement WHERE user_sub=? AND action='like' AND share_id IN (${ph})`,
    ).bind(sub, ...ids).all();
    for (const r of results || []) set.add(r.share_id);
  }
  return set;
}
