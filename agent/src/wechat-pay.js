// src/wechat-pay.js — 微信委托代扣（¥19.9/月 → 每月 200 算力）。
//
// 跟 iap.js 一样：支付渠道自己的表只保存「协议 / 订单」；实际算力一律走
// bucket + ledger。微信的支付成功回调是唯一入账入口，重复回调与 Cron 重试
// 都以 out_trade_no 为幂等键。
import { createHash } from "node:crypto";
import { SUB_GRANT_SUANLI, suanliToUY, uyToSuanli } from "./usage.js";
import { grantBucket } from "./usage_store.js";
import { activeIapSubscription } from "./subscription-status.js";
import { verifySession, anonScopeFromToken, bearerToken } from "../../functions/lib/auth.js";

const DAY_MS = 86400000;
const CHARGE_LEAD_MS = DAY_MS;              // 委托代扣申请须在本周期结束前至少 24 小时
const RETRY_MS = 5 * 60 * 1000;
const STALE_SETTLING_MS = 10 * 60 * 1000;
const PRE_ENTRUST_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PRECONTRACT_URL = "https://api.mch.weixin.qq.com/papay/preentrustweb";
const APPLY_URL = "https://api.mch.weixin.qq.com/pay/pappayapply";
const QUERY_CONTRACT_URL = "https://api.mch.weixin.qq.com/papay/querycontract";
const TERMINATE_CONTRACT_URL = "https://api.mch.weixin.qq.com/papay/deletecontract";
const WECHAT_PAY_CONFIG_KEY = "config/wechat-pay.json";
const J = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
const xmlReply = (code, message) => new Response(
  `<xml><return_code><![CDATA[${code}]]></return_code><return_msg><![CDATA[${message}]]></return_msg></xml>`,
  { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } },
);

async function scopeFromToken(tok, env) {
  if (!tok) return null;
  if (env.SESSION_SECRET) { const s = await verifySession(tok, env.SESSION_SECRET); if (s) return s.scope; }
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
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(targetYear, targetMonth, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

const md5 = (s) => createHash("md5").update(String(s), "utf8").digest("hex").toUpperCase();

// 微信支付 V2 的 XML + MD5 签名。委托代扣申请使用微信固定的 V2 官方地址。
export function wechatV2Sign(params, apiKey) {
  const q = Object.entries(params)
    .filter(([k, v]) => k !== "sign" && v !== undefined && v !== null && v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return md5(`${q}&key=${apiKey}`);
}

export function wechatV2Xml(params, apiKey) {
  const signed = { ...params, sign: wechatV2Sign(params, apiKey) };
  return "<xml>" + Object.entries(signed).map(([k, v]) => `<${k}><![CDATA[${String(v).replace(/]]>/g, "]]&gt;")}]]></${k}>`).join("") + "</xml>";
}

// 仅接受平坦 XML；拒绝 DOCTYPE，避免实体展开。微信 V2 回调字段没有嵌套结构。
export function parseWechatXml(text) {
  const s = String(text || "");
  if (!s || /<!DOCTYPE|<!ENTITY/i.test(s)) return null;
  const out = {};
  for (const m of s.matchAll(/<([A-Za-z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g)) {
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(out, key)) return null;
    out[key] = (m[2] ?? m[3] ?? "").trim();
  }
  return Object.keys(out).length ? out : null;
}

export function verifyWechatV2(params, apiKey) {
  return !!(params && params.sign && wechatV2Sign(params, apiKey) === String(params.sign).toUpperCase());
}

function amountFen(env) {
  const n = Number(env.WECHAT_PAY_AMOUNT_FEN ?? 1990);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function ready(env) {
  return !!(env.USAGE && env.WECHAT_PAY_MCH_ID && env.WECHAT_PAY_APP_ID && env.WECHAT_PAY_PLAN_ID && env.WECHAT_PAY_API_V2_KEY && env.WECHAT_PAY_CALLBACK_BASE_URL && amountFen(env));
}

// 首次访问时把售卖开关初始化为开启，之后由 R2 中的显式 true/false 控制。R2 读、写或
// 解析异常时仍默认开启，避免临时存储故障把客户端订阅入口误关掉。它仅阻止新签约，
// 不影响已有协议的续费、回调和状态查询。
export async function wechatPayEnabled(env) {
  try {
    const obj = env.FILES && await env.FILES.get(WECHAT_PAY_CONFIG_KEY);
    if (obj) return JSON.parse(await obj.text()).enabled === true;
    if (env.FILES && typeof env.FILES.put === "function") {
      await env.FILES.put(WECHAT_PAY_CONFIG_KEY, JSON.stringify({ enabled: true }), {
        httpMetadata: { contentType: "application/json" },
      });
    }
  } catch (e) {
    console.error("[wechat-pay] config/wechat-pay.json unavailable; default enabled:", e && e.message);
  }
  return true;
}

function publicOrigin(env, url) {
  return String(env.WECHAT_PAY_CALLBACK_BASE_URL).replace(/\/$/, "");
}

function precontractUrl(env) {
  return String(env.WECHAT_PAY_PRECONTRACT_URL || DEFAULT_PRECONTRACT_URL);
}

// 审计记录不保存可复用的签名/随机串；其余微信字段保留，才能把商户订单、微信订单、
// 协议状态与某一次 Cron/回调串起来排错。日志写入失败绝不能阻断真实支付流程。
function auditPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const copy = { ...payload };
  for (const k of ["sign", "nonce_str", "api_key", "key", "pre_entrustweb_id", "miniprogram_path"]) {
    if (k in copy) copy[k] = "[redacted]";
  }
  return JSON.stringify(copy).slice(0, 16_000);
}

async function audit(db, event) {
  try {
    await db.prepare(
      "INSERT INTO wechat_event (contract_code,out_trade_no,user_sub,direction,event_type,status_before,status_after,wechat_txn_id,code,message,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(event.contract_code || null, event.out_trade_no || null, event.user_sub || null,
      event.direction || "internal", event.event_type, event.status_before || null, event.status_after || null,
      event.wechat_txn_id || null, event.code || null, event.message ? String(event.message).slice(0, 512) : null,
      auditPayload(event.payload), event.now).run();
  } catch (e) { console.log("[wechat-pay] audit failed", String(e && e.message || e)); }
}

function tradeNo(contractCode, periodStart) {
  // 微信商户订单号最多 32 字符。输入稳定，重跑 Cron / 网络重试一定还是同一订单号。
  return "wd" + md5(`${contractCode}:${periodStart}`).slice(0, 30).toLowerCase();
}

function contractCode(now, random = null) {
  const r = random || (() => crypto.getRandomValues(new Uint32Array(2)));
  const a = r();
  const n = Array.isArray(a) || ArrayBuffer.isView(a) ? Array.from(a).map((x) => Number(x).toString(36)).join("") : Number(a).toString(36);
  return `wdc${Number(now).toString(36)}${n}`.slice(0, 64);
}

function callbackData(params) {
  return params && params.return_code === "SUCCESS" && params.result_code === "SUCCESS";
}

function requestSerial(now) {
  // 13 位毫秒时间 + 5 位随机数，始终是非零、未超 int64 上限的纯数字。
  const random = crypto.getRandomValues(new Uint32Array(1))[0] % 100000;
  return `${Math.floor(Number(now))}${String(random).padStart(5, "0")}`;
}

function contractResponse(contractCode, provider, expiresAt) {
  // 这是唯一给 Android 的签约数据：不泄露商户号、模板、回调地址、签名、密钥或微信完整响应。
  return J({
    ok: true,
    contract_code: contractCode,
    pre_entrustweb_id: provider.pre_entrustweb_id,
    wechat_mini_program_username: provider.miniprogram_username || null,
    wechat_mini_program_path: provider.miniprogram_path || null,
    expires_at: expiresAt,
  });
}

async function postPrecontract(env, sub, now, origin, fetcher, requestSerialValue) {
  const payload = {
    appid: env.WECHAT_PAY_APP_ID,
    mch_id: env.WECHAT_PAY_MCH_ID,
    plan_id: sub.plan_id,
    contract_code: sub.contract_code,
    request_serial: requestSerialValue,
    contract_display_account: String(env.WECHAT_PAY_CONTRACT_DISPLAY_ACCOUNT || "VoiceDrop 包月算力").slice(0, 128),
    notify_url: `${origin}/agent/wechat-pay/contract-notify`,
    version: "1.0",
    sign_type: "MD5",
    timestamp: String(Math.floor(now / 1000)),
    return_app: "Y",
  };
  const response = await fetcher(precontractUrl(env), {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: wechatV2Xml(payload, env.WECHAT_PAY_API_V2_KEY),
  });
  const body = parseWechatXml(await response.text());
  if (!response.ok || !callbackData(body) || !verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY)) {
    const code = body && (body.err_code || body.return_code || body.result_code) || `http-${response.status}`;
    const message = body && (body.err_code_des || body.return_msg || body.err_code) || "wechat-precontract-failed";
    throw Object.assign(new Error(message), { code, provider: body });
  }
  if (body.appid !== env.WECHAT_PAY_APP_ID || body.mch_id !== env.WECHAT_PAY_MCH_ID || !body.pre_entrustweb_id) {
    throw Object.assign(new Error("wechat-precontract-invalid-response"), { code: "invalid-provider-response", provider: body });
  }
  return body;
}

async function postApply(env, txn, sub, fetcher, origin) {
  const payload = {
    appid: env.WECHAT_PAY_APP_ID,
    mch_id: env.WECHAT_PAY_MCH_ID,
    nonce_str: md5(`${txn.out_trade_no}:${txn.attempt_count}:${Date.now()}`).slice(0, 32).toLowerCase(),
    body: "VoiceDrop 包月算力",
    out_trade_no: txn.out_trade_no,
    total_fee: txn.amount_fen,
    fee_type: "CNY",
    notify_url: `${origin}/agent/wechat-pay/pay-notify`,
    contract_id: sub.contract_id,
    plan_id: txn.plan_id,
    attach: JSON.stringify({ provider: "wechat", contract_code: txn.contract_code, period_start_at: txn.period_start_at }),
  };
  const response = await fetcher(APPLY_URL, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: wechatV2Xml(payload, env.WECHAT_PAY_API_V2_KEY),
  });
  const body = parseWechatXml(await response.text());
  if (!response.ok || !callbackData(body)) {
    const code = body && (body.err_code || body.return_code || body.result_code) || `http-${response.status}`;
    const message = body && (body.err_code_des || body.return_msg || body.err_code) || "wechat-apply-failed";
    throw Object.assign(new Error(message), { code });
  }
  return body;
}

// 回调是最快的状态同步路径，但微信并不保证回调最终送达。每一次可能扣款前，
// 都以微信查询结果为准：0=已签约，1=已解约，9=签约进行中（均为 V2 contract_state）。
async function queryWechatContract(env, sub, fetcher) {
  const payload = {
    appid: env.WECHAT_PAY_APP_ID,
    mch_id: env.WECHAT_PAY_MCH_ID,
    contract_id: sub.contract_id,
    version: "1.0",
  };
  const response = await fetcher(QUERY_CONTRACT_URL, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: wechatV2Xml(payload, env.WECHAT_PAY_API_V2_KEY),
  });
  const body = parseWechatXml(await response.text());
  if (!response.ok || !callbackData(body) || !verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY)) {
    const code = body && (body.err_code || body.return_code || body.result_code) || `http-${response.status}`;
    throw Object.assign(new Error(body && (body.err_code_des || body.return_msg) || "wechat-contract-query-failed"), { code, provider: body });
  }
  if (body.appid !== env.WECHAT_PAY_APP_ID || body.mch_id !== env.WECHAT_PAY_MCH_ID
      || body.contract_id !== sub.contract_id || (body.plan_id && body.plan_id !== sub.plan_id)
      || (body.contract_code && body.contract_code !== sub.contract_code)) {
    throw Object.assign(new Error("wechat-contract-query-invalid-response"), { code: "invalid-provider-response", provider: body });
  }
  const state = String(body.contract_state || "");
  if (!['0', '1', '9'].includes(state)) {
    throw Object.assign(new Error("wechat-contract-query-unknown-state"), { code: "unknown-contract-state", provider: body });
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
    contract_id: sub.contract_id,
    contract_termination_remark: "用户在 VoiceDrop App 解除自动续费",
    version: "1.0",
  };
  const response = await fetcher(TERMINATE_CONTRACT_URL, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=utf-8" },
    body: wechatV2Xml(payload, env.WECHAT_PAY_API_V2_KEY),
  });
  const body = parseWechatXml(await response.text());
  if (!response.ok || !callbackData(body) || !verifyWechatV2(body, env.WECHAT_PAY_API_V2_KEY)) {
    const code = body && (body.err_code || body.return_code || body.result_code) || `http-${response.status}`;
    throw Object.assign(new Error(body && (body.err_code_des || body.return_msg) || "wechat-contract-termination-failed"), { code, provider: body });
  }
  if (body.appid !== env.WECHAT_PAY_APP_ID || body.mch_id !== env.WECHAT_PAY_MCH_ID
      || (body.contract_id && body.contract_id !== sub.contract_id)) {
    throw Object.assign(new Error("wechat-contract-termination-invalid-response"), { code: "invalid-provider-response", provider: body });
  }
  return body;
}

async function markWechatContractCancelled(db, sub, now, reason, eventType, payload, message = null, direction = "inbound") {
  // charging 的申请已经被微信受理，最终仍可能成功回调；只终止尚未提交给微信的订单。
  await db.prepare(
    "UPDATE wechat_sub SET status='cancelled', next_charge_at=NULL, cancel_reason=?, cancelled_at=COALESCE(cancelled_at,?), last_event_at=?, last_error_code=NULL, updated_at=? WHERE contract_code=?"
  ).bind(reason, now, now, now, sub.contract_code).run();
  await db.prepare(
    "UPDATE wechat_txn SET status='failed', next_try_at=NULL, failure_code='contract-terminated', last_error_at=?, updated_at=? WHERE contract_code=? AND status IN ('pending','failed')"
  ).bind(now, now, sub.contract_code).run();
  await audit(db, { now, direction, event_type: eventType, contract_code: sub.contract_code,
    user_sub: sub.user_sub, status_before: sub.status, status_after: "cancelled", message, payload });
}

async function reconcileWechatContract(db, env, sub, now, fetcher) {
  try {
    const { state, body } = await queryWechatContract(env, sub, fetcher);
    if (state === "0") return { active: true };
    if (state === "1") {
      // 已经送到微信的 charging 订单仍可能异步回调成功，不能篡改它；只停止尚未申请的订单。
      const reason = "wechat-query-terminated";
      await markWechatContractCancelled(db, sub, now, reason, "contract_reconciled_cancelled", body,
        body.contract_termination_remark || reason, "outbound");
      return { cancelled: true };
    }
    // 9=签约进行中：不能把它当作已生效协议扣款；等待下一次 Cron 再对账。
    await audit(db, { now, direction: "outbound", event_type: "contract_reconcile_pending", contract_code: sub.contract_code,
      user_sub: sub.user_sub, status_before: "active", status_after: "active", code: "contract-state-9", payload: body });
    return { pending: true };
  } catch (e) {
    // 查询异常时宁可延后一期申请，也不在协议真实状态未知时触发扣款。
    await audit(db, { now, direction: "outbound", event_type: "contract_reconcile_failed", contract_code: sub.contract_code,
      user_sub: sub.user_sub, status_before: "active", status_after: "active",
      code: String(e.code || "contract-query-failed").slice(0, 64), message: e.message, payload: e.provider });
    return { unknown: true };
  }
}

async function requestCharge(db, env, txn, sub, now, fetcher, origin) {
  if (!txn || !["pending", "failed"].includes(txn.status)) return { skipped: true };
  try {
    const providerResponse = await postApply(env, txn, sub, fetcher, origin);
    await db.prepare(
      "UPDATE wechat_txn SET status='charging', charge_requested_at=?, next_try_at=NULL, attempt_count=attempt_count+1, failure_code=NULL, last_error_at=NULL, updated_at=? WHERE out_trade_no=?"
    ).bind(now, now, txn.out_trade_no).run();
    await db.prepare("UPDATE wechat_sub SET last_event_at=?, last_error_code=NULL, updated_at=? WHERE contract_code=?")
      .bind(now, now, txn.contract_code).run();
    await audit(db, { now, direction: "outbound", event_type: "charge_requested", contract_code: txn.contract_code,
      out_trade_no: txn.out_trade_no, user_sub: txn.user_sub, status_before: txn.status, status_after: "charging", payload: providerResponse });
    return { charged: true };
  } catch (e) {
    const attempts = Number(txn.attempt_count || 0) + 1;
    // 上限 1 小时，保留同一 out_trade_no，微信侧也可自然幂等。
    const delay = Math.min(RETRY_MS * (2 ** Math.min(attempts - 1, 4)), 60 * 60 * 1000);
    await db.prepare(
      "UPDATE wechat_txn SET status='failed', next_try_at=?, attempt_count=?, failure_code=?, last_error_at=?, updated_at=? WHERE out_trade_no=?"
    ).bind(now + delay, attempts, String(e.code || "apply-failed").slice(0, 64), now, now, txn.out_trade_no).run();
    await db.prepare("UPDATE wechat_sub SET last_event_at=?, last_error_code=?, updated_at=? WHERE contract_code=?")
      .bind(now, String(e.code || "apply-failed").slice(0, 64), now, txn.contract_code).run();
    await audit(db, { now, direction: "outbound", event_type: "charge_request_failed", contract_code: txn.contract_code,
      out_trade_no: txn.out_trade_no, user_sub: txn.user_sub, status_before: txn.status, status_after: "failed", code: e.code, message: e.message });
    return { failed: true, error: String(e.code || e.message || e) };
  }
}

async function createDueTransaction(db, sub, env, now) {
  // period_end_at 为空表示新协议尚无已付款周期；其首期起点由 next_charge_at + 24h 推导。
  const start = Number(sub.period_end_at ?? (sub.next_charge_at != null ? Number(sub.next_charge_at) + CHARGE_LEAD_MS : now));
  const end = addCalendarMonth(start);
  const outTradeNo = tradeNo(sub.contract_code, start);
  await db.prepare(
    "INSERT OR IGNORE INTO wechat_txn (out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,amount_fen,status,next_try_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(outTradeNo, sub.contract_code, sub.user_sub, sub.plan_id, start, end, amountFen(env), "pending", now, now, now).run();
  return await db.prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?").bind(outTradeNo).first();
}

async function settlePayment(db, txn, values, now) {
  if (txn.status === "paid") return { ok: true, already: true };
  const lock = await db.prepare(
    "UPDATE wechat_txn SET status='settling', processing_at=?, updated_at=? WHERE out_trade_no=? AND status IN ('pending','failed','charging')"
  ).bind(now, now, txn.out_trade_no).run();
  if (!(lock && lock.meta && lock.meta.changes === 1)) return { ok: true, already: true };

  try {
    // 微信周期严格截止于自然月端点；扣款申请已在该端点前 24 小时发起，
    // 不额外赠送订阅算力的有效期。
    await grantBucket(db, txn.user_sub, suanliToUY(SUB_GRANT_SUANLI), "subscription", txn.period_end_at, now,
      { provider: "wechat", out_trade_no: txn.out_trade_no, transaction_id: values.transaction_id || null });
    const bucket = await db.prepare(
      "SELECT id FROM bucket WHERE user_sub=? AND source='subscription' ORDER BY id DESC LIMIT 1"
    ).bind(txn.user_sub).first();
    await db.prepare(
      "UPDATE wechat_txn SET status='paid', wechat_txn_id=?, bucket_id=?, paid_at=?, last_callback_at=?, processing_at=NULL, next_try_at=NULL, updated_at=? WHERE out_trade_no=?"
    ).bind(values.transaction_id || null, bucket && bucket.id || null, now, now, now, txn.out_trade_no).run();
    // 解约与支付结果回调可能交错到达。此处必须原子地保留已解约状态：实际扣款
    // 成功仍应给本期算力，但绝不能把 cancelled 协议重新激活或恢复下一次自动扣款。
    await db.prepare(
      "UPDATE wechat_sub SET status=CASE WHEN status='cancelled' THEN 'cancelled' ELSE 'active' END, period_start_at=?, period_end_at=?, next_charge_at=CASE WHEN status='cancelled' THEN NULL ELSE ? END, last_event_at=?, last_error_code=NULL, updated_at=? WHERE contract_code=?"
    ).bind(txn.period_start_at, txn.period_end_at, Math.max(now, txn.period_end_at - CHARGE_LEAD_MS), now, now, txn.contract_code).run();
    await audit(db, { now, direction: "inbound", event_type: "payment_settled", contract_code: txn.contract_code,
      out_trade_no: txn.out_trade_no, user_sub: txn.user_sub, status_before: "settling", status_after: "paid",
      wechat_txn_id: values.transaction_id, payload: values });
    return { ok: true, granted: true };
  } catch (e) {
    await db.prepare(
      "UPDATE wechat_txn SET status='failed', processing_at=NULL, next_try_at=?, failure_code='settle-failed', last_error_at=?, updated_at=? WHERE out_trade_no=?"
    ).bind(now + RETRY_MS, now, now, txn.out_trade_no).run();
    await audit(db, { now, direction: "internal", event_type: "payment_settle_failed", contract_code: txn.contract_code,
      out_trade_no: txn.out_trade_no, user_sub: txn.user_sub, status_before: "settling", status_after: "failed", message: e.message });
    throw e;
  }
}

// Worker 的 15 分钟 Cron 调用。首期由签约回调立即发起；这里仅处理后续周期和
// pending/failed 重试。每次可能扣款前先查询微信协议，避免漏掉解约回调后继续申请。
// 支付成功的最终入账始终由微信回调完成。
export async function runWechatPaySchedule(env, now = Date.now(), fetcher = fetch, origin = null) {
  if (!ready(env)) return { skipped: "degraded" };
  const db = env.USAGE;
  const base = origin || publicOrigin(env);
  const result = { created: 0, requested: 0, failed: 0, cancelled: 0, deferred: 0 };
  const contractChecks = new Map();
  const reconcile = async (sub) => {
    if (!contractChecks.has(sub.contract_code)) {
      contractChecks.set(sub.contract_code, reconcileWechatContract(db, env, sub, now, fetcher));
    }
    return contractChecks.get(sub.contract_code);
  };

  // 在一次 Worker 中断后的恢复：若已写 ledger，绝不再发钱；否则回到可重试状态。
  const stale = (await db.prepare(
    "SELECT * FROM wechat_txn WHERE status='settling' AND processing_at<? LIMIT 50"
  ).bind(now - STALE_SETTLING_MS).all()).results;
  for (const txn of stale) {
    const granted = await db.prepare(
      "SELECT id FROM ledger WHERE reason='subscription' AND json_extract(detail,'$.out_trade_no')=? LIMIT 1"
    ).bind(txn.out_trade_no).first();
    if (granted) {
      const bucket = await db.prepare("SELECT id FROM bucket WHERE user_sub=? AND source='subscription' ORDER BY id DESC LIMIT 1").bind(txn.user_sub).first();
      await db.prepare("UPDATE wechat_txn SET status='paid', bucket_id=?, paid_at=COALESCE(paid_at,?), processing_at=NULL, updated_at=? WHERE out_trade_no=?")
        .bind(bucket && bucket.id || null, now, now, txn.out_trade_no).run();
    } else {
      await db.prepare("UPDATE wechat_txn SET status='failed', processing_at=NULL, next_try_at=?, updated_at=? WHERE out_trade_no=?")
        .bind(now, now, txn.out_trade_no).run();
    }
  }

  const due = (await db.prepare(
    "SELECT * FROM wechat_sub WHERE status='active' AND contract_id IS NOT NULL AND next_charge_at IS NOT NULL AND next_charge_at<=? LIMIT 50"
  ).bind(now).all()).results;
  for (const sub of due) {
    const check = await reconcile(sub);
    if (!check.active) {
      if (check.cancelled) result.cancelled++;
      else result.deferred++;
      continue;
    }
    await createDueTransaction(db, sub, env, now);
    if (sub.period_end_at == null) {
      await db.prepare("UPDATE wechat_sub SET next_charge_at=NULL, updated_at=? WHERE contract_code=?")
        .bind(now, sub.contract_code).run();
    }
    result.created++;
  }
  const pending = (await db.prepare(
    "SELECT t.*, s.contract_id, s.plan_id FROM wechat_txn t JOIN wechat_sub s ON s.contract_code=t.contract_code WHERE t.status IN ('pending','failed') AND t.next_try_at<=? AND s.status='active' LIMIT 50"
  ).bind(now).all()).results;
  for (const txn of pending) {
    const sub = { contract_code: txn.contract_code, contract_id: txn.contract_id, plan_id: txn.plan_id, user_sub: txn.user_sub };
    const check = await reconcile(sub);
    if (!check.active) {
      if (check.cancelled) result.cancelled++;
      else result.deferred++;
      continue;
    }
    const r = await requestCharge(db, env, txn, sub, now, fetcher, base);
    if (r.charged) result.requested++;
    if (r.failed) result.failed++;
  }
  return result;
}

export async function handleWechatPayRoute(url, request, env, fetcher = fetch, now = Date.now(), ctx = null) {
  if (!url.pathname.startsWith("/agent/wechat-pay/")) return null;
  try {
    if (url.pathname === "/agent/wechat-pay/contract" && request.method === "POST") {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!ready(env)) return J({ error: "degraded" }, 503);
      // Android/微信入口只要已有有效 iOS 订阅就不允许再起签约，避免用户在 Android
      // 正常路径下获得第二份包月。反方向的 App Store 成交由 iOS 客户端购买前查询拦截。
      if (await activeIapSubscription(env.USAGE, scope, now)) return J({ error: "already-subscribed" }, 409);
      // 同一用户在旧协议仍生效时不能再开一份，避免双协议并行扣费；收到微信解约回调后，
      // 旧行保留为 cancelled，新签约会生成全新的 contract_code，历史完整可追溯。
      const active = await env.USAGE.prepare(
        "SELECT contract_code, contract_id FROM wechat_sub WHERE user_sub=? AND status='active' ORDER BY updated_at DESC LIMIT 1"
      ).bind(scope).first();
      if (active) return J({ error: "already-subscribed" }, 409);
      let sub = await env.USAGE.prepare(
        "SELECT * FROM wechat_sub WHERE user_sub=? AND status='pending' ORDER BY updated_at DESC LIMIT 1"
      ).bind(scope).first();
      if (!sub) {
        if (!await wechatPayEnabled(env)) return J({ error: "disabled" }, 403);
        let code = null;
        for (let i = 0; i < 3; i++) {
          const candidate = contractCode(now, () => crypto.getRandomValues(new Uint32Array(2)));
          const ins = await env.USAGE.prepare(
            "INSERT OR IGNORE INTO wechat_sub (contract_code,user_sub,plan_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)"
          ).bind(candidate, scope, env.WECHAT_PAY_PLAN_ID, "pending", now, now).run();
          if (ins && ins.meta && ins.meta.changes === 1) { code = candidate; break; }
        }
        if (!code) return J({ error: "contract-unavailable" }, 503);
        sub = await env.USAGE.prepare("SELECT * FROM wechat_sub WHERE contract_code=?").bind(code).first();
        await audit(env.USAGE, { now, direction: "internal", event_type: "contract_created", contract_code: code,
          user_sub: scope, status_after: "pending", payload: { plan_id: env.WECHAT_PAY_PLAN_ID } });
      }
      const origin = publicOrigin(env, url);
      const serial = requestSerial(now);
      try {
        const provider = await postPrecontract(env, sub, now, origin, fetcher, serial);
        const expiresAt = now + PRE_ENTRUST_TTL_MS;
        await env.USAGE.prepare("UPDATE wechat_sub SET last_error_code=NULL, updated_at=? WHERE contract_code=?")
          .bind(now, sub.contract_code).run();
        await audit(env.USAGE, { now, direction: "outbound", event_type: "precontract_created", contract_code: sub.contract_code,
          user_sub: scope, status_before: "pending", status_after: "pending",
          payload: { request_serial: serial, has_mini_program: !!(provider.miniprogram_username && provider.miniprogram_path) } });
        // 会话只经本次 HTTPS 响应交给已认证 Android，不持久化到 D1。
        return contractResponse(sub.contract_code, provider, expiresAt);
      } catch (e) {
        const code = String(e.code || "precontract-failed").slice(0, 64);
        await env.USAGE.prepare("UPDATE wechat_sub SET last_error_code=?, last_event_at=?, updated_at=? WHERE contract_code=?")
          .bind(code, now, now, sub.contract_code).run();
        await audit(env.USAGE, { now, direction: "outbound", event_type: "precontract_failed", contract_code: sub.contract_code,
          user_sub: scope, status_before: "pending", status_after: "pending", code, message: e.message, payload: e.provider });
        // Android 不应看到微信的原始失败文本、请求参数或签名材料。
        return J({ error: "contract-unavailable" }, 502);
      }
    }

    if (url.pathname === "/agent/wechat-pay/contract-notify" && request.method === "POST") {
      if (!ready(env)) return xmlReply("SUCCESS", "DEGRADED");
      const values = parseWechatXml(await request.text());
      if (!verifyWechatV2(values, env.WECHAT_PAY_API_V2_KEY)) return xmlReply("FAIL", "BAD SIGN");
      if (!callbackData(values)) return xmlReply("SUCCESS", "IGNORED");
      const code = values.contract_code || values.out_contract_code;
      const contractId = values.contract_id || values.contract_no;
      if (!code || !contractId) return xmlReply("FAIL", "MISSING CONTRACT");
      const sub = await env.USAGE.prepare("SELECT * FROM wechat_sub WHERE contract_code=?").bind(code).first();
      if (!sub || (values.plan_id && values.plan_id !== sub.plan_id)) return xmlReply("FAIL", "UNKNOWN CONTRACT");
      if (sub.contract_id && sub.contract_id !== contractId) return xmlReply("FAIL", "CONTRACT CONFLICT");
      // 已取消的旧协议仍有已付款周期时，新周期严格从旧周期端点开始。首期申请
      // 固定安排在该端点前 24h；若用户重新签约时已过该时间，直接申请并让这笔
      // 已实际付款的算力即时到账，避免空窗。这样最多只是短暂存在两笔可用算力。
      const previous = await env.USAGE.prepare(
        "SELECT period_end_at FROM wechat_sub WHERE user_sub=? AND contract_code<>? AND status='cancelled' AND period_end_at>? ORDER BY period_end_at DESC LIMIT 1"
      ).bind(sub.user_sub, code, now).first();
      const initialStart = previous && Number(previous.period_end_at) || null;
      const nextChargeAt = initialStart == null ? now : initialStart - CHARGE_LEAD_MS;
      await env.USAGE.prepare(
        "UPDATE wechat_sub SET contract_id=?, openid=?, status='active', period_start_at=NULL, period_end_at=?, next_charge_at=?, signed_at=?, last_event_at=?, last_error_code=NULL, updated_at=? WHERE contract_code=?"
      ).bind(contractId, values.openid || null, initialStart == null ? now : null, nextChargeAt,
        now, now, now, code).run();
      await audit(env.USAGE, { now, direction: "inbound", event_type: "contract_signed", contract_code: code,
        user_sub: sub.user_sub, status_before: sub.status, status_after: "active", payload: values });
      // 首期不等 15 分钟 Cron：签约已确认后立刻申请扣款。waitUntil 让微信回调快速
      // 得到 ACK；网络失败会把同一订单标为 failed，之后由独立的 15 分钟 Cron 兜底重试。
      // 没有 ctx 的纯函数调用（例如旧测试/离线脚本）不触发网络副作用。
      if (ctx && typeof ctx.waitUntil === "function" && nextChargeAt <= now) {
        const activeSub = { ...sub, contract_id: contractId, status: "active", period_end_at: initialStart == null ? now : null, next_charge_at: nextChargeAt };
        const initialCharge = (async () => {
          const txn = await createDueTransaction(env.USAGE, activeSub, env, now);
          if (initialStart != null) {
            await env.USAGE.prepare("UPDATE wechat_sub SET next_charge_at=NULL, updated_at=? WHERE contract_code=?")
              .bind(now, code).run();
          }
          await audit(env.USAGE, { now, direction: "internal", event_type: "initial_charge_triggered",
            contract_code: code, out_trade_no: txn.out_trade_no, user_sub: sub.user_sub,
            status_before: "pending", status_after: txn.status });
          await requestCharge(env.USAGE, env, txn, activeSub, now, fetcher, publicOrigin(env, url));
        })();
        ctx.waitUntil(initialCharge.catch((e) => console.log("[wechat-pay] initial charge failed", String(e && e.message || e))));
      }
      return xmlReply("SUCCESS", "OK");
    }

    if (url.pathname === "/agent/wechat-pay/pay-notify" && request.method === "POST") {
      if (!ready(env)) return xmlReply("SUCCESS", "DEGRADED");
      const values = parseWechatXml(await request.text());
      if (!verifyWechatV2(values, env.WECHAT_PAY_API_V2_KEY)) return xmlReply("FAIL", "BAD SIGN");
      const txn = await env.USAGE.prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?").bind(values.out_trade_no || "").first();
      if (!txn) return xmlReply("FAIL", "ORDER MISMATCH");
      // 失败通知通常没有 total_fee；成功通知则必须金额完全一致才能入账。
      if (callbackData(values) && Number(values.total_fee) !== Number(txn.amount_fen)) return xmlReply("FAIL", "ORDER MISMATCH");
      if (!callbackData(values)) {
        await env.USAGE.prepare(
          "UPDATE wechat_txn SET status='failed', next_try_at=?, failure_code=?, last_error_at=?, last_callback_at=?, updated_at=? WHERE out_trade_no=? AND status!='paid'"
        ).bind(now + 60 * 60 * 1000, String(values.err_code || values.result_code || "payment-failed").slice(0, 64), now, now, now, txn.out_trade_no).run();
        await env.USAGE.prepare("UPDATE wechat_sub SET last_event_at=?, last_error_code=?, updated_at=? WHERE contract_code=?")
          .bind(now, String(values.err_code || values.result_code || "payment-failed").slice(0, 64), now, txn.contract_code).run();
        await audit(env.USAGE, { now, direction: "inbound", event_type: "payment_failed", contract_code: txn.contract_code,
          out_trade_no: txn.out_trade_no, user_sub: txn.user_sub, status_before: txn.status, status_after: "failed",
          code: values.err_code || values.result_code, message: values.err_code_des || values.return_msg, payload: values });
        return xmlReply("SUCCESS", "RECORDED");
      }
      const sub = await env.USAGE.prepare("SELECT contract_id FROM wechat_sub WHERE contract_code=?").bind(txn.contract_code).first();
      if (!sub || (values.contract_id && values.contract_id !== sub.contract_id)) return xmlReply("FAIL", "CONTRACT MISMATCH");
      await settlePayment(env.USAGE, txn, values, now);
      return xmlReply("SUCCESS", "OK");
    }

    if (url.pathname === "/agent/wechat-pay/cancel-notify" && request.method === "POST") {
      if (!ready(env)) return xmlReply("SUCCESS", "DEGRADED");
      const values = parseWechatXml(await request.text());
      if (!verifyWechatV2(values, env.WECHAT_PAY_API_V2_KEY)) return xmlReply("FAIL", "BAD SIGN");
      if (!callbackData(values)) return xmlReply("SUCCESS", "IGNORED");
      const code = values.contract_code || values.out_contract_code;
      const id = values.contract_id || values.contract_no;
      const row = await env.USAGE.prepare("SELECT * FROM wechat_sub WHERE contract_code=?").bind(code || "").first();
      if (!row || (id && row.contract_id !== id)) return xmlReply("FAIL", "UNKNOWN CONTRACT");
      const reason = values.cancel_reason || values.contract_status || "wechat-cancelled";
      await markWechatContractCancelled(env.USAGE, row, now, reason, "contract_cancelled", values, reason);
      return xmlReply("SUCCESS", "OK");
    }

    if (url.pathname === "/agent/wechat-pay/cancel" && request.method === "POST") {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!ready(env)) return J({ error: "degraded" }, 503);
      const sub = await env.USAGE.prepare(
        "SELECT * FROM wechat_sub WHERE user_sub=? AND status='active' AND contract_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1"
      ).bind(scope).first();
      // 网络重试必须安全：已经成功解约就直接返回成功，不能把旧记录当成错误。
      if (!sub) {
        const last = await env.USAGE.prepare(
          "SELECT status,period_end_at FROM wechat_sub WHERE user_sub=? ORDER BY updated_at DESC LIMIT 1"
        ).bind(scope).first();
        if (last && last.status === "cancelled") return J({ ok: true, status: "cancelled", already: true, expires_date: last.period_end_at || null });
        return J({ error: "no-active-contract" }, 409);
      }
      try {
        const provider = await terminateWechatContract(env, sub, fetcher);
        await markWechatContractCancelled(env.USAGE, sub, now, "user-cancelled-in-app", "contract_cancelled_by_user", provider,
          "用户在 App 解除自动续费", "outbound");
        return J({ ok: true, status: "cancelled", expires_date: sub.period_end_at || null });
      } catch (e) {
        await env.USAGE.prepare("UPDATE wechat_sub SET last_event_at=?, last_error_code=?, updated_at=? WHERE contract_code=?")
          .bind(now, String(e.code || "contract-termination-failed").slice(0, 64), now, sub.contract_code).run();
        await audit(env.USAGE, { now, direction: "outbound", event_type: "contract_cancel_failed", contract_code: sub.contract_code,
          user_sub: scope, status_before: sub.status, status_after: sub.status,
          code: e.code, message: e.message, payload: e.provider });
        return J({ error: "cancel-unavailable" }, 502);
      }
    }

    if (url.pathname === "/agent/wechat-pay/status" && request.method === "GET") {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!env.USAGE) return J({ active: false, degraded: true });
      const row = await env.USAGE.prepare(
        "SELECT contract_code, contract_id, plan_id, status, period_end_at, next_charge_at, cancel_reason, signed_at, cancelled_at, last_error_code FROM wechat_sub WHERE user_sub=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1"
      ).bind(scope).first();
      // 新签约的首期可能尚未扣款，此时用户的当前权益仍来自已取消的旧周期；
      // 因此权益到期日不能只看当前协议行。
      const coverage = await env.USAGE.prepare(
        "SELECT MAX(period_end_at) AS expires_date FROM wechat_sub WHERE user_sub=? AND status IN ('active','cancelled') AND period_end_at>?"
      ).bind(scope, now).first();
      const expiresAt = coverage && coverage.expires_date || row && row.period_end_at || null;
      const active = Number(expiresAt || 0) > now;
      const sum = active ? await env.USAGE.prepare(
        "SELECT COALESCE(SUM(remaining_uy),0) AS s FROM bucket WHERE user_sub=? AND source='subscription' AND (expires_at IS NULL OR expires_at>?)"
      ).bind(scope, now).first() : { s: 0 };
      return J({ active, enabled: await wechatPayEnabled(env), can_cancel: !!(row && row.status === "active" && row.contract_id), status: row ? row.status : null, plan_id: row ? row.plan_id : null,
        expires_date: expiresAt,
        scheduled_charge_at: row && row.period_end_at == null ? row.next_charge_at : null,
        cancel_reason: row ? row.cancel_reason : null,
        signed_at: row ? row.signed_at : null, cancelled_at: row ? row.cancelled_at : null,
        // 原始微信错误码/文本只留在 D1 的 wechat_sub / wechat_txn / wechat_event，
        // 客户端只得到稳定、可展示的通用状态，避免暴露支付通道内部信息。
        payment_issue: row && row.last_error_code ? "payment-failed" : null,
        sub_suanli: Math.round(uyToSuanli(sum && sum.s || 0) * 10) / 10,
        monthly_suanli: SUB_GRANT_SUANLI });
    }

    return J({ error: "not-found" }, 404);
  } catch (e) {
    console.error("[wechat-pay]", String(e && e.stack || e));
    return J({ error: "server-error", message: String(e && e.message || e) }, 500);
  }
}
