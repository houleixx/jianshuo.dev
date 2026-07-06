// src/mint.js — 铸币事件（投币等挣币玩法）：mint 表之上的 /agent/feed 接口。
//
// 分工（设计定稿 2026-07-06）：
//   • mint 表是「事件」的唯一真源：唯一键 = 一人一篇只能投一次（幂等）、
//     近 7 天 SUM(coins_uc) = 价格分母、当日发放合计 = 保险丝、同对次数 = 递减。
//     表里的金额列只是审计快照，不参与余额。
//   • 「钱」的唯一真源仍是 bucket/ledger：到账走 grantBucket（自动出现在账单页），
//     ledger.detail 带 feed_id 与 mint 行互相对账。
//   • 价格滞后于总量、支付即时发生：POOL_7D ÷ (70 币永久底座 + 近7天铸币 + 本次)。
//     底座不滑窗 → 价格永远 ≤ 200 算力/币，冷启动不发散，无需任何结算定时任务。
//   • 投币需 Apple 实名 session（sess.apple）；匿名 token 返回 needs_apple_signin
//     （与社区分享 write gate 同一约定，App 已会弹 Apple 登录再重试）。
//   • 写入顺序定死：先 INSERT OR IGNORE 抢唯一键，成功才付钱 → 连点/重试/并发
//     绝无重复付款。极小概率「事件已记、grant 前崩」= 少付一笔，可由
//     ledger.detail.feed_id 对账补发（与 grantBucket 既有 known-limitation 同级）。

import { verifySession, anonScopeFromToken } from "../../functions/lib/auth.js";
import { resolveArticles } from "../../functions/lib/article-store.js";
import { readProfileName } from "../../functions/lib/style-store.js";
import { grantBucket } from "./usage_store.js";
import {
  POOL_7D_UY, DAILY_POOL_UY, SEED_COINS_UC, FEED_AUTHOR_UC, FEED_FEEDER_UC,
  FEED_GRANT_EXPIRE_DAYS, FUSE_MULT, pairDiscount, ucToCoins, uyToSuanli,
  DAY_MS, expiryAfterDays,
} from "./usage.js";

const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const r1 = (n) => Math.round(n * 10) / 10;

// 报价（纯函数，可测）：sumUC = 近 7 天已铸微金币，priorPair = 该投币者对该作者的已投次数。
// 分母含本次铸币（轻微保守，也顺带永不除零）。
export function feedQuote(sumUC, priorPair) {
  const disc = pairDiscount(priorPair);
  const authorUC = Math.round(FEED_AUTHOR_UC * disc);
  const feederUC = Math.round(FEED_FEEDER_UC * disc);
  const denomUC = SEED_COINS_UC + sumUC + authorUC + feederUC;
  const beneficiaryUY = Math.floor((authorUC * POOL_7D_UY) / denomUC);
  const actorUY = Math.floor((feederUC * POOL_7D_UY) / denomUC);
  const priceUY = Math.floor(POOL_7D_UY / (denomUC / 1e6)); // 微元/整币，审计快照
  return { disc, authorUC, feederUC, denomUC, beneficiaryUY, actorUY, priceUY };
}

async function sumCoins7d(db, now) {
  const row = await db.prepare(
    "SELECT COALESCE(SUM(coins_uc),0) AS s FROM mint WHERE ts>?"
  ).bind(now - 7 * DAY_MS).first();
  return row.s;
}

export async function handleMintRoutes(url, request, env) {
  if (url.pathname !== "/agent/feed" && url.pathname !== "/agent/feed/state") return null;
  if (!env.USAGE) return J({ error: "usage-unavailable" }, 503);
  const tok = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  try {

  // ── POST /agent/feed {share_id} ── 投币：铸币 + 双边即时到账 ─────────────
  if (url.pathname === "/agent/feed" && request.method === "POST") {
    const sess = env.SESSION_SECRET ? await verifySession(tok, env.SESSION_SECRET) : null;
    if (!sess || !sess.scope) {
      // 匿名 token 是有效身份但投币要实名 → 明确引导 Apple 登录而不是笼统 401
      if (await anonScopeFromToken(tok)) return J({ error: "needs_apple_signin" }, 403);
      return J({ error: "unauthorized" }, 401);
    }
    if (!sess.apple) return J({ error: "needs_apple_signin" }, 403);
    const feeder = sess.scope;

    const body = await request.json().catch(() => ({}));
    const shareId = String(body.share_id || "");
    if (!/^[A-Za-z0-9_-]{12}$/.test(shareId)) return J({ error: "bad share_id" }, 400);
    const postObj = await env.FILES.get(`community/${shareId}.json`);
    if (!postObj) return J({ error: "share not found" }, 404);
    let post; try { post = JSON.parse(await postObj.text()); } catch { return J({ error: "bad share" }, 500); }
    if (!post.owner || !post.articleKey) return J({ error: "not feedable" }, 400); // legacy schema-1
    if (post.owner === feeder) return J({ error: "cannot_feed_own" }, 400);
    // 读活文章（存在性检查 + 标题快照进账单明细，让「收到投币/投币奖励」看得出是哪篇）
    const artObj = await env.FILES.get(post.articleKey);
    if (!artObj) return J({ error: "article gone" }, 404);
    let title = "";
    try { title = (resolveArticles(JSON.parse(await artObj.text()))[0] || {}).title || ""; } catch {}
    const authorName = post.author || "匿名";
    const feederName = (await readProfileName(env, feeder + "CLAUDE.json", feeder + "CLAUDE.md").catch(() => "")) || "匿名";

    const now = Date.now();
    // 保险丝：当日(UTC)已发放超 5×日池 → 暂停投币。有机流量摸不到这条线，
    // 只在被规模化刷的那天止损（详见对话定稿：接受有机超发，熔断对抗性超发）。
    const day0 = now - (now % DAY_MS);
    const paidToday = (await env.USAGE.prepare(
      "SELECT COALESCE(SUM(actor_uy+beneficiary_uy),0) AS s FROM mint WHERE ts>=?"
    ).bind(day0).first()).s;
    if (paidToday > FUSE_MULT * DAILY_POOL_UY) {
      console.error(`[mint] FUSE BLOWN: today paid ${paidToday}uy > ${FUSE_MULT}×${DAILY_POOL_UY}uy — feeds paused`);
      return J({ error: "pool_exhausted" }, 503);
    }

    const sumUC = await sumCoins7d(env.USAGE, now);
    const prior = (await env.USAGE.prepare(
      "SELECT COUNT(*) AS n FROM mint WHERE kind='feed' AND actor_sub=? AND beneficiary_sub=?"
    ).bind(feeder, post.owner).first()).n;
    const q = feedQuote(sumUC, prior);

    // 先抢唯一键，成功才付钱（见文件头「写入顺序定死」）。
    const ins = await env.USAGE.prepare(
      "INSERT OR IGNORE INTO mint (kind,subject_key,share_id,actor_sub,beneficiary_sub,coins_uc,price_uy,actor_uy,beneficiary_uy,detail,ts) " +
      "VALUES ('feed',?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      post.articleKey, shareId, feeder, post.owner,
      q.authorUC + q.feederUC, q.priceUY, q.actorUY, q.beneficiaryUY,
      JSON.stringify({ ...(q.disc < 1 ? { disc: q.disc } : {}), title }), now,
    ).run();
    if (!ins.meta || ins.meta.changes !== 1) return J({ ok: true, already: true });
    const feedId = ins.meta.last_row_id;

    const exp = expiryAfterDays(now, FEED_GRANT_EXPIRE_DAYS);
    // 账单明细快照：作者那笔看得到「哪篇 + 谁投的」，投币者那笔看得到「哪篇 + 作者是谁」
    await grantBucket(env.USAGE, post.owner, q.beneficiaryUY, "feed_author", exp, now,
      { feed_id: feedId, share_id: shareId, title, from: feederName });
    await grantBucket(env.USAGE, feeder, q.actorUY, "feed_curator", exp, now,
      { feed_id: feedId, share_id: shareId, title, author: authorName });

    return J({
      ok: true,
      coins: { author: ucToCoins(q.authorUC), feeder: ucToCoins(q.feederUC) },
      suanli: { author: r1(uyToSuanli(q.beneficiaryUY)), feeder: r1(uyToSuanli(q.actorUY)) },
      price_suanli_per_coin: r1(uyToSuanli(q.priceUY)),
      ...(q.disc < 1 ? { discount: q.disc } : {}),
    });
  }

  // ── POST /agent/feed/state {share_ids:[...]} ── 批量点亮态 + 计数 ─────────
  // 任意有效 token（匿名也行——Apple session 的 scope 本就是 anon 派生的同一个，
  // 见 reco/wrangler.jsonc 的说明，所以 fed 判定两种 token 都正确）。
  if (url.pathname === "/agent/feed/state" && request.method === "POST") {
    let scope = null;
    if (env.SESSION_SECRET) { const s = await verifySession(tok, env.SESSION_SECRET); if (s) scope = s.scope; }
    if (!scope) scope = await anonScopeFromToken(tok);
    if (!scope) return J({ error: "unauthorized" }, 401);

    const body = await request.json().catch(() => ({}));
    const ids = (Array.isArray(body.share_ids) ? body.share_ids : [])
      .map(String).filter((s) => /^[A-Za-z0-9_-]{12}$/.test(s)).slice(0, 200);
    const states = {};
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      const { results } = await env.USAGE.prepare(
        `SELECT share_id, COUNT(*) AS n, MAX(actor_sub = ?) AS fed FROM mint ` +
        `WHERE kind='feed' AND share_id IN (${ph}) GROUP BY share_id`
      ).bind(scope, ...ids).all();
      for (const r of results || []) states[r.share_id] = { count: r.n, fed: !!r.fed };
    }
    for (const id of ids) if (!states[id]) states[id] = { count: 0, fed: false };

    const q = feedQuote(await sumCoins7d(env.USAGE, Date.now()), 0);
    return J({ states, price_suanli_per_coin: r1(uyToSuanli(q.priceUY)) });
  }

  return J({ error: "not-found" }, 404);
  } catch (e) {
    console.error("[mint] route failed:", e && e.message);
    return J({ error: "mint-failed" }, 500);
  }
}
