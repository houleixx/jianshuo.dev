const ACTIONS = new Set(["view", "finish", "like"]);

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

export async function countsFor(env, shareIds) {
  const out = {};
  if (!shareIds.length) return out;
  const ph = shareIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT share_id, action, COUNT(*) AS c FROM engagement WHERE share_id IN (${ph}) GROUP BY share_id, action`,
  ).bind(...shareIds).all();
  for (const r of results || []) {
    (out[r.share_id] ||= {})[r.action] = r.c;
  }
  return out;
}

export async function likedBy(env, sub, shareIds) {
  const set = new Set();
  if (!shareIds.length) return set;
  const ph = shareIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT share_id FROM engagement WHERE user_sub=? AND action='like' AND share_id IN (${ph})`,
  ).bind(sub, ...shareIds).all();
  for (const r of results || []) set.add(r.share_id);
  return set;
}
