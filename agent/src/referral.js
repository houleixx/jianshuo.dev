// src/referral.js — 邀请奖励：新装归因（link/clipboard token 或 hello IP 指纹）+
// 双边铸币入账。事件进 mint 表 kind='referral'（subject_key = 新账号 sub，唯一索引
// (kind,subject_key,actor_sub) 天然「每账号一生一次」）；钱走 grantBucket
// （referral_author / referral_new，90 天过期）；价格与投币同池同式——
// sumCoins7d 全表无 kind 过滤 = 同一个分母，FUSE_MULT 同一条保险丝。
// 设计 spec：voicedrop repo docs/superpowers/specs/2026-07-09-referral-rewards-design.md
import { verifySession, anonScopeFromToken, bearerToken, sha256hex } from "../../functions/lib/auth.js";
import { isShareId, communityKey } from "../../functions/lib/community-store.js";
import { lookupRefhit } from "../../functions/lib/refhits.js";
import { grantBucket, ensureAccount } from "./usage_store.js";
import { deviceCheckGate, deviceCheckMark } from "./devicecheck.js";
import {
  REFERRAL_DEFAULTS, POOL_7D_UY, SEED_COINS_UC, DAILY_POOL_UY, FUSE_MULT,
  CAMPAIGN_EXPIRE_DAYS, DAY_MS, expiryAfterDays, uyToSuanli,
} from "./usage.js";

const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const r1 = (n) => Math.round(n * 10) / 10;
const no = (reason) => J({ attributed: false, reason });

export function referralQuote(sumUC, authorUC, newUC) {
  const denomUC = SEED_COINS_UC + sumUC + authorUC + newUC;
  const beneficiaryUY = Math.floor((authorUC * POOL_7D_UY) / denomUC);
  const actorUY = Math.floor((newUC * POOL_7D_UY) / denomUC);
  const priceUY = Math.floor(POOL_7D_UY / (denomUC / 1e6));
  return { denomUC, beneficiaryUY, actorUY, priceUY };
}

export async function loadReferralConfig(env) {
  try {
    const obj = await env.FILES.get("config/referral.json");
    if (obj) return { ...REFERRAL_DEFAULTS, ...JSON.parse(await obj.text()) };
  } catch (e) { console.error("[referral] bad config/referral.json:", e && e.message); }
  return { ...REFERRAL_DEFAULTS };
}

// 落地页 CTA 的实时汇率（Pages 读同一 FILES bucket，不跨服务调用）。尽力而为，失败不抛。
// 分母不含「本次」——这是给下一个访客看的现价，与结算价的微小差异被文案「约」字覆盖。
export async function publishMintRate(env, db, now) {
  try {
    const sumUC = (await db.prepare("SELECT COALESCE(SUM(coins_uc),0) AS s FROM mint WHERE ts>?")
      .bind(now - 7 * DAY_MS).first()).s;
    const priceUY = Math.floor(POOL_7D_UY / ((SEED_COINS_UC + sumUC) / 1e6));
    await env.FILES.put("config/mint-rate.json",
      JSON.stringify({ suanliPerCoin: r1(uyToSuanli(priceUY)), updatedAt: now }));
  } catch (e) { console.error("[referral] publishMintRate failed:", e && e.message); }
}

// token（分享短链 id 或邀请码）→ owner scope。shares/<id> 的值是 articleKey；
// 社区 id 读指针；邀请码读 invites/<码>（大写归一，typed JSON {owner}）。
async function ownerFromToken(env, token) {
  const id = String(token || "").trim();
  if (!/^[A-Za-z0-9_-]{6,16}$/.test(id)) return null;
  let key = null;
  const map = await env.FILES.get(`shares/${id}`);
  if (map) key = await map.text();
  else if (isShareId(id)) {
    const cm = await env.FILES.get(communityKey(id));
    if (cm) { try { key = JSON.parse(await cm.text()).articleKey || null; } catch {} }
  }
  if (!key && /^[A-Za-z0-9]{6,16}$/.test(id)) {
    const inv = await env.FILES.get(`invites/${id.toUpperCase()}`);
    if (inv) { try { const o = JSON.parse(await inv.text()).owner; if (/^users\/[^/]+\/$/.test(o)) return o; } catch {} }
  }
  const m = key && key.match(/^(users\/[^/]+\/)/);
  return m ? m[1] : null;
}

// ── 邀请码（主动「邀请好友」入口）────────────────────────────────────────────
// 码 = anon sub 的前 6 位 hex 大写（与 App 设置页显示的账户短码同源同值——一码两用）。
// 撞码（不同 owner 已占）时退到 10 位、16 位。非 anon scope 走 HMAC 派生同样稳定。
export async function inviteCodeForScope(env, scope, secret) {
  const m = scope.match(/^users\/anon-([0-9a-f]+)\/$/);
  const hex = m ? m[1] : await sha256hex(`invite:${scope}:${secret || ""}`);
  for (const len of [6, 10, 16]) {
    const code = hex.slice(0, len).toUpperCase();
    if (code.length < len) break;                       // 源串不够长，用上一档
    const cur = await env.FILES.get(`invites/${code}`);
    if (!cur) return code;
    try { if (JSON.parse(await cur.text()).owner === scope) return code; } catch { return code; }
  }
  return null;                                          // 三档全被别人占（实际不可能）
}

// GET /agent/referral/link — 铸/取自己的邀请链接。写穿 invites/<码>（owner+name，
// name 每次刷新，落地页「X 邀请你」跟着改名走）；奖励数字按现价估算（与落地页同式）。
async function handleInviteLink(request, env) {
  const tok = bearerToken(request);
  let scope = null;
  if (env.SESSION_SECRET) { const s = await verifySession(tok, env.SESSION_SECRET); if (s) scope = s.scope; }
  if (!scope) scope = await anonScopeFromToken(tok);
  if (!scope) return J({ error: "unauthorized" }, 401);

  const cfg = await loadReferralConfig(env);
  const code = await inviteCodeForScope(env, scope, env.SESSION_SECRET);
  if (!code) return J({ error: "invite-unavailable" }, 500);

  let name = "";
  try {
    const o = await env.FILES.get(`${scope}CLAUDE.json`);
    if (o) name = String(JSON.parse(await o.text())?.profile?.name || "").trim().slice(0, 20);
  } catch {}
  await env.FILES.put(`invites/${code}`, JSON.stringify({ owner: scope, name, ts: Date.now() }));

  let rate = null;
  try { const o = await env.FILES.get("config/mint-rate.json"); if (o) rate = JSON.parse(await o.text()); } catch {}
  const per = rate && rate.suanliPerCoin > 0 ? rate.suanliPerCoin : 0;
  return J({
    code,
    url: `https://voicedrop.cn/i/${code}`,
    name,
    enabled: cfg.enabled !== false,
    // 邀请人/新朋友各自「约得」的算力现价（0 = 现价不可得，客户端隐藏数字）。
    suanliInviter: per ? Math.round(cfg.authorCoins * per) : 0,
    suanliFriend: per ? Math.round(cfg.newUserCoins * per) : 0,
  });
}

export async function handleReferralRoutes(url, request, env, fetcher) {
  if (url.pathname === "/agent/referral/link" && request.method === "GET") {
    try { return await handleInviteLink(request, env); }
    catch (e) { console.error("[referral] link failed:", e && e.message); return J({ error: "invite-failed" }, 500); }
  }
  if (url.pathname !== "/agent/referral/claim" || request.method !== "POST") return null;
  if (!env.USAGE) return J({ error: "usage-unavailable" }, 503);
  try {
    // 新用户就是匿名用户：anon token 与 Apple session 都接受。
    const tok = bearerToken(request);
    let scope = null;
    if (env.SESSION_SECRET) { const s = await verifySession(tok, env.SESSION_SECRET); if (s) scope = s.scope; }
    if (!scope) scope = await anonScopeFromToken(tok);
    if (!scope) return J({ error: "unauthorized" }, 401);

    const cfg = await loadReferralConfig(env);
    if (!cfg.enabled) return no("disabled");

    const body = await request.json().catch(() => ({}));
    const now = Date.now();

    // 判新：account.created_at（服务端出生时间；首次 claim 即出生，不信客户端）。
    await ensureAccount(env.USAGE, scope, now);
    const acct = await env.USAGE.prepare("SELECT created_at FROM account WHERE user_sub=?").bind(scope).first();
    if (!acct || now - acct.created_at > DAY_MS) return no("not-new");

    // 已归因过 → 幂等返回（不看 source，first-touch 终身封笔）。
    const prior = await env.USAGE.prepare(
      "SELECT id FROM mint WHERE kind='referral' AND subject_key=?").bind(scope).first();
    if (prior) return J({ attributed: true, already: true });

    // 归因：token（link/clipboard）优先，否则 hello 走 IP 指纹（唯一 owner 才算）。
    let owner = null, via = String(body.source || "hello");
    if (body.token) owner = await ownerFromToken(env, body.token);
    if (!owner) {
      const ip = request.headers.get("CF-Connecting-IP");
      const hit = env.SESSION_SECRET ? await lookupRefhit(env, ip, env.SESSION_SECRET, now) : null;
      if (hit) { owner = hit.owner; via = "hello"; }
    }
    if (!owner) return no("no-match");
    if (owner === scope) return no("self");

    // DeviceCheck（防删除重装刷币）。require 时拿不到明确「未用过」一律拒。
    if (cfg.requireDeviceCheck) {
      const dc = await deviceCheckGate(env, body.deviceCheckToken, fetcher);
      if (dc === "used") return no("device-used");
      if (dc === "unavailable") return no("device-unavailable");
    }

    // 当日保险丝（与投币同一条线，对抗性超发止损）。
    const day0 = now - (now % DAY_MS);
    const paidToday = (await env.USAGE.prepare(
      "SELECT COALESCE(SUM(actor_uy+beneficiary_uy),0) AS s FROM mint WHERE ts>=?").bind(day0).first()).s;
    if (paidToday > FUSE_MULT * DAILY_POOL_UY) return no("pool_exhausted");

    // owner 日封顶：超出只发新人侧（对新人公平，作者侧归零防批量刷）。
    const ownerToday = (await env.USAGE.prepare(
      "SELECT COUNT(*) AS n FROM mint WHERE kind='referral' AND beneficiary_sub=? AND ts>=?"
    ).bind(owner, day0).first()).n;
    const capped = ownerToday >= cfg.dailyCapPerOwner;

    const authorUC = capped ? 0 : Math.round(cfg.authorCoins * 1e6);
    const newUC = Math.round(cfg.newUserCoins * 1e6);
    const sumUC = (await env.USAGE.prepare(
      "SELECT COALESCE(SUM(coins_uc),0) AS s FROM mint WHERE ts>?").bind(now - 7 * DAY_MS).first()).s;
    const q = referralQuote(sumUC, authorUC, newUC);

    // 先抢唯一键，成功才付钱（mint.js 同约定：连点/并发绝无重复付款）。
    const ins = await env.USAGE.prepare(
      "INSERT OR IGNORE INTO mint (kind,subject_key,share_id,actor_sub,beneficiary_sub,coins_uc,price_uy,actor_uy,beneficiary_uy,detail,ts) " +
      "VALUES ('referral',?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      scope, body.token ? String(body.token).slice(0, 16) : null, scope, owner,
      authorUC + newUC, q.priceUY, q.actorUY, q.beneficiaryUY,
      JSON.stringify({ via, ...(capped ? { capped: true } : {}) }), now,
    ).run();
    if (!ins.meta || ins.meta.changes !== 1) return J({ attributed: true, already: true });
    const refId = ins.meta.last_row_id;

    const exp = expiryAfterDays(now, CAMPAIGN_EXPIRE_DAYS);
    if (q.beneficiaryUY > 0)
      await grantBucket(env.USAGE, owner, q.beneficiaryUY, "referral_author", exp, now, { ref_id: refId, via });
    if (q.actorUY > 0)
      await grantBucket(env.USAGE, scope, q.actorUY, "referral_new", exp, now, { ref_id: refId, via });

    if (cfg.requireDeviceCheck) await deviceCheckMark(env, body.deviceCheckToken, fetcher);
    await publishMintRate(env, env.USAGE, now);

    return J({
      attributed: true,
      suanli: { you: r1(uyToSuanli(q.actorUY)), author: r1(uyToSuanli(q.beneficiaryUY)) },
    });
  } catch (e) {
    console.error("[referral] claim failed:", e && e.message);
    return J({ error: "referral-failed" }, 500);
  }
}
