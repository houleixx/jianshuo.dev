// src/subscription-status.js — iOS / 微信共用的、面向客户端的订阅状态。
// 只返回一个当前订阅及其到期时间；不下发支付渠道内部标识或扣费计划。
import { verifySession, anonScopeFromToken, bearerToken } from "../../functions/lib/auth.js";

const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

async function scopeFromToken(tok, env) {
  if (!tok) return null;
  if (env.SESSION_SECRET) { const s = await verifySession(tok, env.SESSION_SECRET); if (s) return s.scope; }
  return await anonScopeFromToken(tok);
}

export async function activeIapSubscription(db, userSub, now = Date.now()) {
  return await db.prepare(
    "SELECT expires_date FROM iap_sub WHERE user_sub=? AND status='active' AND expires_date>? ORDER BY expires_date DESC LIMIT 1"
  ).bind(userSub, now).first();
}

async function activeWechatSubscription(db, userSub, now) {
  return await db.prepare(
    `SELECT MAX(period_end_at) AS period_end_at FROM (
      SELECT period_end_at FROM wechat_sub WHERE user_sub=? AND status IN ('active','cancelled') AND period_end_at>?
      UNION ALL SELECT entitlement_end_at FROM wechat_txn WHERE user_sub=? AND status='paid' AND entitlement_end_at>?
    ) HAVING MAX(period_end_at) IS NOT NULL`
  ).bind(userSub, now, userSub, now).first();
}

export async function handleSubscriptionStatusRoute(url, request, env, now = Date.now()) {
  if (url.pathname !== "/agent/subscription/status" || request.method !== "GET") return null;
  const scope = await scopeFromToken(bearerToken(request), env);
  if (!scope) return J({ error: "unauthorized" }, 401);
  if (!env.USAGE) return J({ active: false, degraded: true });

  // 若极端情况下同时存在两份，Apple 优先展示；当前只返回一个状态，且不改变两边的入账。
  const apple = await activeIapSubscription(env.USAGE, scope, now);
  if (apple) return J({ active: true, provider: "apple", expires_date: apple.expires_date });
  const wechat = await activeWechatSubscription(env.USAGE, scope, now);
  if (wechat) return J({ active: true, provider: "wechat", expires_date: wechat.period_end_at });
  return J({ active: false, provider: null, expires_date: null });
}
