// src/wechat-pay.js — V3 APP 首期支付并签约、支付查单与算力入账。
//
// 跟 iap.js 一样：支付渠道自己的表只保存「协议 / 订单」；实际算力一律走
// bucket + ledger。已验签的成功回调和查单结果共用原子入账入口，重复回调与 Cron 重试
// 都以用户周期为幂等键；未确认的订单始终复用同一商户订单号。
import { createHash } from "node:crypto";
import { wechatV3Ready, wechatV3Request, wechatV3AppPayParams, decryptWechatV3Notification } from "./wechat-v3.js";
import { SUB_GRANT_SUANLI, suanliToUY, uyToSuanli } from "./usage.js";
import { ensureAccount } from "./usage_store.js";
import { activeIapSubscription } from "./subscription-status.js";
import {
  verifySession,
  anonScopeFromToken,
  bearerToken,
} from "../../functions/lib/auth.js";

const QUERY_INTERVAL = 15 * 60 * 1000;
const WECHAT_PAY_CONFIG_KEY = "config/wechat-pay.json";
const J = (x, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { "content-type": "application/json" },
  });
async function scopeFromToken(tok, env) {
  if (!tok) return null;
  if (env.SESSION_SECRET) {
    const s = await verifySession(tok, env.SESSION_SECRET);
    if (s) return s.scope;
  }
  return await anonScopeFromToken(tok);
}

// JS setUTCMonth() 在 1 月 31 日加一个月会溢出到 3 月；这里固定日号到目标月最后一天，
// 所以「按自然月」在所有月末都正确。周期端点统一存 UTC epoch，不受 Worker 所在地区影响。
export function addCalendarMonth(at) {
  const d = new Date(Number(at));
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = month % 12;
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  return Date.UTC(
    targetYear,
    targetMonth,
    Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

function amountFen(env) {
  const n = Number(env.WECHAT_PAY_AMOUNT_FEN ?? 1990);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function ready(env) {
  return !!(
    env.USAGE &&
    env.WECHAT_PAY_MCH_ID &&
    env.WECHAT_PAY_APP_ID &&
    env.WECHAT_PAY_PLAN_ID &&
    wechatV3Ready(env) &&
    env.WECHAT_PAY_CALLBACK_BASE_URL &&
    amountFen(env)
  );
}

// 首次访问时把售卖开关初始化为开启，之后由 R2 中的显式 true/false 控制。R2 读、写或
// 解析异常时仍默认开启，避免临时存储故障把客户端订阅入口误关掉。它仅阻止新签约，
// 不影响已有订单的支付回调和状态查询。
export async function wechatPayEnabled(env) {
  try {
    const obj = env.FILES && (await env.FILES.get(WECHAT_PAY_CONFIG_KEY));
    if (obj) return JSON.parse(await obj.text()).enabled === true;
    if (env.FILES && typeof env.FILES.put === "function") {
      await env.FILES.put(
        WECHAT_PAY_CONFIG_KEY,
        JSON.stringify({ enabled: true }),
        {
          httpMetadata: { contentType: "application/json" },
        },
      );
    }
  } catch (e) {
    console.error(
      "[wechat-pay] config/wechat-pay.json unavailable; default enabled:",
      e && e.message,
    );
  }
  return true;
}

function publicOrigin(env, url) {
  return String(env.WECHAT_PAY_CALLBACK_BASE_URL).replace(/\/$/, "");
}

// 审计记录不保存可复用的签名/随机串；其余微信字段保留，才能把商户订单、微信订单、
// 协议状态与某一次 Cron/回调串起来排错。日志写入失败绝不能阻断真实支付流程。
function auditPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const copy = { ...payload };
  for (const k of [
    "sign",
    "nonce_str",
    "api_key",
    "key",
    "prepay_id",
    "pay_params",
  ]) {
    if (k in copy) copy[k] = "[redacted]";
  }
  return JSON.stringify(copy).slice(0, 16_000);
}

async function audit(db, event) {
  try {
    await db
      .prepare(
        "INSERT INTO wechat_event (contract_code,out_trade_no,user_sub,direction,event_type,status_before,status_after,wechat_txn_id,code,message,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .bind(
        event.contract_code || null,
        event.out_trade_no || null,
        event.user_sub || null,
        event.direction || "internal",
        event.event_type,
        event.status_before || null,
        event.status_after || null,
        event.wechat_txn_id || null,
        event.code || null,
        event.message ? String(event.message).slice(0, 512) : null,
        auditPayload(event.payload),
        event.now,
      )
      .run();
  } catch (e) {
    console.log("[wechat-pay] audit failed", String((e && e.message) || e));
  }
}

function tradeNo(contractCode, periodStart) {
  // 微信商户订单号最多 32 字符。输入稳定，重跑 Cron / 网络重试一定还是同一订单号。
  return (
    "wd" + createHash("md5").update(`${contractCode}:${periodStart}`).digest("hex").slice(0, 30)
  );
}

function contractCode(now, random = null) {
  const r = random || (() => crypto.getRandomValues(new Uint32Array(2)));
  const a = r();
  const n =
    Array.isArray(a) || ArrayBuffer.isView(a)
      ? Array.from(a)
          .map((x) => Number(x).toString(36))
          .join("")
      : Number(a).toString(36);
  return `wdc${Number(now).toString(36)}${n}`.slice(0, 64);
}

function requestSerial(now) {
  // 13 位毫秒时间 + 5 位随机数，始终是非零、未超 int64 上限的纯数字。
  const random = crypto.getRandomValues(new Uint32Array(1))[0] % 100000;
  return `${Math.floor(Number(now))}${String(random).padStart(5, "0")}`;
}

async function unresolvedUserOrder(db, userSub) {
  return db
    .prepare(
      `SELECT a.out_trade_no FROM wechat_attempt a JOIN wechat_txn t ON t.out_trade_no=a.cycle_no WHERE t.user_sub=? AND a.status IN ('sending','unknown','accepted','refunded') LIMIT 1`,
    )
    .bind(userSub)
    .first();
}

async function settlePayment(db, txn, values, now) {
  const attempt = await db
    .prepare("SELECT * FROM wechat_attempt WHERE out_trade_no=?")
    .bind(values.out_trade_no)
    .first();
  if (!attempt || attempt.cycle_no !== txn.out_trade_no)
    throw new Error("unknown-payment-attempt");
  if (
    !values.transaction_id ||
    Number(values.amount.total) !== Number(txn.amount_fen)
  )
    throw new Error("payment-mismatch");
  if (txn.status === "paid") return { ok: true, already: true };
  const paidAt = Date.parse(values.success_time);
  if (!Number.isFinite(paidAt) || paidAt > now + 5 * 60 * 1000) throw new Error('invalid-payment-time');
  // Early renewals keep their future boundary. A genuinely late first/recovery payment buys a full month from payment time.
  const start = Math.max(txn.period_start_at, paidAt);
  const end =
    start === txn.period_start_at ? txn.period_end_at : addCalendarMonth(start);
  const amount = suanliToUY(SUB_GRANT_SUANLI);
  await ensureAccount(db, txn.user_sub, now);
  const detail = JSON.stringify({
    provider: "wechat",
    out_trade_no: txn.out_trade_no,
    merchant_order: values.out_trade_no,
    transaction_id: values.transaction_id,
  });
  const missingLedger =
    "NOT EXISTS(SELECT 1 FROM ledger WHERE reason='subscription' AND json_extract(detail,'$.provider')='wechat' AND json_extract(detail,'$.out_trade_no')=?)";
  // D1 batch is atomic: bucket, ledger, account, order and subscription either all commit or all roll back.
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO bucket(user_sub,amount_uy,remaining_uy,source,created_at,expires_at,wechat_order)
      SELECT ?,?,?,'subscription',?,?,? WHERE ${missingLedger}`,
      )
      .bind(
        txn.user_sub,
        amount,
        amount,
        now,
        end,
        txn.out_trade_no,
        txn.out_trade_no,
      ),
    db
      .prepare(
        `UPDATE account SET granted_uy=granted_uy+?,balance_uy=(SELECT COALESCE(SUM(remaining_uy),0) FROM bucket WHERE user_sub=? AND (expires_at IS NULL OR expires_at>?)),updated_at=? WHERE user_sub=? AND ${missingLedger}`,
      )
      .bind(amount, txn.user_sub, now, now, txn.user_sub, txn.out_trade_no),
    db
      .prepare(
        `INSERT INTO ledger(user_sub,ts,kind,amount_uy,reason,detail,balance_uy)
      SELECT ?,?,'grant',?,'subscription',?,(SELECT balance_uy FROM account WHERE user_sub=?) WHERE ${missingLedger}`,
      )
      .bind(txn.user_sub, now, amount, detail, txn.user_sub, txn.out_trade_no),
    db
      .prepare(
        "UPDATE wechat_attempt SET status='paid',next_query_at=NULL,updated_at=? WHERE out_trade_no=?",
      )
      .bind(now, values.out_trade_no),
    db
      .prepare(
        `UPDATE wechat_txn SET status='paid',wechat_txn_id=?,bucket_id=(SELECT id FROM bucket WHERE wechat_order=?),paid_at=?,last_callback_at=?,failure_code=NULL,entitlement_start_at=?,entitlement_end_at=?,updated_at=? WHERE out_trade_no=? AND status!='paid'`,
      )
      .bind(
        values.transaction_id,
        txn.out_trade_no,
        paidAt,
        now,
        start,
        end,
        now,
        txn.out_trade_no,
      ),
    db
      .prepare(
        `UPDATE wechat_sub SET period_start_at=?,period_end_at=?,last_event_at=?,last_error_code=NULL,updated_at=?
      WHERE contract_code=? AND changes()=1 AND (period_start_at IS NULL OR period_end_at<=?)`,
      )
      .bind(
        start,
        end,
        now,
        now,
        attempt.contract_code,
        end,
      ),
  ]);
  await audit(db, {
    now,
    direction: "inbound",
    event_type: "payment_settled",
    contract_code: attempt.contract_code,
    out_trade_no: values.out_trade_no,
    user_sub: txn.user_sub,
    status_before: "settling",
    status_after: "paid",
    wechat_txn_id: values.transaction_id,
    payload: values,
  });
  return { ok: true, granted: true };
}

// Only signed V3 payment results grant credit. Contract management is unavailable
// until an API compatible with the merchant's monthly plan is established.
async function reconcilePayment(db, env, attempt, now, fetcher) {
  const txn = await db.prepare("SELECT * FROM wechat_txn WHERE out_trade_no=? AND payment_kind='app'").bind(attempt.cycle_no).first();
  if (!txn || txn.status === 'paid') return;
  try { await reconcileAppCheckout(env, txn, now, fetcher); }
  catch (e) {
    await audit(db, { now, event_type:'app_query_failed',out_trade_no:txn.out_trade_no,
      contract_code:txn.contract_code,user_sub:txn.user_sub,code:e.code,message:e.message });
  }
}

// Cron only reconciles existing V3 APP orders. It never initiates recurring debits.
export async function runWechatPaySchedule(env, now = Date.now(), fetcher = fetch) {
  if (!env.USAGE || !wechatV3Ready(env)) return { skipped:'degraded' };
  let cursor = '', queried = 0;
  while (true) {
    const rows = (await env.USAGE.prepare(`SELECT a.* FROM wechat_attempt a
      JOIN wechat_txn t ON t.out_trade_no=a.cycle_no
      WHERE t.payment_kind='app' AND t.status='charging'
      AND a.status IN ('sending','unknown','accepted') AND a.next_query_at<=? AND a.out_trade_no>?
      ORDER BY a.out_trade_no LIMIT 50`).bind(now,cursor).all()).results;
    if (!rows.length) break;
    for (const a of rows) { await reconcilePayment(env.USAGE,env,a,now,fetcher); queried++; }
    cursor = rows[rows.length-1].out_trade_no;
  }
  return { queried, renewal_available:false };
}

async function settleAppCheckout(env, txn, data, now) {
  if (txn.payment_kind !== 'app' || data.appid !== env.WECHAT_PAY_APP_ID ||
      data.mchid !== env.WECHAT_PAY_MCH_ID || data.out_trade_no !== txn.out_trade_no ||
      data.trade_type !== 'APP' || data.trade_state !== 'SUCCESS' ||
      !data.transaction_id || data.amount?.total !== txn.amount_fen || data.amount?.currency !== 'CNY')
    throw new Error('app-payment-mismatch');
  return settlePayment(env.USAGE, txn, data, now);
}

async function reconcileAppCheckout(env, txn, now, fetcher) {
  const data = await wechatV3Request(env, 'GET',
    `/v3/pay/transactions/out-trade-no/${encodeURIComponent(txn.out_trade_no)}?mchid=${encodeURIComponent(env.WECHAT_PAY_MCH_ID)}`,
    null, fetcher, now);
  if (data.appid !== env.WECHAT_PAY_APP_ID || data.mchid !== env.WECHAT_PAY_MCH_ID ||
      data.out_trade_no !== txn.out_trade_no) throw new Error('app-query-mismatch');
  if (data.trade_state === 'SUCCESS') await settleAppCheckout(env, txn, data, now);
  else if (['CLOSED', 'REVOKED', 'PAYERROR'].includes(data.trade_state)) {
    await env.USAGE.batch([
      env.USAGE.prepare("UPDATE wechat_attempt SET status='failed',next_query_at=NULL,updated_at=? WHERE out_trade_no=? AND status IN ('sending','unknown','accepted')").bind(now,txn.out_trade_no),
      env.USAGE.prepare("UPDATE wechat_txn SET status='failed',failure_code=?,updated_at=? WHERE out_trade_no=? AND status='charging' AND changes()=1").bind(data.trade_state,now,txn.out_trade_no),
    ]);
  } else if (data.trade_state === 'REFUND') {
    await env.USAGE.prepare("UPDATE wechat_attempt SET status='refunded',next_query_at=NULL,updated_at=? WHERE out_trade_no=? AND status!='paid'")
      .bind(now, txn.out_trade_no).run();
  } else if (!['NOTPAY', 'USERPAYING'].includes(data.trade_state)) throw new Error('unknown-app-payment-state');
  await env.USAGE.prepare("UPDATE wechat_attempt SET next_query_at=? WHERE out_trade_no=? AND status IN ('sending','unknown','accepted')")
    .bind(now + QUERY_INTERVAL, txn.out_trade_no).run();
  return data.trade_state;
}

async function appCheckout(env, scope, now, fetcher) {
  const db = env.USAGE;
  if (!ready(env) || !wechatV3Ready(env)) return J({ error: 'degraded' }, 503);
  if (await activeIapSubscription(db, scope, now)) return J({ error: 'already-subscribed' }, 409);
  if (!(await wechatPayEnabled(env))) return J({ error: 'disabled' }, 403);
  let sub = await db.prepare("SELECT * FROM wechat_sub WHERE user_sub=? AND status IN ('pending','active') LIMIT 1").bind(scope).first();
  let txn = sub && await db.prepare("SELECT * FROM wechat_txn WHERE contract_code=? AND payment_kind='app' ORDER BY created_at DESC LIMIT 1").bind(sub.contract_code).first();
  if (txn?.status === 'paid') return J({ error: 'already-subscribed' }, 409);
  if (txn && txn.status === 'failed' && sub.status === 'pending') {
    await db.prepare("UPDATE wechat_sub SET status='expired',updated_at=? WHERE contract_code=? AND status='pending'").bind(now, sub.contract_code).run();
    sub = null; txn = null;
  }
  if (sub?.status === 'active' && (!txn || txn.status !== 'charging')) return J({ error: 'already-subscribed' }, 409);
  const other = await db.prepare(`SELECT a.out_trade_no FROM wechat_attempt a JOIN wechat_txn t ON t.out_trade_no=a.cycle_no
    WHERE t.user_sub=? AND a.status IN ('sending','unknown','accepted','refunded') AND t.out_trade_no!=? LIMIT 1`)
    .bind(scope, txn?.out_trade_no || '').first();
  if (other) return J({ error: 'payment-pending' }, 409);
  if (!sub) {
    const code = contractCode(now);
    await db.prepare("INSERT OR IGNORE INTO wechat_sub(contract_code,user_sub,plan_id,status,sign_mode,created_at,updated_at) VALUES(?,?,?,'pending','app',?,?)")
      .bind(code, scope, env.WECHAT_PAY_PLAN_ID, now, now).run();
    sub = await db.prepare("SELECT * FROM wechat_sub WHERE user_sub=? AND status IN ('pending','active') LIMIT 1").bind(scope).first();
    if (!sub || sub.status !== 'pending') return J({ error: 'already-subscribed' }, 409);
  }
  if (sub.sign_mode !== 'app') {
    // 延用同一商户协议号，避免在旧纯签约结果未知时创建第二份授权。
    const changed = await db.prepare("UPDATE wechat_sub SET sign_mode='app',updated_at=? WHERE contract_code=? AND status='pending'")
      .bind(now, sub.contract_code).run();
    if (changed.meta.changes !== 1) return J({ error: 'already-subscribed' }, 409);
    sub.sign_mode = 'app';
  }
  if (!txn) {
    const no = tradeNo(`app:${sub.contract_code}`, 0);
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,payment_kind,checkout_expires_at,request_serial,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'charging','app',?,?,?,?)`)
        .bind(no, sub.contract_code, scope, sub.plan_id, now, addCalendarMonth(now), amountFen(env), now + 30 * 60 * 1000, requestSerial(now), now, now),
      db.prepare(`INSERT OR IGNORE INTO wechat_attempt(out_trade_no,cycle_no,contract_code,contract_id,status,attempt_no,next_query_at,created_at,updated_at)
        SELECT out_trade_no,out_trade_no,contract_code,?,'unknown',1,?,?,? FROM wechat_txn WHERE out_trade_no=? AND payment_kind='app'`)
        .bind(sub.contract_id || '', now + QUERY_INTERVAL, now, now, no),
    ]);
    txn = await db.prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?").bind(no).first();
  }
  if (!txn || txn.status !== 'charging') return J({ error: 'payment-pending' }, 409);
  try {
    if (txn.prepay_id || txn.created_at < now) {
      let state;
      try { state = await reconcileAppCheckout(env, txn, now, fetcher); }
      // Only retry the SAME order; never infer payment from an unsigned error.
      catch (e) {
        if (e.code !== 'ORDER_NOT_EXIST') throw e;
        if (!txn.prepay_id && txn.checkout_expires_at <= now) {
          // A creation timeout can leave no WeChat order. Retry the same order number with a fresh expiry.
          txn.checkout_expires_at = now + 30 * 60 * 1000;
          await db.prepare("UPDATE wechat_txn SET checkout_expires_at=? WHERE out_trade_no=? AND status='charging' AND prepay_id IS NULL")
            .bind(txn.checkout_expires_at, txn.out_trade_no).run();
        }
      }
      if (state === 'SUCCESS') return J({ error: 'already-subscribed' }, 409);
      if (state && state !== 'NOTPAY') return J({ error: 'payment-pending' }, 409);
    }
    if (txn.checkout_expires_at <= now) {
      // 先由微信确认关单，再允许新订单；不因本地超时擅自换单。
      await wechatV3Request(env, 'POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(txn.out_trade_no)}/close`,
        { mchid: env.WECHAT_PAY_MCH_ID }, fetcher, now);
      await reconcileAppCheckout(env, txn, now, fetcher);
      return J({ error: 'checkout-expired' }, 409);
    }
    if (!txn.prepay_id) {
      const result = await wechatV3Request(env, 'POST', '/v3/pay/transactions/app-with-contract', {
        appid: env.WECHAT_PAY_APP_ID, mchid: env.WECHAT_PAY_MCH_ID,
        description: 'VoiceDrop 包月算力', out_trade_no: txn.out_trade_no,
        time_expire: new Date(txn.checkout_expires_at).toISOString(),
        notify_url: `${publicOrigin(env)}/agent/wechat-pay/app-pay-notify`,
        amount: { total: txn.amount_fen, currency: 'CNY' },
        contract_info: { plan_id: txn.plan_id, contract_mchid: env.WECHAT_PAY_MCH_ID,
          contract_appid: env.WECHAT_PAY_APP_ID, contract_code: sub.contract_code,
          request_serial: txn.request_serial,
          contract_display_account: String(env.WECHAT_PAY_CONTRACT_DISPLAY_ACCOUNT || 'VoiceDrop 包月算力').slice(0,64) },
      }, fetcher, now);
      if (typeof result.prepay_id !== 'string' || !result.prepay_id || result.prepay_id.length > 128) throw new Error('invalid-prepay-response');
      txn.prepay_id = result.prepay_id;
      await db.batch([
        db.prepare("UPDATE wechat_txn SET prepay_id=?,updated_at=? WHERE out_trade_no=? AND status='charging'").bind(txn.prepay_id, now, txn.out_trade_no),
        db.prepare("UPDATE wechat_attempt SET status='accepted',updated_at=? WHERE out_trade_no=? AND status IN ('unknown','sending')").bind(now, txn.out_trade_no),
      ]);
      await audit(db, { now, direction:'outbound', event_type:'app_checkout_created',contract_code:sub.contract_code,out_trade_no:txn.out_trade_no,user_sub:scope,payload:{amount_fen:txn.amount_fen,plan_id:txn.plan_id} });
    }
    // 用户回到 APP 后只查询服务端结果，不相信客户端 SDK 的付款成功标志。
    return J({ ok:true, checkout_mode:'app-with-contract', contract_code:sub.contract_code,
      expires_at:txn.checkout_expires_at, amount_fen:txn.amount_fen,
      pay_params:wechatV3AppPayParams(env, txn.prepay_id, now) });
  } catch (e) {
    await audit(db, { now, direction:'outbound', event_type:'app_checkout_failed',contract_code:sub.contract_code,out_trade_no:txn.out_trade_no,user_sub:scope,code:e.code || 'unconfirmed',message:e.providerMessage || e.message });
    return J({ error:'checkout-unavailable' }, 502);
  }
}

export async function handleWechatPayRoute(
  url,
  request,
  env,
  fetcher = fetch,
  now = Date.now(),
  ctx = null,
) {
  if (!url.pathname.startsWith("/agent/wechat-pay/")) return null;
  try {
    if (url.pathname === "/agent/wechat-pay/checkout" && request.method === "POST") {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      return await appCheckout(env, scope, now, fetcher);
    }
    if (url.pathname === "/agent/wechat-pay/app-pay-notify" && request.method === "POST") {
      if (!env.USAGE || !wechatV3Ready(env)) return J({ code:"FAIL", message:"UNAVAILABLE" }, 503);
      let data;
      try { data = decryptWechatV3Notification(env, request.headers, await request.text(), now); }
      catch { return J({ code:"FAIL", message:"INVALID NOTIFICATION" }, 400); }
      const txn = await env.USAGE.prepare("SELECT * FROM wechat_txn WHERE out_trade_no=? AND payment_kind='app'").bind(data.out_trade_no || '').first();
      if (!txn) return J({ code:"FAIL", message:"UNKNOWN ORDER" }, 400);
      try { await settleAppCheckout(env, txn, data, now); }
      catch { return J({ code:"FAIL", message:"PAYMENT NOT CONFIRMED" }, 500); }
      return new Response(null, { status:204 });
    }

    if (url.pathname === "/agent/wechat-pay/cancel" && request.method === "POST") {
      if (!await scopeFromToken(bearerToken(request), env)) return J({ error:"unauthorized" },401);
      return J({ error:"contract-management-unavailable" },501);
    }

    if (
      url.pathname === "/agent/wechat-pay/status" &&
      request.method === "GET"
    ) {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!env.USAGE) return J({ active: false, degraded: true });
      const appTxn = await env.USAGE.prepare("SELECT * FROM wechat_txn WHERE user_sub=? AND payment_kind='app' AND status='charging' ORDER BY created_at DESC LIMIT 1").bind(scope).first();
      if (appTxn && wechatV3Ready(env)) {
        const attempt = await env.USAGE.prepare("SELECT * FROM wechat_attempt WHERE out_trade_no=?").bind(appTxn.out_trade_no).first();
        if (attempt) await reconcilePayment(env.USAGE, env, attempt, now, fetcher);
      }
      const row = await env.USAGE.prepare(
        "SELECT contract_code, contract_id, plan_id, status, period_start_at, period_end_at, cancel_reason, signed_at, cancelled_at, last_error_code FROM wechat_sub WHERE user_sub=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1",
      )
        .bind(scope)
        .first();
      // 新签约的首期可能尚未扣款，此时用户的当前权益仍来自已取消的旧周期；
      // 因此权益到期日不能只看当前协议行。
      const coverage = await env.USAGE.prepare(
        "SELECT MAX(entitlement_end_at) AS expires_date FROM wechat_txn WHERE user_sub=? AND status='paid' AND entitlement_end_at>?",
      )
        .bind(scope, now)
        .first();
      const expiresAt = (coverage && coverage.expires_date) || null;
      const active = Number(expiresAt || 0) > now;
      const sum = active
        ? await env.USAGE.prepare(
            "SELECT COALESCE(SUM(remaining_uy),0) AS s FROM bucket WHERE user_sub=? AND source='subscription' AND (expires_at IS NULL OR expires_at>?)",
          )
            .bind(scope, now)
            .first()
        : { s: 0 };
      return J({
        active,
        checkout_pending: !!(await env.USAGE.prepare("SELECT 1 FROM wechat_txn t JOIN wechat_sub s ON s.contract_code=t.contract_code WHERE t.user_sub=? AND t.payment_kind='app' AND t.status='charging' AND s.status IN ('pending','active') LIMIT 1").bind(scope).first()),
        checkout_paid: !!(row && await env.USAGE.prepare("SELECT 1 FROM wechat_txn WHERE contract_code=? AND payment_kind='app' AND status='paid' LIMIT 1").bind(row.contract_code).first()),
        amount_fen: amountFen(env),
        enabled: await wechatPayEnabled(env),
        can_cancel: false,
        renewal_available: false,
        contract_management_available: false,
        contract_status_known: false,
        status: row ? row.status : null,
        plan_id: row ? row.plan_id : null,
        expires_date: expiresAt,
        // 尚未实际扣款的新协议以 period_start_at 为空标识；period_end_at 此时保存
        // 首期的约定起点，供稳定地计算订单周期，不能再用它判断是否待扣。
        scheduled_charge_at:
          null,
        cancel_reason: row ? row.cancel_reason : null,
        signed_at: row ? row.signed_at : null,
        cancelled_at: row ? row.cancelled_at : null,
        // 原始微信错误码/文本只留在 D1 的 wechat_sub / wechat_txn / wechat_event，
        // 客户端只得到稳定、可展示的通用状态，避免暴露支付通道内部信息。
        payment_issue: row && row.last_error_code ? "payment-failed" : null,
        payment_pending: !!(await unresolvedUserOrder(env.USAGE, scope)),
        renewal_stopped: true,
        sub_suanli: Math.round(uyToSuanli((sum && sum.s) || 0) * 10) / 10,
        monthly_suanli: SUB_GRANT_SUANLI,
      });
    }

    return J({ error: "not-found" }, 404);
  } catch (e) {
    console.error("[wechat-pay]", String((e && e.stack) || e));
    return J({ error: "server-error" }, 500);
  }
}
