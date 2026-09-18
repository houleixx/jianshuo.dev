// src/wechat-pay.js — 微信委托代扣（¥19.9/月 → 每月 200 算力）。
//
// 跟 iap.js 一样：支付渠道自己的表只保存「协议 / 订单」；实际算力一律走
// bucket + ledger。已验签的成功回调和查单结果共用原子入账入口，重复回调与 Cron 重试
// 都以用户周期为幂等键；每次明确失败后的替代扣款有独立、不可变的商户订单。
import { createHash } from "node:crypto";
import { SUB_GRANT_SUANLI, suanliToUY, uyToSuanli } from "./usage.js";
import { ensureAccount } from "./usage_store.js";
import { activeIapSubscription } from "./subscription-status.js";
import {
  verifySession,
  anonScopeFromToken,
  bearerToken,
} from "../../functions/lib/auth.js";

const DAY_MS = 86400000;
const HOUR_MS = 60 * 60 * 1000;
const CHARGE_LEAD_DAYS = 3;
const PRE_ENTRUST_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PRECONTRACT_URL =
  "https://api.mch.weixin.qq.com/papay/preentrustweb";
const APPLY_URL = "https://api.mch.weixin.qq.com/pay/pappayapply";
const QUERY_CONTRACT_URL = "https://api.mch.weixin.qq.com/papay/querycontract";
const TERMINATE_CONTRACT_URL =
  "https://api.mch.weixin.qq.com/papay/deletecontract";
const WECHAT_PAY_CONFIG_KEY = "config/wechat-pay.json";
const J = (x, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: { "content-type": "application/json" },
  });
const xmlReply = (code, message) =>
  new Response(
    `<xml><return_code><![CDATA[${code}]]></return_code><return_msg><![CDATA[${message}]]></return_msg></xml>`,
    { status: 200, headers: { "content-type": "text/xml; charset=utf-8" } },
  );

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

// 微信的「通知后 24 小时自动扣费」模板可全天发起申请。为了给失败留出两次
// 次日重试，续期申请固定在到期日前第 3 个北京时间自然日的 02:00 运行。
// 周期本身仍保存为 UTC epoch；这里只把调度时点按北京时间日历换算，避免受
// Worker 区域或夏令时（中国没有夏令时）影响。
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
  return md5(`${q}&key=${apiKey}`);
}

export function wechatV2Xml(params, apiKey) {
  const signed = { ...params, sign: wechatV2Sign(params, apiKey) };
  return (
    "<xml>" +
    Object.entries(signed)
      .map(
        ([k, v]) =>
          `<${k}><![CDATA[${String(v).replace(/]]>/g, "]]&gt;")}]]></${k}>`,
      )
      .join("") +
    "</xml>"
  );
}

// 仅接受平坦 XML；拒绝 DOCTYPE，避免实体展开。微信 V2 回调字段没有嵌套结构。
export function parseWechatXml(text) {
  const s = String(text || "");
  if (!s || /<!DOCTYPE|<!ENTITY/i.test(s)) return null;
  const out = {};
  for (const m of s.matchAll(
    /<([A-Za-z0-9_]+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g,
  )) {
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(out, key)) return null;
    out[key] = (m[2] ?? m[3] ?? "").trim();
  }
  return Object.keys(out).length ? out : null;
}

export function verifyWechatV2(params, apiKey) {
  return !!(
    params &&
    params.sign &&
    wechatV2Sign(params, apiKey) === String(params.sign).toUpperCase()
  );
}

function amountFen(env) {
  const n = Number(env.WECHAT_PAY_AMOUNT_FEN ?? 1990);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function ready(env) {
  // 当前扣款流程固定使用「通知后 24 小时自动扣费」模板，不另设模式开关。
  return !!(
    env.USAGE &&
    env.WECHAT_PAY_MCH_ID &&
    env.WECHAT_PAY_APP_ID &&
    env.WECHAT_PAY_PLAN_ID &&
    env.WECHAT_PAY_API_V2_KEY &&
    env.WECHAT_PAY_CALLBACK_BASE_URL &&
    amountFen(env)
  );
}

// 首次访问时把售卖开关初始化为开启，之后由 R2 中的显式 true/false 控制。R2 读、写或
// 解析异常时仍默认开启，避免临时存储故障把客户端订阅入口误关掉。它仅阻止新签约，
// 不影响已有协议的续费、回调和状态查询。
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

function precontractUrl(env) {
  return String(env.WECHAT_PAY_PRECONTRACT_URL || DEFAULT_PRECONTRACT_URL);
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
    "pre_entrustweb_id",
    "miniprogram_path",
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
    "wd" + md5(`${contractCode}:${periodStart}`).slice(0, 30).toLowerCase()
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

function callbackData(params) {
  return (
    params &&
    params.return_code === "SUCCESS" &&
    params.result_code === "SUCCESS"
  );
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

async function postPrecontract(
  env,
  sub,
  now,
  origin,
  fetcher,
  requestSerialValue,
) {
  const payload = {
    appid: env.WECHAT_PAY_APP_ID,
    mch_id: env.WECHAT_PAY_MCH_ID,
    plan_id: sub.plan_id,
    contract_code: sub.contract_code,
    request_serial: requestSerialValue,
    contract_display_account: String(
      env.WECHAT_PAY_CONTRACT_DISPLAY_ACCOUNT || "VoiceDrop 包月算力",
    ).slice(0, 128),
    notify_url: `${origin}/agent/wechat-pay/contract-notify`,
    version: "1.0",
    sign_type: "MD5",
    timestamp: String(Math.floor(now / 1000)),
    return_app: "Y",
  };
  const response = await fetcher(precontractUrl(env), {
    method: "POST",
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
    const message =
      (body && (body.err_code_des || body.return_msg || body.err_code)) ||
      "wechat-precontract-failed";
    throw Object.assign(new Error(message), { code, provider: body });
  }
  if (
    body.appid !== env.WECHAT_PAY_APP_ID ||
    body.mch_id !== env.WECHAT_PAY_MCH_ID ||
    !body.pre_entrustweb_id
  ) {
    throw Object.assign(new Error("wechat-precontract-invalid-response"), {
      code: "invalid-provider-response",
      provider: body,
    });
  }
  return body;
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
    contract_id: sub.contract_id,
    version: "1.0",
  };
  const response = await fetcher(QUERY_CONTRACT_URL, {
    method: "POST",
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
    body.contract_id !== sub.contract_id ||
    (body.plan_id && body.plan_id !== sub.plan_id) ||
    (body.contract_code && body.contract_code !== sub.contract_code)
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
    contract_id: sub.contract_id,
    contract_termination_remark: "用户在 VoiceDrop App 解除自动续费",
    version: "1.0",
  };
  const response = await fetcher(TERMINATE_CONTRACT_URL, {
    method: "POST",
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
    (body.contract_id && body.contract_id !== sub.contract_id)
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
      "UPDATE wechat_sub SET status='cancelled', next_charge_at=NULL, cancel_reason=?, cancelled_at=COALESCE(cancelled_at,?), last_event_at=?, last_error_code=NULL, updated_at=? WHERE contract_code=?",
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

async function reconcileWechatContract(db, env, sub, now, fetcher) {
  try {
    const { state, body } = await queryWechatContract(env, sub, fetcher);
    if (state === "0") return { active: true };
    if (state === "1") {
      // 已经送到微信的 charging 订单仍可能异步回调成功，不能篡改它；只停止尚未申请的订单。
      const reason = "wechat-query-terminated";
      await markWechatContractCancelled(
        db,
        sub,
        now,
        reason,
        "contract_reconciled_cancelled",
        body,
        body.contract_termination_remark || reason,
        "outbound",
      );
      return { cancelled: true };
    }
    // 9=签约进行中：不能把它当作已生效协议扣款；等待下一次 Cron 再对账。
    await audit(db, {
      now,
      direction: "outbound",
      event_type: "contract_reconcile_pending",
      contract_code: sub.contract_code,
      user_sub: sub.user_sub,
      status_before: "active",
      status_after: "active",
      code: "contract-state-9",
      payload: body,
    });
    return { pending: true };
  } catch (e) {
    // 查询异常时宁可延后一期申请，也不在协议真实状态未知时触发扣款。
    await audit(db, {
      now,
      direction: "outbound",
      event_type: "contract_reconcile_failed",
      contract_code: sub.contract_code,
      user_sub: sub.user_sub,
      status_before: "active",
      status_after: "active",
      code: String(e.code || "contract-query-failed").slice(0, 64),
      message: e.message,
      payload: e.provider,
    });
    return { unknown: true };
  }
}

// Accepted and unknown requests keep their merchant order until a signed terminal result arrives.
const OPEN_ATTEMPTS = "('sending','unknown','accepted')";
const QUERY_INTERVAL = 15 * 60 * 1000;
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

async function unresolvedUserOrder(db, userSub) {
  return db
    .prepare(
      `SELECT a.out_trade_no FROM wechat_attempt a JOIN wechat_txn t ON t.out_trade_no=a.cycle_no WHERE t.user_sub=? AND a.status IN ('sending','unknown','accepted','refunded') LIMIT 1`,
    )
    .bind(userSub)
    .first();
}

async function requestCharge(db, env, txn, sub, now, fetcher, origin) {
  if (
    !txn ||
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
      AND EXISTS(SELECT 1 FROM wechat_sub WHERE contract_code=? AND status='active' AND next_charge_at<=?)
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
      "SELECT * FROM wechat_sub WHERE contract_code=? AND status='active' AND next_charge_at<=?",
    )
    .bind(sub.contract_code, now)
    .first();
  if (!sub) return null;
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
  const end = addCalendarMonth(start);
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
      amountFen(env),
      now,
      now,
      now,
    )
    .run();
  let txn = await db
    .prepare("SELECT * FROM wechat_txn WHERE user_sub=? AND period_start_at=?")
    .bind(sub.user_sub, start)
    .first();
  // An explicitly re-signed authorization may resume a terminally failed cycle; all previous attempts remain auditable.
  if (
    txn &&
    txn.contract_code !== sub.contract_code &&
    ["pending", "failed"].includes(txn.status)
  ) {
    await db
      .prepare(
        "UPDATE wechat_txn SET contract_code=?,status='pending',next_try_at=?,max_attempts=attempt_count+3,updated_at=? WHERE out_trade_no=? AND status IN ('pending','failed')",
      )
      .bind(sub.contract_code, now, now, txn.out_trade_no)
      .run();
    txn = await db
      .prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?")
      .bind(txn.out_trade_no)
      .first();
  }
  return txn;
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
    Number(values.total_fee) !== Number(txn.amount_fen)
  )
    throw new Error("payment-mismatch");
  if (txn.status === "paid") return { ok: true, already: true };
  const paidAt = paidTime(values.time_end, now);
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
        `UPDATE wechat_txn SET status='paid',wechat_txn_id=?,bucket_id=(SELECT id FROM bucket WHERE wechat_order=?),paid_at=?,last_callback_at=?,processing_at=NULL,next_try_at=NULL,failure_code=NULL,entitlement_start_at=?,entitlement_end_at=?,updated_at=? WHERE out_trade_no=? AND status!='paid'`,
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
        `UPDATE wechat_sub SET period_start_at=?,period_end_at=?,next_charge_at=CASE WHEN status='active' THEN ? ELSE NULL END,last_event_at=?,last_error_code=NULL,updated_at=?
      WHERE contract_code=? AND changes()=1 AND (period_start_at IS NULL OR period_end_at<=?)`,
      )
      .bind(
        start,
        end,
        wechatChargeScheduleAt(end),
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

async function reconcilePayment(db, env, attempt, now, fetcher) {
  const txn = await db
    .prepare("SELECT * FROM wechat_txn WHERE out_trade_no=?")
    .bind(attempt.cycle_no)
    .first();
  if (!txn || txn.status === "paid") return;
  try {
    const response = await fetcher(
      env.WECHAT_PAY_QUERY_MODE === "pap"
        ? "https://api.mch.weixin.qq.com/pay/paporderquery"
        : "https://api.mch.weixin.qq.com/pay/orderquery",
      {
        method: "POST",
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
          "SELECT * FROM wechat_sub WHERE contract_code=? AND status='active'",
        )
        .bind(attempt.contract_code)
        .first();
      // Recovery after commit-before-send. Re-send ONLY the same merchant order and original amount/authorization.
      // A missing order is never grounds for creating a replacement order under a new authorization.
      if (
        sub &&
        attempt.resubmit_count < 3 &&
        attempt.created_at + QUERY_INTERVAL <= now &&
        attempt.next_query_at <= now &&
        (await reconcileWechatContract(db, env, sub, now, fetcher)).active
      ) {
        const claimed = await db
          .prepare(
            "UPDATE wechat_attempt SET status='sending',resubmit_count=resubmit_count+1,next_query_at=?,updated_at=? WHERE out_trade_no=? AND status IN ('sending','unknown') AND next_query_at<=? AND resubmit_count<3",
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
      await settlePayment(db, txn, body, now);
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
  if (!ready(env)) return { skipped: "degraded" };
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
  if (reconcileOnly) return result;
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
      WHERE t.status IN ('pending','failed') AND t.next_try_at<=? AND t.attempt_count<t.max_attempts AND t.period_end_at>? AND s.status='active' AND t.out_trade_no>? ORDER BY t.out_trade_no LIMIT 50`,
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
    AND EXISTS(SELECT 1 FROM wechat_txn t WHERE t.contract_code=wechat_sub.contract_code AND t.status='failed' AND (t.attempt_count>=t.max_attempts OR t.period_end_at<=?))`,
    )
    .bind(now, now)
    .run();
  return result;
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
    if (
      url.pathname === "/agent/wechat-pay/contract" &&
      request.method === "POST"
    ) {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!ready(env)) return J({ error: "degraded" }, 503);
      // Android/微信入口只要已有有效 iOS 订阅就不允许再起签约，避免用户在 Android
      // 正常路径下获得第二份包月。反方向的 App Store 成交由 iOS 客户端购买前查询拦截。
      if (await activeIapSubscription(env.USAGE, scope, now))
        return J({ error: "already-subscribed" }, 409);
      const outstanding = (
        await env.USAGE.prepare(
          "SELECT a.* FROM wechat_attempt a JOIN wechat_txn t ON t.out_trade_no=a.cycle_no WHERE t.user_sub=? AND a.status IN ('sending','unknown','accepted')",
        )
          .bind(scope)
          .all()
      ).results;
      for (const a of outstanding)
        await reconcilePayment(env.USAGE, env, a, now, fetcher);
      if (await unresolvedUserOrder(env.USAGE, scope))
        return J({ error: "payment-pending" }, 409);
      // 同一用户在旧协议仍生效时不能再开一份，避免双协议并行扣费；收到微信解约回调后，
      // 旧行保留为 cancelled，新签约会生成全新的 contract_code，历史完整可追溯。
      const active = await env.USAGE.prepare(
        "SELECT contract_code, contract_id FROM wechat_sub WHERE user_sub=? AND status='active' ORDER BY updated_at DESC LIMIT 1",
      )
        .bind(scope)
        .first();
      if (active) return J({ error: "already-subscribed" }, 409);
      let sub = await env.USAGE.prepare(
        "SELECT * FROM wechat_sub WHERE user_sub=? AND status='pending' ORDER BY updated_at DESC LIMIT 1",
      )
        .bind(scope)
        .first();
      if (!sub) {
        if (!(await wechatPayEnabled(env)))
          return J({ error: "disabled" }, 403);
        let code = null;
        for (let i = 0; i < 3; i++) {
          const candidate = contractCode(now, () =>
            crypto.getRandomValues(new Uint32Array(2)),
          );
          const ins = await env.USAGE.prepare(
            "INSERT OR IGNORE INTO wechat_sub (contract_code,user_sub,plan_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)",
          )
            .bind(candidate, scope, env.WECHAT_PAY_PLAN_ID, "pending", now, now)
            .run();
          if (ins && ins.meta && ins.meta.changes === 1) {
            code = candidate;
            break;
          }
        }
        if (!code) {
          const concurrent = await env.USAGE.prepare(
            "SELECT * FROM wechat_sub WHERE user_sub=? AND status='pending'",
          )
            .bind(scope)
            .first();
          if (!concurrent) return J({ error: "already-subscribed" }, 409);
          code = concurrent.contract_code;
        }
        sub = await env.USAGE.prepare(
          "SELECT * FROM wechat_sub WHERE contract_code=?",
        )
          .bind(code)
          .first();
        await audit(env.USAGE, {
          now,
          direction: "internal",
          event_type: "contract_created",
          contract_code: code,
          user_sub: scope,
          status_after: "pending",
          payload: { plan_id: env.WECHAT_PAY_PLAN_ID },
        });
      }
      const origin = publicOrigin(env, url);
      const serial = requestSerial(now);
      try {
        const provider = await postPrecontract(
          env,
          sub,
          now,
          origin,
          fetcher,
          serial,
        );
        const expiresAt = now + PRE_ENTRUST_TTL_MS;
        await env.USAGE.prepare(
          "UPDATE wechat_sub SET last_error_code=NULL, updated_at=? WHERE contract_code=?",
        )
          .bind(now, sub.contract_code)
          .run();
        await audit(env.USAGE, {
          now,
          direction: "outbound",
          event_type: "precontract_created",
          contract_code: sub.contract_code,
          user_sub: scope,
          status_before: "pending",
          status_after: "pending",
          payload: {
            request_serial: serial,
            has_mini_program: !!(
              provider.miniprogram_username && provider.miniprogram_path
            ),
          },
        });
        // 会话只经本次 HTTPS 响应交给已认证 Android，不持久化到 D1。
        return contractResponse(sub.contract_code, provider, expiresAt);
      } catch (e) {
        const code = String(e.code || "precontract-failed").slice(0, 64);
        await env.USAGE.prepare(
          "UPDATE wechat_sub SET last_error_code=?, last_event_at=?, updated_at=? WHERE contract_code=?",
        )
          .bind(code, now, now, sub.contract_code)
          .run();
        await audit(env.USAGE, {
          now,
          direction: "outbound",
          event_type: "precontract_failed",
          contract_code: sub.contract_code,
          user_sub: scope,
          status_before: "pending",
          status_after: "pending",
          code,
          message: e.message,
          payload: e.provider,
        });
        // Android 不应看到微信的原始失败文本、请求参数或签名材料。
        return J({ error: "contract-unavailable" }, 502);
      }
    }

    if (
      url.pathname === "/agent/wechat-pay/contract-notify" &&
      request.method === "POST"
    ) {
      if (!env.USAGE || !env.WECHAT_PAY_API_V2_KEY || !env.WECHAT_PAY_MCH_ID)
        return xmlReply("FAIL", "UNAVAILABLE");
      const values = parseWechatXml(await request.text());
      if (
        !verifyWechatV2(values, env.WECHAT_PAY_API_V2_KEY) ||
        values.mch_id !== env.WECHAT_PAY_MCH_ID
      )
        return xmlReply("FAIL", "BAD SIGN");
      if (!callbackData(values)) return xmlReply("SUCCESS", "IGNORED");
      const code = values.contract_code || values.out_contract_code;
      const contractId = values.contract_id || values.contract_no;
      if (!code || !contractId) return xmlReply("FAIL", "MISSING CONTRACT");
      const sub = await env.USAGE.prepare(
        "SELECT * FROM wechat_sub WHERE contract_code=?",
      )
        .bind(code)
        .first();
      if (!sub || (values.plan_id && values.plan_id !== sub.plan_id))
        return xmlReply("FAIL", "UNKNOWN CONTRACT");
      if (sub.contract_id && sub.contract_id !== contractId)
        return xmlReply("FAIL", "CONTRACT CONFLICT");
      if (values.change_type !== "ADD") return xmlReply("FAIL", "WRONG EVENT");
      if (sub.status !== "pending")
        return xmlReply("SUCCESS", "ALREADY PROCESSED");
      const previous = await env.USAGE.prepare(
        "SELECT MAX(entitlement_end_at) AS period_end_at FROM wechat_txn WHERE user_sub=? AND status='paid' AND entitlement_end_at>?",
      )
        .bind(sub.user_sub, now)
        .first();
      const initialStart = previous?.period_end_at || null;
      const nextChargeAt =
        initialStart == null ? now : wechatChargeScheduleAt(initialStart);
      const changed = await env.USAGE.prepare(
        "UPDATE wechat_sub SET contract_id=?,openid=?,status='active',period_start_at=NULL,period_end_at=?,next_charge_at=?,signed_at=?,last_event_at=?,last_error_code=NULL,updated_at=? WHERE contract_code=? AND status='pending'",
      )
        .bind(
          contractId,
          values.openid || null,
          initialStart ?? now,
          nextChargeAt,
          now,
          now,
          now,
          code,
        )
        .run();
      if (changed.meta.changes !== 1)
        return xmlReply("SUCCESS", "ALREADY PROCESSED");
      await audit(env.USAGE, {
        now,
        direction: "inbound",
        event_type: "contract_signed",
        contract_code: code,
        user_sub: sub.user_sub,
        status_before: sub.status,
        status_after: "active",
        payload: values,
      });
      // 首期不等每日 Cron：签约已确认后立刻申请扣款。waitUntil 让微信回调快速
      // 得到 ACK；网络失败保留未知结果，由后续定时查单确认，不能直接换单重扣。
      // 没有 ctx 的纯函数调用（例如旧测试/离线脚本）不触发网络副作用。
      if (
        ready(env) &&
        ctx &&
        typeof ctx.waitUntil === "function" &&
        nextChargeAt <= now
      ) {
        const activeSub = {
          ...sub,
          contract_id: contractId,
          status: "active",
          period_end_at: initialStart == null ? now : initialStart,
          next_charge_at: nextChargeAt,
        };
        const initialCharge = (async () => {
          const txn = await createDueTransaction(
            env.USAGE,
            activeSub,
            env,
            now,
          );
          if (!txn) return;
          await audit(env.USAGE, {
            now,
            direction: "internal",
            event_type: "initial_charge_triggered",
            contract_code: code,
            out_trade_no: txn.out_trade_no,
            user_sub: sub.user_sub,
            status_before: "pending",
            status_after: txn.status,
          });
          await requestCharge(
            env.USAGE,
            env,
            txn,
            activeSub,
            now,
            fetcher,
            publicOrigin(env, url),
          );
        })();
        ctx.waitUntil(
          initialCharge.catch((e) =>
            console.log(
              "[wechat-pay] initial charge failed",
              String((e && e.message) || e),
            ),
          ),
        );
      }
      return xmlReply("SUCCESS", "OK");
    }

    if (
      url.pathname === "/agent/wechat-pay/pay-notify" &&
      request.method === "POST"
    ) {
      if (!env.USAGE || !env.WECHAT_PAY_API_V2_KEY || !env.WECHAT_PAY_MCH_ID)
        return xmlReply("FAIL", "UNAVAILABLE");
      const values = parseWechatXml(await request.text());
      if (
        !verifyWechatV2(values, env.WECHAT_PAY_API_V2_KEY) ||
        values.mch_id !== env.WECHAT_PAY_MCH_ID
      )
        return xmlReply("FAIL", "BAD SIGN");
      const attempt = await env.USAGE.prepare(
        "SELECT * FROM wechat_attempt WHERE out_trade_no=?",
      )
        .bind(values.out_trade_no || "")
        .first();
      const txn =
        attempt &&
        (await env.USAGE.prepare(
          "SELECT * FROM wechat_txn WHERE out_trade_no=?",
        )
          .bind(attempt.cycle_no)
          .first());
      if (!txn) return xmlReply("FAIL", "ORDER MISMATCH");
      // 失败通知通常没有 total_fee；成功通知则必须金额完全一致才能入账。
      if (
        callbackData(values) &&
        Number(values.total_fee) !== Number(txn.amount_fen)
      )
        return xmlReply("FAIL", "ORDER MISMATCH");
      if (values.appid !== env.WECHAT_PAY_APP_ID)
        return xmlReply("FAIL", "APP MISMATCH");
      if (!callbackData(values)) {
        if (values.return_code !== "SUCCESS" || values.result_code !== "FAIL")
          return xmlReply("FAIL", "UNKNOWN PAYMENT RESULT");
        await failAttempt(
          env.USAGE,
          values.out_trade_no,
          now,
          String(values.err_code || "payment-failed"),
        );
        return xmlReply("SUCCESS", "RECORDED");
      }
      if (
        values.appid !== env.WECHAT_PAY_APP_ID ||
        values.contract_id !== attempt.contract_id ||
        !values.transaction_id ||
        (values.fee_type && values.fee_type !== "CNY")
      )
        return xmlReply("FAIL", "PAYMENT MISMATCH");
      await settlePayment(env.USAGE, txn, values, now);
      return xmlReply("SUCCESS", "OK");
    }

    if (
      url.pathname === "/agent/wechat-pay/cancel-notify" &&
      request.method === "POST"
    ) {
      if (!env.USAGE || !env.WECHAT_PAY_API_V2_KEY || !env.WECHAT_PAY_MCH_ID)
        return xmlReply("FAIL", "UNAVAILABLE");
      const values = parseWechatXml(await request.text());
      if (
        !verifyWechatV2(values, env.WECHAT_PAY_API_V2_KEY) ||
        values.mch_id !== env.WECHAT_PAY_MCH_ID
      )
        return xmlReply("FAIL", "BAD SIGN");
      if (!callbackData(values)) return xmlReply("SUCCESS", "IGNORED");
      const code = values.contract_code || values.out_contract_code;
      const id = values.contract_id || values.contract_no;
      const row = await env.USAGE.prepare(
        "SELECT * FROM wechat_sub WHERE contract_code=?",
      )
        .bind(code || "")
        .first();
      if (!row || (id && row.contract_id !== id))
        return xmlReply("FAIL", "UNKNOWN CONTRACT");
      if (values.change_type !== "DELETE")
        return xmlReply("FAIL", "WRONG EVENT");
      const reason =
        values.cancel_reason || values.contract_status || "wechat-cancelled";
      await markWechatContractCancelled(
        env.USAGE,
        row,
        now,
        reason,
        "contract_cancelled",
        values,
        reason,
      );
      return xmlReply("SUCCESS", "OK");
    }

    if (
      url.pathname === "/agent/wechat-pay/cancel" &&
      request.method === "POST"
    ) {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!ready(env)) return J({ error: "degraded" }, 503);
      const sub = await env.USAGE.prepare(
        "SELECT * FROM wechat_sub WHERE user_sub=? AND status='active' AND contract_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
      )
        .bind(scope)
        .first();
      // 网络重试必须安全：已经成功解约就直接返回成功，不能把旧记录当成错误。
      if (!sub) {
        const last = await env.USAGE.prepare(
          "SELECT status,period_end_at FROM wechat_sub WHERE user_sub=? ORDER BY updated_at DESC LIMIT 1",
        )
          .bind(scope)
          .first();
        if (last && last.status === "cancelled")
          return J({
            ok: true,
            status: "cancelled",
            already: true,
            expires_date: last.period_end_at || null,
          });
        return J({ error: "no-active-contract" }, 409);
      }
      try {
        const provider = await terminateWechatContract(env, sub, fetcher);
        await markWechatContractCancelled(
          env.USAGE,
          sub,
          now,
          "user-cancelled-in-app",
          "contract_cancelled_by_user",
          provider,
          "用户在 App 解除自动续费",
          "outbound",
        );
        return J({
          ok: true,
          status: "cancelled",
          expires_date: sub.period_end_at || null,
        });
      } catch (e) {
        const reconciled = await reconcileWechatContract(
          env.USAGE,
          env,
          sub,
          now,
          fetcher,
        );
        if (reconciled.cancelled)
          return J({
            ok: true,
            status: "cancelled",
            expires_date: sub.period_end_at || null,
          });
        await env.USAGE.prepare(
          "UPDATE wechat_sub SET last_event_at=?, last_error_code=?, updated_at=? WHERE contract_code=?",
        )
          .bind(
            now,
            String(e.code || "contract-termination-failed").slice(0, 64),
            now,
            sub.contract_code,
          )
          .run();
        await audit(env.USAGE, {
          now,
          direction: "outbound",
          event_type: "contract_cancel_failed",
          contract_code: sub.contract_code,
          user_sub: scope,
          status_before: sub.status,
          status_after: sub.status,
          code: e.code,
          message: e.message,
          payload: e.provider,
        });
        return J({ error: "cancel-unavailable" }, 502);
      }
    }

    if (
      url.pathname === "/agent/wechat-pay/status" &&
      request.method === "GET"
    ) {
      const scope = await scopeFromToken(bearerToken(request), env);
      if (!scope) return J({ error: "unauthorized" }, 401);
      if (!env.USAGE) return J({ active: false, degraded: true });
      const row = await env.USAGE.prepare(
        "SELECT contract_code, contract_id, plan_id, status, period_start_at, period_end_at, next_charge_at, cancel_reason, signed_at, cancelled_at, last_error_code FROM wechat_sub WHERE user_sub=? ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1",
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
        enabled: await wechatPayEnabled(env),
        can_cancel: !!(row && row.status === "active" && row.contract_id),
        status: row ? row.status : null,
        plan_id: row ? row.plan_id : null,
        expires_date: expiresAt,
        // 尚未实际扣款的新协议以 period_start_at 为空标识；period_end_at 此时保存
        // 首期的约定起点，供稳定地计算订单周期，不能再用它判断是否待扣。
        scheduled_charge_at:
          row && row.period_start_at == null ? row.next_charge_at : null,
        cancel_reason: row ? row.cancel_reason : null,
        signed_at: row ? row.signed_at : null,
        cancelled_at: row ? row.cancelled_at : null,
        // 原始微信错误码/文本只留在 D1 的 wechat_sub / wechat_txn / wechat_event，
        // 客户端只得到稳定、可展示的通用状态，避免暴露支付通道内部信息。
        payment_issue: row && row.last_error_code ? "payment-failed" : null,
        payment_pending: !!(await unresolvedUserOrder(env.USAGE, scope)),
        renewal_stopped: !!(
          row &&
          row.status === "active" &&
          row.next_charge_at == null &&
          row.last_error_code
        ),
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
