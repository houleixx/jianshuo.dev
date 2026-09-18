// src/wechat-pay.js — V3 APP 首期支付并签约；V2 协议管理、周期扣款；统一原子入账。
//
// 跟 iap.js 一样：支付渠道自己的表只保存「协议 / 订单」；实际算力一律走
// bucket + ledger。已验签的成功回调和查单结果共用原子入账入口，重复回调与 Cron 重试
// 都以用户周期为幂等键；未确认的订单始终复用同一商户订单号。
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { wechatV3Ready, wechatV3Request, wechatV3AppPayParams, decryptWechatV3Notification, decryptWechatV3Event } from "./wechat-v3.js";
import { SUB_GRANT_SUANLI, suanliToUY, uyToSuanli } from "./usage.js";
import { ensureAccount } from "./usage_store.js";
import { activeIapSubscription } from "./subscription-status.js";
import {
  verifySession,
  anonScopeFromToken,
  bearerToken,
} from "../../functions/lib/auth.js";

const DAY_MS = 86400000, HOUR_MS = 3600000, CHARGE_LEAD_DAYS = 3;
const APPLY_URL = 'https://api.mch.weixin.qq.com/pay/pappayapply';
const QUERY_CONTRACT_URL = 'https://api.mch.weixin.qq.com/papay/querycontract';
const TERMINATE_CONTRACT_URL = 'https://api.mch.weixin.qq.com/papay/deletecontract';
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

export function wechatChargeScheduleAt(periodEndAt) {
  const beijingOffset = 8 * HOUR_MS;
  const beijingDayStart =
    Math.floor((Number(periodEndAt) + beijingOffset) / DAY_MS) * DAY_MS -
    beijingOffset;
  return beijingDayStart - CHARGE_LEAD_DAYS * DAY_MS + 2 * HOUR_MS;
}

const md5 = (s) =>
  createHash("md5").update(String(s), "utf8").digest("hex").toUpperCase();

// 微信支付 V2 的 XML + MD5 签名。委托代扣申请使用微信固定的 V2 官方地址。
export function wechatV2Sign(params, apiKey) {
  const q = Object.entries(params)
    .filter(
      ([k, v]) => k !== "sign" && v !== undefined && v !== null && v !== "",
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const message = `${q}&key=${apiKey}`;
  if (params.sign_type === 'HMAC-SHA256') return createHmac('sha256',apiKey).update(message).digest('hex').toUpperCase();
  if (params.sign_type && params.sign_type !== 'MD5') throw new Error('unsupported-sign-type');
  return md5(message);
}

export function wechatV2Xml(params, apiKey) {
  const signed = { ...params, sign: wechatV2Sign(params, apiKey) };
  return (
    "<xml>" +
    Object.entries(signed)
      .filter(([,v]) => v !== undefined && v !== null)
      .map(
        ([k, v]) =>
          `<${k}>${String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</${k}>`,
      )
      .join("") +
    "</xml>"
  );
}

// Only one flat XML document is accepted; no entity declarations, nested fields or duplicate keys.
export function parseWechatXml(text) {
  const xml=String(text || '').trim().replace(/^<\?xml[^?]*\?>\s*/,'');
  if (xml.length>65536 || !xml.startsWith('<xml>') || !xml.endsWith('</xml>') || /<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
  let rest=xml.slice(5,-6), out=Object.create(null);
  const entities={'amp':'&','lt':'<','gt':'>','quot':'"','apos':"'"};
  while(rest.trim()) {
    const m=/^\s*<([A-Za-z_][A-Za-z0-9_]*)>(?:\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*|([^<]*))<\/\1>/.exec(rest);
    if(!m || Object.hasOwn(out,m[1]))return null;
    let value=m[2] ?? m[3];
    if(m[2]===undefined) {
      if(/&(?!(?:amp|lt|gt|quot|apos);)/.test(value))return null;
      value=value.replace(/&(amp|lt|gt|quot|apos);/g,(_,k)=>entities[k]);
    }
    out[m[1]]=value;rest=rest.slice(m[0].length);
  }
  return Object.keys(out).length ? out : null;
}
export function verifyWechatV2(params, apiKey) {
  if(!apiKey || !params || !/^(?:[a-fA-F0-9]{32}|[a-fA-F0-9]{64})$/.test(params.sign || ''))return false;
  try {
    const expected=Buffer.from(wechatV2Sign(params,apiKey)), actual=Buffer.from(params.sign.toUpperCase());
    return actual.length===expected.length && timingSafeEqual(actual,expected);
  } catch { return false; }
}
function xmlReply(code, message) {
  return new Response(`<xml><return_code><![CDATA[${code}]]></return_code><return_msg><![CDATA[${message}]]></return_msg></xml>`,{headers:{'content-type':'text/xml; charset=utf-8'}});
}
function callbackData(p) { return p?.return_code==='SUCCESS' && p.result_code==='SUCCESS'; }
function lifecycleReady(env) { return !!(env.USAGE && env.WECHAT_PAY_API_V2_KEY && env.WECHAT_PAY_APP_ID && env.WECHAT_PAY_MCH_ID); }

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

// Coverage survives cancellation and must be carried into a replacement agreement.
async function coverageEnd(db, userSub, excludingOrder = '') {
  const row = await db.prepare(`SELECT MAX(expires_at) AS end_at FROM (
    SELECT entitlement_end_at AS expires_at FROM wechat_txn
      WHERE user_sub=? AND status='paid' AND out_trade_no!=?
    UNION ALL SELECT period_end_at AS expires_at FROM wechat_sub
      WHERE user_sub=? AND period_start_at IS NOT NULL AND status IN ('active','cancelled')
  )`).bind(userSub, excludingOrder, userSub).first();
  return Number(row?.end_at || 0);
}

// V3 agreement events never grant credit. Only verified payment results can do so.
// An agreement code is never reused after termination: delayed SIGN cannot revive it.
async function applyContractEvent(env, eventType, data, now) {
  const db = env.USAGE;
  const sub = await db.prepare('SELECT * FROM wechat_sub WHERE contract_code=?')
    .bind(data.out_contract_code || '').first();
  const signedAt = Date.parse(data.contract_signed_time);
  const terminated = eventType === 'ENTRUST.TERMINATE';
  const terminatedAt = terminated ? Date.parse(data.contract_terminate_info?.contract_terminated_time) : null;
  const eventAt = terminated ? terminatedAt : signedAt;
  if (!sub || data.mchid !== env.WECHAT_PAY_MCH_ID || data.appid !== env.WECHAT_PAY_APP_ID ||
      String(data.plan_id) !== String(sub.plan_id) || typeof data.contract_id !== 'string' || !data.contract_id ||
      (sub.contract_id && sub.contract_id !== data.contract_id) || (sub.openid && data.openid && sub.openid!==data.openid) ||
      data.contract_state !== (terminated ? 'TERMINATED' : 'SIGNED') ||
      !Number.isFinite(signedAt) || !Number.isFinite(eventAt) || eventAt < signedAt ||
      signedAt < sub.created_at - 5 * 60 * 1000 || eventAt > now + 5 * 60 * 1000)
    throw new Error('contract-notification-mismatch');
  const status = terminated ? 'cancelled' : 'active';
  // Conditions are rechecked by SQLite at write time, including concurrent notifications.
  await db.batch([
    db.prepare(`UPDATE wechat_sub SET contract_id=?,status=?,signed_at=?,cancelled_at=?,
      cancel_reason=?,contract_event_at=?,contract_verified_at=?,updated_at=?
      WHERE contract_code=? AND (contract_id IS NULL OR contract_id=?)
      AND (contract_event_at IS NULL OR contract_event_at<=?)
      AND (?=1 OR status IN ('pending','active'))`)
      .bind(data.contract_id,status,signedAt,terminatedAt,
        terminated ? String(data.contract_terminate_info?.contract_termination_mode || 'TERMINATED') : null,
        eventAt,now,now,sub.contract_code,data.contract_id,eventAt,terminated ? 1 : 0),
    db.prepare(`UPDATE wechat_attempt SET contract_id=? WHERE contract_code=? AND contract_id='' AND changes()>0`)
      .bind(data.contract_id,sub.contract_code),
    db.prepare(`UPDATE wechat_sub SET openid=COALESCE(openid,?),next_charge_at=CASE WHEN status='cancelled' THEN NULL ELSE next_charge_at END
      WHERE contract_code=? AND contract_id=?`).bind(data.openid || null,sub.contract_code,data.contract_id),
    db.prepare(`UPDATE wechat_txn SET status='failed',next_try_at=NULL,failure_code='contract-terminated',updated_at=?
      WHERE contract_code=? AND payment_kind='deduct' AND status IN ('pending','failed')
      AND EXISTS(SELECT 1 FROM wechat_sub WHERE contract_code=? AND status='cancelled')`).bind(now,sub.contract_code,sub.contract_code),
  ]);
  await armRenewal(db,sub.contract_code,now);
  await audit(db, { now, direction:'inbound',event_type:eventType,contract_code:sub.contract_code,
    user_sub:sub.user_sub,payload:{contract_id:data.contract_id,contract_state:data.contract_state,event_at:eventAt} });
}

// Scheduling state belongs to the subscription, not to V2 or V3. Never infer a paid period from a signature alone.
async function armRenewal(db, code, now) {
  const sub=await db.prepare('SELECT * FROM wechat_sub WHERE contract_code=?').bind(code).first();
  if(!sub || sub.status!=='active' || !sub.contract_id || sub.period_start_at==null ||
     sub.cancel_requested_at || sub.last_error_code || !sub.contract_verified_at) return;
  await db.prepare(`UPDATE wechat_sub SET next_charge_at=? WHERE contract_code=? AND status='active'
    AND cancel_requested_at IS NULL AND next_charge_at IS NULL AND last_error_code IS NULL AND period_end_at=?
    AND NOT EXISTS(SELECT 1 FROM wechat_txn WHERE contract_code=? AND payment_kind='deduct' AND status='failed')`)
    .bind(wechatChargeScheduleAt(sub.period_end_at),code,sub.period_end_at,code).run();
}
function contractTime(value, now) {
  const m=/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value || '');
  if(!m) throw new Error('invalid-contract-time');
  return paidTime(m.slice(1).join(''),now);
}
async function reconcileWechatContract(db,env,sub,now,fetcher) {
  if(!lifecycleReady(env))return {unknown:true};
  await db.prepare('UPDATE wechat_sub SET contract_query_at=? WHERE contract_code=?').bind(now+QUERY_INTERVAL,sub.contract_code).run();
  try {
    const {state,body}=await queryWechatContract(env,sub,fetcher);
    if(state==='9')return {pending:true};
    if(sub.openid && body.openid!==sub.openid)throw new Error('contract-payer-mismatch');
    const signedAt=contractTime(body.contract_signed_time,now);
    const eventAt=state==='1' ? contractTime(body.contract_terminated_time,now) : signedAt;
    await applyContractEvent(env,state==='1'?'ENTRUST.TERMINATE':'ENTRUST.SIGN',{
      mchid:body.mch_id,appid:body.appid,plan_id:body.plan_id,out_contract_code:body.contract_code,
      contract_id:body.contract_id,contract_state:state==='1'?'TERMINATED':'SIGNED',
      contract_signed_time:new Date(signedAt).toISOString(),openid:body.openid,
      ...(state==='1'?{contract_terminate_info:{contract_terminated_time:new Date(eventAt).toISOString(),contract_termination_mode:body.contract_termination_mode}}:{})
    },now);
    const current=await db.prepare('SELECT * FROM wechat_sub WHERE contract_code=?').bind(sub.contract_code).first();
    return {active:current.status==='active' && !current.cancel_requested_at,cancelled:current.status==='cancelled',sub:current};
  } catch(e) {
    await audit(db,{now,event_type:'contract_reconcile_failed',contract_code:sub.contract_code,user_sub:sub.user_sub,code:e.code,message:e.message});
    return {unknown:true};
  }
}
async function cancelContract(env,sub,now,fetcher) {
  const db=env.USAGE;
  // Durable intent is written before the network call and gates every new/resubmitted debit.
  await db.prepare(`UPDATE wechat_sub SET cancel_requested_at=COALESCE(cancel_requested_at,?),next_charge_at=NULL,contract_query_at=?
    WHERE contract_code=? AND status IN ('active','pending')`).bind(now,now+QUERY_INTERVAL,sub.contract_code).run();
  try {
    if(!sub.contract_id) {
      const checked=await reconcileWechatContract(db,env,sub,now,fetcher);
      if(checked.cancelled)return true;
      sub=await db.prepare('SELECT * FROM wechat_sub WHERE contract_code=?').bind(sub.contract_code).first();
      // Unknown callback state can still be terminated by the original plan + merchant contract code.
    }
    const provider=await terminateWechatContract(env,sub,fetcher);
    await markWechatContractCancelled(db,sub,now,'user-request','contract_cancelled',provider,null,'outbound');
    return true;
  } catch(e) {
    const checked=await reconcileWechatContract(db,env,sub,now,fetcher);
    if(checked.cancelled)return true;
    await audit(db,{now,event_type:'contract_cancel_failed',contract_code:sub.contract_code,user_sub:sub.user_sub,code:e.code,message:e.message});
    return false;
  }
}
async function settleDeductPayment(db,txn,values,now) {
  if(txn.payment_kind!=='deduct' || (values.trade_state && values.trade_state!=='SUCCESS') || (values.fee_type && values.fee_type!=='CNY') ||
     (values.trade_type && values.trade_type!=='PAP'))throw new Error('deduct-payment-mismatch');
  const at=paidTime(values.time_end,now);
  return settlePayment(db,txn,{...values,amount:{total:Number(values.total_fee)},success_time:new Date(at).toISOString()},now);
}
async function handleXmlNotification(env,path,raw,now) {
  if(!lifecycleReady(env))return xmlReply('FAIL','UNAVAILABLE');
  const v=parseWechatXml(raw);
  if(!verifyWechatV2(v,env.WECHAT_PAY_API_V2_KEY) || v.mch_id!==env.WECHAT_PAY_MCH_ID ||
      (v.appid && v.appid!==env.WECHAT_PAY_APP_ID))return xmlReply('FAIL','BAD SIGN OR MERCHANT');
  if(path.endsWith('/pay-notify')) {
    const a=await env.USAGE.prepare('SELECT * FROM wechat_attempt WHERE out_trade_no=?').bind(v.out_trade_no || '').first();
    const txn=a && await env.USAGE.prepare('SELECT * FROM wechat_txn WHERE out_trade_no=?').bind(a.cycle_no).first();
    if(!txn || txn.payment_kind!=='deduct' || v.appid!==env.WECHAT_PAY_APP_ID ||
       v.contract_id!==a.contract_id)return xmlReply('FAIL','PAYMENT MISMATCH');
    if(callbackData(v)) {
      if(v.contract_id!==a.contract_id) return xmlReply('FAIL','CONTRACT MISMATCH');
      await settleDeductPayment(env.USAGE,txn,v,now);
    } else if(v.return_code==='SUCCESS' && v.result_code==='FAIL') {
      await failAttempt(env.USAGE,a.out_trade_no,now,v.err_code || 'payment-failed');
    } else return xmlReply('FAIL','UNKNOWN PAYMENT RESULT');
    return xmlReply('SUCCESS','OK');
  }
  if(!callbackData(v))return xmlReply('FAIL','UNCONFIRMED CONTRACT');
  if(!['ADD','DELETE'].includes(v.change_type) || !v.openid) return xmlReply('FAIL','WRONG EVENT');
  const sub=await env.USAGE.prepare('SELECT * FROM wechat_sub WHERE contract_code=?').bind(v.contract_code || '').first();
  if(!sub || (sub.openid && sub.openid!==v.openid))return xmlReply('FAIL','UNKNOWN CONTRACT');
  const at=contractTime(v.operate_time,now), terminated=v.change_type==='DELETE';
  await applyContractEvent(env,terminated?'ENTRUST.TERMINATE':'ENTRUST.SIGN',{
    mchid:v.mch_id,appid:env.WECHAT_PAY_APP_ID,plan_id:v.plan_id,out_contract_code:v.contract_code,
    contract_id:v.contract_id,openid:v.openid,contract_state:terminated?'TERMINATED':'SIGNED',
    contract_signed_time:new Date(terminated ? sub.signed_at ?? at : at).toISOString(),
    ...(terminated?{contract_terminate_info:{contract_terminated_time:new Date(at).toISOString(),contract_termination_mode:v.contract_termination_mode}}:{})
  },now);
  return xmlReply('SUCCESS','OK');
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
  if (attempt.status === 'refunded') throw new Error('refund-review-required');
  if (txn.status === "paid") return { ok: true, already: true };
  const paidAt = Date.parse(values.success_time);
  if (!Number.isFinite(paidAt) || paidAt > now + 5 * 60 * 1000) throw new Error('invalid-payment-time');
  // Early renewals keep their future boundary. A genuinely late first/recovery payment buys a full month from payment time.
  const start = Math.max(txn.period_start_at, paidAt, await coverageEnd(db, txn.user_sub, txn.out_trade_no));
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
        `UPDATE wechat_txn SET next_try_at=NULL,processing_at=NULL,status='paid',wechat_txn_id=?,bucket_id=(SELECT id FROM bucket WHERE wechat_order=?),paid_at=?,last_callback_at=?,failure_code=NULL,entitlement_start_at=?,entitlement_end_at=?,updated_at=? WHERE out_trade_no=? AND status!='paid'`,
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
        `UPDATE wechat_sub SET next_charge_at=NULL,period_start_at=?,period_end_at=?,last_event_at=?,last_error_code=NULL,updated_at=?
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
  await armRenewal(db,attempt.contract_code,now);
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

async function reconcileAppPayment(db, env, attempt, now, fetcher) {
  const txn = await db.prepare("SELECT * FROM wechat_txn WHERE out_trade_no=? AND payment_kind='app'").bind(attempt.cycle_no).first();
  if (!txn || txn.status === 'paid') return;
  try {
    const state = await reconcileAppCheckout(env, txn, now, fetcher);
    if (state === 'NOTPAY' && txn.checkout_expires_at <= now) {
      await wechatV3Request(env,'POST',`/v3/pay/transactions/out-trade-no/${encodeURIComponent(txn.out_trade_no)}/close`,
        {mchid:env.WECHAT_PAY_MCH_ID},fetcher,now);
      await reconcileAppCheckout(env,txn,now,fetcher);
    }
  }
  catch (e) {
    await audit(db, { now, event_type:'app_query_failed',out_trade_no:txn.out_trade_no,
      contract_code:txn.contract_code,user_sub:txn.user_sub,code:e.code,message:e.message });
  }
}


async function postApply(env, txn, sub, fetcher, origin) {
  const payload = {
    appid: env.WECHAT_PAY_APP_ID,
    mch_id: env.WECHAT_PAY_MCH_ID,
    nonce_str: md5(`${txn.out_trade_no}:${txn.attempt_count}:${Date.now()}`)
      .slice(0, 32)
      .toLowerCase(),
    body: "VoiceDrop 包月算力",
    out_trade_no: txn.out_trade_no,
    total_fee: txn.amount_fen,
    fee_type: "CNY",
    trade_type: "PAP",
    notify_url: `${origin}/agent/wechat-pay/pay-notify`,
    // 微信通过签约成功后的协议 ID 关联模板；扣款接口不接收 plan_id。
    contract_id: sub.contract_id,
    attach: JSON.stringify({
      provider: "wechat",
      contract_code: txn.contract_code,
      period_start_at: txn.period_start_at,
    }),
  };
  const response = await fetcher(APPLY_URL, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: wechatV2Xml(payload, env.WECHAT_PAY_API_V2_KEY),
  });
  const body = parseWechatXml(await response.text());
  if (
    !response.ok ||
    !callbackData(body) ||
    !verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY) ||
    body.appid !== env.WECHAT_PAY_APP_ID ||
    body.mch_id !== env.WECHAT_PAY_MCH_ID
  ) {
    const code =
      (body && (body.err_code || body.return_code || body.result_code)) ||
      `http-${response.status}`;
    const message =
      (body && (body.err_code_des || body.return_msg || body.err_code)) ||
      "wechat-apply-failed";
    throw Object.assign(new Error(message), {
      code,
      verified:
        !!body &&
        verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY) &&
        body.mch_id === env.WECHAT_PAY_MCH_ID &&
        body.appid === env.WECHAT_PAY_APP_ID,
    });
  }
  return body;
}

// 回调是最快的状态同步路径，但微信并不保证回调最终送达。每一次可能扣款前，
// 都以微信查询结果为准：0=已签约，1=已解约，9=签约进行中（均为 V2 contract_state）。
async function queryWechatContract(env, sub, fetcher) {
  const payload = {
    appid: env.WECHAT_PAY_APP_ID,
    mch_id: env.WECHAT_PAY_MCH_ID,
    ...(sub.contract_id ? {contract_id:sub.contract_id} : {plan_id:sub.plan_id,contract_code:sub.contract_code}),
    version: "1.0",
  };
  const response = await fetcher(QUERY_CONTRACT_URL, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: wechatV2Xml(payload, env.WECHAT_PAY_API_V2_KEY),
  });
  const body = parseWechatXml(await response.text());
  if (
    !response.ok ||
    !callbackData(body) ||
    !verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY)
  ) {
    const code =
      (body && (body.err_code || body.return_code || body.result_code)) ||
      `http-${response.status}`;
    throw Object.assign(
      new Error(
        (body && (body.err_code_des || body.return_msg)) ||
          "wechat-contract-query-failed",
      ),
      { code, provider: body },
    );
  }
  if (
    body.appid !== env.WECHAT_PAY_APP_ID ||
    body.mch_id !== env.WECHAT_PAY_MCH_ID ||
    !body.contract_id || (sub.contract_id && body.contract_id !== sub.contract_id) ||
    body.plan_id !== String(sub.plan_id) || body.contract_code !== sub.contract_code
  ) {
    throw Object.assign(new Error("wechat-contract-query-invalid-response"), {
      code: "invalid-provider-response",
      provider: body,
    });
  }
  const state = String(body.contract_state || "");
  if (!["0", "1", "9"].includes(state)) {
    throw Object.assign(new Error("wechat-contract-query-unknown-state"), {
      code: "unknown-contract-state",
      provider: body,
    });
  }
  return { state, body };
}

// 用户从 App 主动解除自动续费时，仍由服务端使用微信协议号发起。客户端永远
// 不接触 contract_id、商户号或 V2 签名材料。微信 V2 的 deletecontract 是同步
// 受理结果；后续重复的微信解约回调仍会按幂等方式落库。
async function terminateWechatContract(env, sub, fetcher) {
  const payload = {
    appid: env.WECHAT_PAY_APP_ID,
    mch_id: env.WECHAT_PAY_MCH_ID,
    ...(sub.contract_id ? {contract_id:sub.contract_id} : {plan_id:sub.plan_id,contract_code:sub.contract_code}),
    contract_termination_remark: "用户在 VoiceDrop App 解除自动续费",
    version: "1.0",
  };
  const response = await fetcher(TERMINATE_CONTRACT_URL, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: wechatV2Xml(payload, env.WECHAT_PAY_API_V2_KEY),
  });
  const body = parseWechatXml(await response.text());
  if (
    !response.ok ||
    !callbackData(body) ||
    !verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY)
  ) {
    const code =
      (body && (body.err_code || body.return_code || body.result_code)) ||
      `http-${response.status}`;
    throw Object.assign(
      new Error(
        (body && (body.err_code_des || body.return_msg)) ||
          "wechat-contract-termination-failed",
      ),
      { code, provider: body },
    );
  }
  if (
    body.appid !== env.WECHAT_PAY_APP_ID ||
    body.mch_id !== env.WECHAT_PAY_MCH_ID ||
    (sub.contract_id && body.contract_id && body.contract_id !== sub.contract_id)
  ) {
    throw Object.assign(
      new Error("wechat-contract-termination-invalid-response"),
      { code: "invalid-provider-response", provider: body },
    );
  }
  return body;
}

async function markWechatContractCancelled(
  db,
  sub,
  now,
  reason,
  eventType,
  payload,
  message = null,
  direction = "inbound",
) {
  // charging 的申请已经被微信受理，最终仍可能成功回调；只终止尚未提交给微信的订单。
  await db
    .prepare(
      "UPDATE wechat_sub SET status='cancelled', next_charge_at=NULL, contract_verified_at=updated_at, cancel_reason=?, cancelled_at=COALESCE(cancelled_at,?), last_event_at=?, last_error_code=NULL, updated_at=? WHERE contract_code=?",
    )
    .bind(reason, now, now, now, sub.contract_code)
    .run();
  await db
    .prepare(
      "UPDATE wechat_txn SET status='failed', next_try_at=NULL, failure_code='contract-terminated', last_error_at=?, updated_at=? WHERE contract_code=? AND status IN ('pending','failed')",
    )
    .bind(now, now, sub.contract_code)
    .run();
  await audit(db, {
    now,
    direction,
    event_type: eventType,
    contract_code: sub.contract_code,
    user_sub: sub.user_sub,
    status_before: sub.status,
    status_after: "cancelled",
    message,
    payload,
  });
}


const OPEN_ATTEMPTS = "('sending','unknown','accepted')";
const PERMANENT_APPLY_ERRORS = new Set([
  "PARAM_ERROR",
  "SIGN_ERROR",
  "APPID_MCHID_NOT_MATCH",
  "PAYAUTH_ERROR",
  "PAYAUTHERROR",
  "CONTRACT_NOT_EXIST",
  "CONTRACTERROR",
]);

function paidTime(value, fallback) {
  if (!/^\d{14}$/.test(value || "")) throw new Error("missing-payment-time");
  const s = value;
  const at = Date.parse(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+08:00`,
  );
  if (!Number.isFinite(at) || at > fallback + 5 * 60 * 1000)
    throw new Error("invalid-payment-time");
  const normalized = new Date(at + 8 * HOUR_MS)
    .toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, "");
  if (normalized !== value) throw new Error("invalid-payment-time");
  return at;
}

async function requestCharge(db, env, txn, sub, now, fetcher, origin) {
  if (
    !txn ||
    txn.payment_kind === "app" ||
    !["pending", "failed"].includes(txn.status) ||
    Number(txn.attempt_count) >= Number(txn.max_attempts) ||
    wechatChargeScheduleAt(txn.period_start_at) > now
  )
    return { skipped: true };
  const number = Number(txn.attempt_count) + 1;
  const merchantOrder =
    number === 1 ? txn.out_trade_no : tradeNo(txn.out_trade_no, number);
  // The conditional update and attempt insertion form one D1 transaction. No request is sent before this commits.
  const claimed = await db.batch([
    db
      .prepare(
        `UPDATE wechat_txn SET status='charging', processing_at=?, attempt_count=attempt_count+1, next_try_at=NULL, updated_at=?
      WHERE out_trade_no=? AND status IN ('pending','failed') AND attempt_count=? AND attempt_count<max_attempts
      AND next_try_at<=? AND period_end_at>?
      AND EXISTS(SELECT 1 FROM wechat_sub WHERE contract_code=? AND status='active' AND cancel_requested_at IS NULL AND contract_verified_at IS NOT NULL AND next_charge_at<=?)
      AND NOT EXISTS(SELECT 1 FROM wechat_attempt a JOIN wechat_txn t ON t.out_trade_no=a.cycle_no WHERE t.user_sub=? AND a.status IN ('sending','unknown','accepted','refunded'))`,
      )
      .bind(
        now,
        now,
        txn.out_trade_no,
        txn.attempt_count,
        now,
        now,
        sub.contract_code,
        now,
        txn.user_sub,
      ),
    db
      .prepare(
        `INSERT INTO wechat_attempt(out_trade_no,cycle_no,contract_code,contract_id,status,attempt_no,next_query_at,created_at,updated_at)
      SELECT ?,?,?,?,'sending',?,?,?,? WHERE changes()=1`,
      )
      .bind(
        merchantOrder,
        txn.out_trade_no,
        sub.contract_code,
        sub.contract_id,
        number,
        now + QUERY_INTERVAL,
        now,
        now,
      ),
  ]);
  if (claimed[0].meta.changes !== 1) return { skipped: true };
  try {
    const provider = await postApply(
      env,
      { ...txn, out_trade_no: merchantOrder, attempt_count: number },
      sub,
      fetcher,
      origin,
    );
    await db
      .prepare(
        "UPDATE wechat_attempt SET status='accepted', updated_at=? WHERE out_trade_no=? AND status='sending'",
      )
      .bind(now, merchantOrder)
      .run();
    await db
      .prepare(
        "UPDATE wechat_txn SET charge_requested_at=?, processing_at=NULL, updated_at=? WHERE out_trade_no=? AND status='charging'",
      )
      .bind(now, now, txn.out_trade_no)
      .run();
    await audit(db, {
      now,
      direction: "outbound",
      event_type: "charge_requested",
      contract_code: sub.contract_code,
      out_trade_no: merchantOrder,
      user_sub: txn.user_sub,
      status_before: txn.status,
      status_after: "charging",
      payload: provider,
    });
    return { charged: true };
  } catch (e) {
    // A timeout, SYSTEMERROR, ORDERPAID, ORDER_ACCEPTED or malformed response does not prove failure.
    if (PERMANENT_APPLY_ERRORS.has(e.code) && e.verified) {
      await failAttempt(db, merchantOrder, now, String(e.code), false);
    } else {
      await db
        .prepare(
          "UPDATE wechat_attempt SET status='unknown', next_query_at=?, updated_at=? WHERE out_trade_no=? AND status='sending'",
        )
        .bind(now + QUERY_INTERVAL, now, merchantOrder)
        .run();
      await db
        .prepare(
          "UPDATE wechat_txn SET failure_code='payment-pending', updated_at=? WHERE out_trade_no=? AND status!='paid'",
        )
        .bind(now, txn.out_trade_no)
        .run();
    }
    await audit(db, {
      now,
      direction: "outbound",
      event_type: "charge_request_failed",
      contract_code: sub.contract_code,
      out_trade_no: merchantOrder,
      user_sub: txn.user_sub,
      code: e.code || "unknown",
      message: e.message,
    });
    return { failed: true };
  }
}

async function failAttempt(db, merchantOrder, now, code, retry = true) {
  const attempt = await db
    .prepare("SELECT * FROM wechat_attempt WHERE out_trade_no=?")
    .bind(merchantOrder)
    .first();
  if (!attempt) return;
  // Permit another attempt on a later Beijing calendar day; an async result can arrive just after 02:00.
  const nextDay =
    Math.floor((attempt.created_at + 8 * HOUR_MS) / DAY_MS) * DAY_MS -
    8 * HOUR_MS +
    DAY_MS +
    2 * HOUR_MS;
  await db.batch([
    db
      .prepare(
        "UPDATE wechat_attempt SET status='failed', next_query_at=NULL, updated_at=? WHERE out_trade_no=? AND status IN ('sending','unknown','accepted')",
      )
      .bind(now, merchantOrder),
    db
      .prepare(
        `UPDATE wechat_txn SET status='failed',processing_at=NULL,next_try_at=?,failure_code=?,last_error_at=?,updated_at=?
      WHERE out_trade_no=? AND status!='paid' AND changes()=1`,
      )
      .bind(
        retry ? Math.max(now, nextDay) : null,
        code,
        now,
        now,
        attempt.cycle_no,
      ),
    db
      .prepare(
        "UPDATE wechat_sub SET last_error_code=?,last_event_at=?,updated_at=? WHERE contract_code=? AND EXISTS(SELECT 1 FROM wechat_txn WHERE out_trade_no=? AND status='failed')",
      )
      .bind(code, now, now, attempt.contract_code, attempt.cycle_no),
  ]);
  if (!retry)
    await db
      .prepare(
        "UPDATE wechat_sub SET next_charge_at=NULL WHERE contract_code=? AND last_error_code=?",
      )
      .bind(attempt.contract_code, code)
      .run();
  await audit(db, {
    now,
    direction: "inbound",
    event_type: "payment_failed",
    contract_code: attempt.contract_code,
    out_trade_no: merchantOrder,
    code,
  });
}

async function createDueTransaction(db, sub, env, now) {
  // A payment callback may have advanced coverage while the scheduler queried WeChat.
  sub = await db
    .prepare(
      "SELECT * FROM wechat_sub WHERE contract_code=? AND status='active' AND cancel_requested_at IS NULL AND contract_verified_at IS NOT NULL AND next_charge_at<=?",
    )
    .bind(sub.contract_code, now)
    .first();
  if (!sub || sub.period_start_at == null) return null;
  if (await unresolvedUserOrder(db, sub.user_sub)) return null;
  const coverage = await db
    .prepare(
      "SELECT MAX(entitlement_end_at) AS end FROM wechat_txn WHERE user_sub=? AND status='paid'",
    )
    .bind(sub.user_sub)
    .first();
  const start = Math.max(
    Number(sub.period_end_at ?? now),
    Number(coverage?.end || 0),
  );
  if (wechatChargeScheduleAt(start) > now) return null;
  // A scheduler outage may span more than a month. Keep the stable billing boundary/order ID,
  // but allow recovery now; the verified payment time determines the actual full-month entitlement.
  const end = addCalendarMonth(Math.max(start,now));
  const purchased=await db.prepare("SELECT amount_fen FROM wechat_txn WHERE contract_code=? AND status='paid' ORDER BY paid_at DESC LIMIT 1").bind(sub.contract_code).first();
  if(!purchased || !Number.isInteger(purchased.amount_fen) || purchased.amount_fen<=0)return null;
  // The user and fixed billing boundary identify a cycle; changing authorization cannot create a second cycle.
  const no = tradeNo(sub.user_sub, start);
  await db
    .prepare(
      `INSERT OR IGNORE INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,next_try_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,?)`,
    )
    .bind(
      no,
      sub.contract_code,
      sub.user_sub,
      sub.plan_id,
      start,
      end,
      purchased.amount_fen,
      now,
      now,
      now,
    )
    .run();
  let txn = await db
    .prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?")
    .bind(no)
    .first();
  return txn?.contract_code===sub.contract_code ? txn : null;
}


async function reconcilePayment(db, env, attempt, now, fetcher) {
  const txn = await db
    .prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?")
    .bind(attempt.cycle_no)
    .first();
  if (!txn || txn.status === "paid") return;
  try {
  if (txn.payment_kind === 'app') {
    if(wechatV3Ready(env)) await reconcileAppPayment(db,env,attempt,now,fetcher);
    return;
  }
  if(!lifecycleReady(env)) return;
    const response = await fetcher(
      "https://api.mch.weixin.qq.com/pay/orderquery",
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "text/xml; charset=utf-8" },
        body: wechatV2Xml(
          {
            appid: env.WECHAT_PAY_APP_ID,
            mch_id: env.WECHAT_PAY_MCH_ID,
            out_trade_no: attempt.out_trade_no,
            nonce_str: crypto.randomUUID().replaceAll("-", ""),
          },
          env.WECHAT_PAY_API_V2_KEY,
        ),
      },
    );
    const body = parseWechatXml(await response.text());
    if (
      response.ok &&
      body &&
      body.return_code === "SUCCESS" &&
      body.result_code === "FAIL" &&
      body.err_code === "ORDERNOTEXIST" &&
      verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY) &&
      body.appid === env.WECHAT_PAY_APP_ID &&
      body.mch_id === env.WECHAT_PAY_MCH_ID
    ) {
      const sub = await db
        .prepare(
          "SELECT * FROM wechat_sub WHERE contract_code=? AND status='active' AND cancel_requested_at IS NULL",
        )
        .bind(attempt.contract_code)
        .first();
      // Recovery after commit-before-send. Re-send ONLY the same merchant order and original amount/authorization.
      // A missing order is never grounds for creating a replacement order under a new authorization.
      if (
        sub && sub.contract_id===attempt.contract_id &&
        attempt.resubmit_count < 3 &&
        attempt.created_at + QUERY_INTERVAL <= now &&
        attempt.next_query_at <= now &&
        (await reconcileWechatContract(db, env, sub, now, fetcher)).active
      ) {
        const claimed = await db
          .prepare(
            "UPDATE wechat_attempt SET status='sending',resubmit_count=resubmit_count+1,next_query_at=?,updated_at=? WHERE out_trade_no=? AND status IN ('sending','unknown') AND next_query_at<=? AND resubmit_count<3 AND EXISTS(SELECT 1 FROM wechat_sub s WHERE s.contract_code=wechat_attempt.contract_code AND s.status='active' AND s.cancel_requested_at IS NULL)",
          )
          .bind(now + QUERY_INTERVAL, now, attempt.out_trade_no, now)
          .run();
        if (claimed.meta.changes === 1) {
          await postApply(
            env,
            { ...txn, out_trade_no: attempt.out_trade_no },
            sub,
            fetcher,
            publicOrigin(env),
          );
          await db
            .prepare(
              "UPDATE wechat_attempt SET status='accepted',updated_at=? WHERE out_trade_no=? AND status='sending'",
            )
            .bind(now, attempt.out_trade_no)
            .run();
        }
        return;
      }
      throw new Error("order-not-found-review-required");
    }
    if (
      !response.ok ||
      !callbackData(body) ||
      !verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY) ||
      body.appid !== env.WECHAT_PAY_APP_ID ||
      body.mch_id !== env.WECHAT_PAY_MCH_ID ||
      body.out_trade_no !== attempt.out_trade_no
    )
      throw new Error("order-query-unconfirmed");
    if (body.trade_state === "SUCCESS") {
      if (body.contract_id && body.contract_id !== attempt.contract_id)
        throw new Error("order-contract-mismatch");
      await settleDeductPayment(db, txn, body, now);
    } else if (
      ["CLOSED", "PAY_FAIL", "PAYERROR", "REVOKED"].includes(body.trade_state)
    ) {
      await failAttempt(db, attempt.out_trade_no, now, body.trade_state);
    } else if (body.trade_state === "REFUND") {
      // Refund entitlement policy is separate from cancelling renewal; do not silently charge again.
      await db
        .prepare(
          "UPDATE wechat_attempt SET status='refunded',next_query_at=NULL,updated_at=? WHERE out_trade_no=? AND status!='paid'",
        )
        .bind(now, attempt.out_trade_no)
        .run();
      await db
        .prepare(
          "UPDATE wechat_sub SET next_charge_at=NULL,last_error_code='refund-review',updated_at=? WHERE contract_code=?",
        )
        .bind(now, attempt.contract_code)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE wechat_attempt SET next_query_at=?,updated_at=? WHERE out_trade_no=? AND status IN ${OPEN_ATTEMPTS}`,
        )
        .bind(now + QUERY_INTERVAL, now, attempt.out_trade_no)
        .run();
    }
  } catch (e) {
    await db
      .prepare(
        `UPDATE wechat_attempt SET next_query_at=?,updated_at=? WHERE out_trade_no=? AND status IN ${OPEN_ATTEMPTS}`,
      )
      .bind(now + QUERY_INTERVAL, now, attempt.out_trade_no)
      .run();
    await audit(db, {
      now,
      direction: "outbound",
      event_type: "payment_query_failed",
      out_trade_no: attempt.out_trade_no,
      contract_code: attempt.contract_code,
      user_sub: txn.user_sub,
      message: e.message,
    });
  }
}

// Keyset pagination prevents stuck early rows from starving later users. Reconciliation may resend the same merchant order, but never creates a replacement order.
export async function runWechatPaySchedule(
  env,
  now = Date.now(),
  fetcher = fetch,
  origin = null,
  reconcileOnly = false,
) {
  if (!env.USAGE) return { skipped: 'degraded' };
  const db = env.USAGE,
    result = { created: 0, requested: 0, failed: 0, cancelled: 0, deferred: 0 };
  let cursor = "";
  while (true) {
    const rows = (
      await db
        .prepare(
          `SELECT * FROM wechat_attempt WHERE status IN ${OPEN_ATTEMPTS} AND next_query_at<=? AND out_trade_no>? ORDER BY out_trade_no LIMIT 50`,
        )
        .bind(now, cursor)
        .all()
    ).results;
    if (!rows.length) break;
    for (const a of rows) await reconcilePayment(db, env, a, now, fetcher);
    cursor = rows[rows.length - 1].out_trade_no;
  }
  if (!lifecycleReady(env)) return {...result,renewal_available:false};
  // Recover paid contracts even when every signing callback was lost. Cancel intent survives process failures.
  let contractCursor='';
  while(true) {
    const contracts=(await db.prepare(`SELECT * FROM wechat_sub WHERE status IN ('pending','active')
      AND (contract_query_at IS NULL OR contract_query_at<=?) AND contract_code>?
      AND (period_start_at IS NOT NULL OR cancel_requested_at IS NOT NULL)
      ORDER BY contract_code LIMIT 50`).bind(now,contractCursor).all()).results;
    if(!contracts.length)break;
    for(const sub of contracts) {
      if(sub.cancel_requested_at) await cancelContract(env,sub,now,fetcher);
      else await reconcileWechatContract(db,env,sub,now,fetcher);
    }
    contractCursor=contracts.at(-1).contract_code;
  }
  if (reconcileOnly) return result;
  if(!env.WECHAT_PAY_CALLBACK_BASE_URL || !amountFen(env)) return {...result,renewal_available:false};
  const checks = new Map();
  const check = async (sub) => {
    if (!checks.has(sub.contract_code))
      checks.set(
        sub.contract_code,
        reconcileWechatContract(db, env, sub, now, fetcher),
      );
    return checks.get(sub.contract_code);
  };
  cursor = "";
  while (true) {
    const rows = (
      await db
        .prepare(
          "SELECT * FROM wechat_sub WHERE status='active' AND contract_id IS NOT NULL AND next_charge_at<=? AND contract_code>? ORDER BY contract_code LIMIT 50",
        )
        .bind(now, cursor)
        .all()
    ).results;
    if (!rows.length) break;
    for (const sub of rows) {
      const c = await check(sub);
      if (!c.active) {
        if (c.cancelled) result.cancelled++;
        else result.deferred++;
        continue;
      }
      const txn = await createDueTransaction(db, sub, env, now);
      if (txn) result.created++;
    }
    cursor = rows[rows.length - 1].contract_code;
  }
  cursor = "";
  while (true) {
    const rows = (
      await db
        .prepare(
          `SELECT t.*,s.contract_id FROM wechat_txn t JOIN wechat_sub s ON s.contract_code=t.contract_code
      WHERE t.payment_kind='deduct' AND t.status IN ('pending','failed') AND t.next_try_at<=? AND t.attempt_count<t.max_attempts AND t.period_end_at>? AND s.status='active' AND t.out_trade_no>? ORDER BY t.out_trade_no LIMIT 50`,
        )
        .bind(now, now, cursor)
        .all()
    ).results;
    if (!rows.length) break;
    for (const txn of rows) {
      const c = await check(txn);
      if (!c.active) {
        if (c.cancelled) result.cancelled++;
        else result.deferred++;
        continue;
      }
      const r = await requestCharge(
        db,
        env,
        txn,
        txn,
        now,
        fetcher,
        origin || publicOrigin(env),
      );
      if (r.charged) result.requested++;
      if (r.failed) result.failed++;
    }
    cursor = rows[rows.length - 1].out_trade_no;
  }
  await db
    .prepare(
      `UPDATE wechat_sub SET next_charge_at=NULL,last_error_code='retry-exhausted',updated_at=? WHERE status='active'
    AND EXISTS(SELECT 1 FROM wechat_txn t WHERE t.contract_code=wechat_sub.contract_code AND t.payment_kind='deduct' AND t.status='failed' AND (t.attempt_count>=t.max_attempts OR t.period_end_at<=?))`,
    )
    .bind(now, now)
    .run();
  return result;
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
  if(sub && lifecycleReady(env) && (txn?.status==='paid' || sub.status==='active')) {
    const checked=await reconcileWechatContract(db,env,sub,now,fetcher);
    if(checked.cancelled) {sub=null;txn=null;}
  }
  if (txn?.status === 'paid') return J({ error: Number(txn.entitlement_end_at) > now
    ? 'already-subscribed' : 'contract-status-unavailable' }, 409);
  if (txn && txn.status === 'failed' && sub.status === 'pending') {
    if(lifecycleReady(env)) {
      const checked=await reconcileWechatContract(db,env,sub,now,fetcher);
      if(!checked.cancelled)return J({error:checked.active?'already-subscribed':'contract-status-unavailable'},409);
    }
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
    const periodStart = Math.max(now, await coverageEnd(db, scope));
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,payment_kind,checkout_expires_at,request_serial,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'charging','app',?,?,?,?)`)
        .bind(no, sub.contract_code, scope, sub.plan_id, periodStart, addCalendarMonth(periodStart), amountFen(env), now + 30 * 60 * 1000, requestSerial(now), now, now),
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
          contract_notify_url: `${publicOrigin(env)}/agent/wechat-pay/contract-notify`,
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

    if(request.method==='POST' && ['/agent/wechat-pay/pay-notify','/agent/wechat-pay/contract-notify','/agent/wechat-pay/cancel-notify'].includes(url.pathname)) {
      const raw=await request.clone().text();
      if(raw.trimStart().startsWith('<') || url.pathname.endsWith('/pay-notify')) {
        try { return await handleXmlNotification(env,url.pathname,raw,now); }
        catch { return xmlReply('FAIL','NOT CONFIRMED'); }
      }
    }

    if (['/agent/wechat-pay/contract-notify','/agent/wechat-pay/cancel-notify'].includes(url.pathname) && request.method === 'POST') {
      if (!env.USAGE || !wechatV3Ready(env)) return J({ code:'FAIL',message:'UNAVAILABLE' },503);
      let event;
      try { event = decryptWechatV3Event(env,request.headers,await request.text(),['ENTRUST.SIGN','ENTRUST.TERMINATE'],now); }
      catch { return J({ code:'FAIL',message:'INVALID NOTIFICATION' },400); }
      try { await applyContractEvent(env,event.eventType,event.data,now); }
      catch { return J({ code:'FAIL',message:'CONTRACT NOT CONFIRMED' },500); }
      return new Response(null,{status:204});
    }

    if (url.pathname === '/agent/wechat-pay/cancel' && request.method==='POST') {
      const scope=await scopeFromToken(bearerToken(request),env);
      if(!scope)return J({error:'unauthorized'},401);
      if(!lifecycleReady(env))return J({error:'contract-management-unavailable'},503);
      const sub=await env.USAGE.prepare("SELECT * FROM wechat_sub WHERE user_sub=? ORDER BY CASE WHEN status IN ('active','pending') THEN 0 ELSE 1 END,updated_at DESC LIMIT 1").bind(scope).first();
      if(sub?.status==='cancelled')return J({ok:true,status:'cancelled',already:true,expires_date:await coverageEnd(env.USAGE,scope)});
      if(!sub || !['active','pending'].includes(sub.status))return J({error:'no-active-contract'},409);
      if(await cancelContract(env,sub,now,fetcher))return J({ok:true,status:'cancelled',expires_date:await coverageEnd(env.USAGE,scope)});
      return J({error:'cancel-pending'},502);
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
      const live=await env.USAGE.prepare("SELECT * FROM wechat_sub WHERE user_sub=? AND status IN ('pending','active') LIMIT 1").bind(scope).first();
      if(live && lifecycleReady(env) && (live.period_start_at!=null || live.contract_id) && (!live.contract_query_at || live.contract_query_at<=now)) {
        if(live.cancel_requested_at)await cancelContract(env,live,now,fetcher);
        else await reconcileWechatContract(env.USAGE,env,live,now,fetcher);
      }
      const row = await env.USAGE.prepare(
        "SELECT contract_code, contract_id, plan_id, status, period_start_at, period_end_at, cancel_reason, signed_at, cancelled_at, last_error_code, contract_verified_at, next_charge_at, cancel_requested_at FROM wechat_sub WHERE user_sub=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1",
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
        can_cancel: lifecycleReady(env) && !!row && ['pending','active'].includes(row.status),
        renewal_available: lifecycleReady(env) && !!env.WECHAT_PAY_CALLBACK_BASE_URL && !!amountFen(env),
        contract_management_available: lifecycleReady(env),
        cancel_pending: !!row?.cancel_requested_at && row?.status!=='cancelled',
        contract_status_known: !!row?.contract_verified_at,
        status: row ? row.status : null,
        plan_id: row ? row.plan_id : null,
        expires_date: expiresAt,
        // 尚未实际扣款的新协议以 period_start_at 为空标识；period_end_at 此时保存
        // 首期的约定起点，供稳定地计算订单周期，不能再用它判断是否待扣。
        scheduled_charge_at: row?.next_charge_at || null,
        cancel_reason: row ? row.cancel_reason : null,
        signed_at: row ? row.signed_at : null,
        cancelled_at: row ? row.cancelled_at : null,
        // 原始微信错误码/文本只留在 D1 的 wechat_sub / wechat_txn / wechat_event，
        // 客户端只得到稳定、可展示的通用状态，避免暴露支付通道内部信息。
        payment_issue: row && row.last_error_code ? "payment-failed" : null,
        payment_pending: !!(await unresolvedUserOrder(env.USAGE, scope)),
        renewal_stopped: !lifecycleReady(env) || !row || row.status!=='active' || !!row.cancel_requested_at || row.next_charge_at==null,
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
