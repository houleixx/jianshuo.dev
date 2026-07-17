// src/iap.js — 苹果自动续期订阅（¥19.9/月 → 每月 200 算力，月清零）。
// spec: docs/superpowers/specs/2026-06-30-voicedrop-subscription-credits-design.md §8
// plan: docs/superpowers/plans/2026-07-17-voicedrop-subscription-p3p4.md
//
// 信任模型：客户端/苹果通知送来的都只当「线索」（transaction_id），入账前一律拿
// App Store Server API 回查权威交易信息——伪造的 id 在回查这步 404 死掉，
// 因此这里不做 JWS x509 链验签。
import { SUB_PRODUCTS, SUB_GRANT_SUANLI, SUB_BUCKET_GRACE_MS, suanliToUY, uyToSuanli } from "./usage.js";
import { grantBucket } from "./usage_store.js";
import { verifySession, anonScopeFromToken, bearerToken } from "../../functions/lib/auth.js";

// 与 index.js 的 resolveScope 同语义（session JWT 优先，anon token 兜底）；
// 本地实现避免 iap.js ↔ index.js 循环 import（mint.js 同款做法）。
async function scopeFromToken(tok, env) {
  if (!tok) return null;
  if (env.SESSION_SECRET) { const s = await verifySession(tok, env.SESSION_SECRET); if (s) return s.scope; }
  return await anonScopeFromToken(tok);
}

export const IAP_BUNDLE_ID = "com.wangjianshuo.VoiceDrop";
const APPLE_PROD = "https://api.storekit.itunes.apple.com";
const APPLE_SANDBOX = "https://api.storekit-sandbox.itunes.apple.com";

const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// JWS 的 payload 段 decode（不验签——见文件头的信任模型）。坏输入返回 null。
export function decodeJWSPayload(jws) {
  try {
    const part = String(jws).split(".")[1];
    const pad = part.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) {
    return null;
  }
}

// .p8 内容（PEM 或 base64(PEM)）→ WebCrypto ES256 私钥。
async function importP8(content) {
  let pem = String(content).trim();
  if (!pem.includes("-----BEGIN")) pem = atob(pem.replace(/\s+/g, ""));
  const der = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(der), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// App Store Server API 的请求 JWT（ES256）。aud 固定 appstoreconnect-v1，bid = bundleId。
export async function appleJWT(env, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = { alg: "ES256", kid: env.ASC_API_KEY_ID, typ: "JWT" };
  const payload = { iss: env.ASC_API_ISSUER_ID, iat, exp: iat + 300, aud: "appstoreconnect-v1", bid: IAP_BUNDLE_ID };
  const enc = new TextEncoder();
  const signing = b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await importP8(env.ASC_API_KEY_CONTENT);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signing));
  return signing + "." + b64url(sig);
}

const iapReady = (env) => !!(env.ASC_API_KEY_ID && env.ASC_API_ISSUER_ID && env.ASC_API_KEY_CONTENT && env.USAGE);

// 回查苹果权威交易信息：先生产、404 再 sandbox（TestFlight/沙盒交易生产端点查不到）。
// 命中 → { txn, environment }；查无 → null；苹果侧其他错误 → throw（让调用方 5xx/重试）。
export async function fetchAppleTransaction(env, transactionId, fetcher = fetch) {
  const jwt = await appleJWT(env);
  for (const base of [APPLE_PROD, APPLE_SANDBOX]) {
    const r = await fetcher(`${base}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
      headers: { Authorization: "Bearer " + jwt },
    });
    if (r.status === 404) continue;
    if (!r.ok) throw new Error("apple-api " + r.status);
    const body = await r.json();
    const txn = decodeJWSPayload(body.signedTransactionInfo);
    if (!txn) throw new Error("apple-api bad-jws");
    return { txn, environment: txn.environment || (base === APPLE_PROD ? "Production" : "Sandbox") };
  }
  return null;
}

// 一笔已回查过的权威交易 → 绑定 + 幂等入账。claim 与 ASN 通知共用这一条路。
// scope 为 null 时（通知侧无用户上下文）只认已有绑定，没绑定就跳过等客户端 claim。
export async function processTransaction(db, txn, environment, scope, now) {
  if (txn.bundleId && txn.bundleId !== IAP_BUNDLE_ID) return { ok: false, error: "wrong-bundle" };
  const grantSuanli = SUB_PRODUCTS[txn.productId];        // 档位表定发放量
  if (!grantSuanli) return { ok: false, error: "unknown-product" };
  const txnId = String(txn.transactionId);
  const origId = String(txn.originalTransactionId || txnId);
  const expiresDate = Number(txn.expiresDate) || 0;

  // 绑定：first-claim-wins。INSERT OR IGNORE 抢注，读回后不是自己 → 409。
  if (scope) {
    await db.prepare(
      "INSERT OR IGNORE INTO iap_sub (original_txn_id,user_sub,product_id,expires_date,status,updated_at) VALUES (?,?,?,?,?,?)"
    ).bind(origId, scope, txn.productId, expiresDate, "active", now).run();
  }
  const bound = await db.prepare("SELECT user_sub FROM iap_sub WHERE original_txn_id=?").bind(origId).first();
  if (!bound) return { ok: false, error: "no-binding" };           // 通知先于首次 claim 到达
  if (scope && bound.user_sub !== scope) return { ok: false, error: "bound-elsewhere" };
  const owner = bound.user_sub;

  // 幂等：同一 transaction_id 只入账一次。
  const ins = await db.prepare(
    "INSERT OR IGNORE INTO iap_txn (transaction_id,original_txn_id,user_sub,product_id,expires_date,environment,bucket_id,processed_at) VALUES (?,?,?,?,?,?,NULL,?)"
  ).bind(txnId, origId, owner, txn.productId, expiresDate, environment, now).run();
  const isNew = !!(ins && ins.meta && ins.meta.changes === 1);

  let granted = false;
  if (isNew && expiresDate > now && !txn.revocationDate) {
    // 桶到期 = 苹果周期末 + 宽限（续费空窗，spec §12.2）→ 月清零天然成立。
    await grantBucket(db, owner, suanliToUY(grantSuanli), "subscription", expiresDate + SUB_BUCKET_GRACE_MS, now,
      { txn_id: txnId, env: environment });
    const b = await db.prepare(
      "SELECT id FROM bucket WHERE user_sub=? AND source='subscription' ORDER BY id DESC LIMIT 1"
    ).bind(owner).first();
    if (b) await db.prepare("UPDATE iap_txn SET bucket_id=? WHERE transaction_id=?").bind(b.id, txnId).run();
    granted = true;
  }
  await db.prepare("UPDATE iap_sub SET product_id=?, expires_date=?, status=?, updated_at=? WHERE original_txn_id=?")
    .bind(txn.productId, expiresDate, txn.revocationDate ? "revoked" : "active", now, origId).run();
  return { ok: true, owner, granted, already: !isNew, expires_date: expiresDate, suanli: granted ? grantSuanli : 0 };
}

// 退款/撤销：该交易发的桶余量清零（已花掉的部分不追）。幂等（清零再清零无副作用）。
export async function revokeTransaction(db, transactionId, now) {
  const row = await db.prepare("SELECT bucket_id, original_txn_id FROM iap_txn WHERE transaction_id=?").bind(String(transactionId)).first();
  if (!row) return { ok: true, revoked: false };
  if (row.bucket_id != null) {
    await db.prepare("UPDATE bucket SET remaining_uy=0 WHERE id=? AND remaining_uy>0").bind(row.bucket_id).run();
  }
  await db.prepare("UPDATE iap_sub SET status='revoked', updated_at=? WHERE original_txn_id=?").bind(now, row.original_txn_id).run();
  return { ok: true, revoked: true };
}

export async function handleIapRoute(url, request, env, fetcher = fetch) {
  if (!url.pathname.startsWith("/agent/iap/")) return null;
  try {
    if (url.pathname === "/agent/iap/claim" && request.method === "POST") {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!iapReady(env)) return J({ error: "degraded" }, 503);
      const b = await request.json().catch(() => ({}));
      const txnId = b && b.transaction_id;
      if (!txnId || typeof txnId !== "string") return J({ error: "bad-request" }, 400);
      const found = await fetchAppleTransaction(env, txnId, fetcher);
      if (!found) return J({ error: "not-found" }, 404);
      const now = Date.now();
      const res = await processTransaction(env.USAGE, found.txn, found.environment, scope, now);
      if (!res.ok) return J({ error: res.error }, res.error === "bound-elsewhere" ? 409 : 400);
      return J({ ok: true, granted: res.granted, already: res.already,
        suanli: res.suanli, expires_date: res.expires_date });
    }

    // App Store Server Notifications V2。signedPayload 只 decode 取 transactionId，
    // 入账前回查苹果（伪造通知在回查处死掉）。2xx = 已消化；5xx 苹果会重试。
    if (url.pathname === "/agent/iap/notifications" && request.method === "POST") {
      if (!iapReady(env)) return J({ ok: true, skipped: "degraded" });
      const b = await request.json().catch(() => ({}));
      const payload = decodeJWSPayload(b && b.signedPayload);
      const info = payload && payload.data && decodeJWSPayload(payload.data.signedTransactionInfo);
      if (!info || !info.transactionId) return J({ ok: true, skipped: "bad-payload" });
      const type = payload.notificationType;
      const now = Date.now();
      if (type === "REFUND" || type === "REVOKE") {
        // 撤销不必回查：只对我们自己记过账的交易生效，查无此账则本来就没发过钱。
        const r = await revokeTransaction(env.USAGE, info.transactionId, now);
        return J({ ok: true, revoked: r.revoked });
      }
      const found = await fetchAppleTransaction(env, String(info.transactionId), fetcher);
      if (!found) return J({ ok: true, skipped: "not-found" });
      const res = await processTransaction(env.USAGE, found.txn, found.environment, null, now);
      return J({ ok: true, granted: !!res.granted, skipped: res.ok ? undefined : res.error });
    }

    if (url.pathname === "/agent/iap/status" && request.method === "GET") {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!env.USAGE) return J({ active: false, degraded: true });
      const now = Date.now();
      const row = await env.USAGE.prepare(
        "SELECT product_id, expires_date, status FROM iap_sub WHERE user_sub=? ORDER BY expires_date DESC LIMIT 1"
      ).bind(scope).first();
      const active = !!(row && row.status === "active" && row.expires_date > now);
      // 本月订阅桶还剩多少（App 展示「本月剩余」）
      let subRemainUY = 0;
      if (active) {
        const s = await env.USAGE.prepare(
          "SELECT COALESCE(SUM(remaining_uy),0) AS s FROM bucket WHERE user_sub=? AND source='subscription' AND (expires_at IS NULL OR expires_at > ?)"
        ).bind(scope, now).first();
        subRemainUY = s ? s.s : 0;
      }
      return J({ active, product_id: row ? row.product_id : null,
        expires_date: row ? row.expires_date : null,
        sub_suanli: Math.round(uyToSuanli(subRemainUY) * 10) / 10,
        monthly_suanli: (row && SUB_PRODUCTS[row.product_id]) || SUB_GRANT_SUANLI });
    }

    return J({ error: "not-found" }, 404);
  } catch (e) {
    return J({ error: "server-error", message: String(e && e.message || e) }, 500);
  }
}
