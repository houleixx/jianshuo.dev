// A one-cent diagnostic APP payment. Disabled unless explicitly enabled by deployment.
// These orders never enter subscription, bucket, ledger or scheduled-charge flows.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { verifySession, anonScopeFromToken, bearerToken } from '../../functions/lib/auth.js';
import { wechatV2Sign, wechatV2Xml, parseWechatXml, verifyWechatV2 } from './wechat-pay.js';

const PREFIX = '/agent/wechat-pay/single';
const OPEN = "('creating','pending','unknown')";
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const reply = (ok) => new Response(`<xml><return_code><![CDATA[${ok ? 'SUCCESS' : 'FAIL'}]]></return_code><return_msg><![CDATA[${ok ? 'OK' : 'INVALID'}]]></return_msg></xml>`, {
  headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' },
});
const nonce = () => crypto.randomUUID().replaceAll('-', '');
const code = (value) => /^[A-Z0-9_]{1,64}$/.test(value || '') ? value : 'WECHAT_REQUEST_FAILED';
function failure(value) { const e = new Error('Single payment request failed'); e.providerCode = code(value); return e; }
const ready = env => !!(env.USAGE && env.WECHAT_PAY_APP_ID && env.WECHAT_PAY_MCH_ID && env.WECHAT_PAY_API_V2_KEY && env.WECHAT_PAY_CALLBACK_BASE_URL);
const identity = (p, e) => p.appid === e.WECHAT_PAY_APP_ID && p.mch_id === e.WECHAT_PAY_MCH_ID;
const byId = (db, id) => db.prepare('SELECT * FROM wechat_single_order WHERE out_trade_no=?').bind(id).first();
const latest = (db, scope) => db.prepare('SELECT * FROM wechat_single_order WHERE user_sub=? ORDER BY created_at DESC,rowid DESC LIMIT 1').bind(scope).first();

async function provider(env, api, params, fetcher) {
  const response = await fetcher(`https://api.mch.weixin.qq.com/pay/${api}`, {
    method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8' },
    body: wechatV2Xml({ appid: env.WECHAT_PAY_APP_ID, mch_id: env.WECHAT_PAY_MCH_ID,
      nonce_str: nonce(), sign_type: 'MD5', ...params }, env.WECHAT_PAY_API_V2_KEY),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw failure('WECHAT_HTTP_ERROR');
  const raw = await response.text();
  if (raw.length > 32768) throw failure('WECHAT_INVALID_RESPONSE');
  const p = parseWechatXml(raw);
  if (!p || p.return_code !== 'SUCCESS') throw failure('WECHAT_RETURN_FAIL');
  if (!verifyWechatV2(p, env.WECHAT_PAY_API_V2_KEY) || !identity(p, env)) throw failure('WECHAT_RESPONSE_SIGNATURE_INVALID');
  if (p.result_code !== 'SUCCESS') {
    const e = failure(p.err_code);
    e.definitive = ['NOAUTH','APPID_NOT_EXIST','MCHID_NOT_EXIST','APPID_MCHID_NOT_MATCH','INVALID_REQUEST','PARAM_ERROR','SIGNERROR','NOTENOUGH','LACK_PARAMS','OUT_TRADE_NO_USED'].includes(e.providerCode);
    throw e;
  }
  return p;
}

function paidEvidence(p, row, env) {
  return identity(p, env) && p.out_trade_no === row.out_trade_no && p.trade_type === 'APP'
    && p.total_fee === String(row.amount_fen) && (!p.fee_type || p.fee_type === 'CNY')
    && typeof p.transaction_id === 'string' && /^\d{10,64}$/.test(p.transaction_id);
}
async function markPaid(env, row, p, now, source) {
  if (!paidEvidence(p, row, env)) return false;
  if (row.status === 'paid') return row.transaction_id === p.transaction_id;
  await env.USAGE.prepare("UPDATE wechat_single_order SET status='paid',transaction_id=?,paid_at=?,updated_at=?,confirmed_by=?,last_error_code=NULL WHERE out_trade_no=? AND (transaction_id IS NULL OR transaction_id=?)")
    .bind(p.transaction_id, now, now, source, row.out_trade_no, p.transaction_id).run();
  const saved = await byId(env.USAGE, row.out_trade_no);
  return saved.status === 'paid' && saved.transaction_id === p.transaction_id;
}
async function reconcile(env, row, fetcher, now) {
  if (!row || !['creating','pending','unknown'].includes(row.status)) return row;
  if (row.status === 'creating' && now - row.created_at < 20000) return row;
  const claim = await env.USAGE.prepare(`UPDATE wechat_single_order SET last_query_at=? WHERE out_trade_no=? AND status IN ${OPEN} AND (last_query_at IS NULL OR last_query_at<=?)`)
    .bind(now, row.out_trade_no, now - 10000).run();
  if (claim.meta?.changes !== 1) return byId(env.USAGE, row.out_trade_no);
  try {
    const p = await provider(env, 'orderquery', { out_trade_no: row.out_trade_no }, fetcher);
    if (p.out_trade_no !== row.out_trade_no) throw failure('WECHAT_ORDER_MISMATCH');
    if (p.trade_state === 'SUCCESS') {
      if (!await markPaid(env, row, p, now, 'query')) throw failure('WECHAT_ORDER_MISMATCH');
    } else if (['CLOSED','REVOKED','PAYERROR'].includes(p.trade_state)
        || (p.trade_state === 'NOTPAY' && now > row.expires_at + 60000)) {
      await env.USAGE.prepare("UPDATE wechat_single_order SET status='closed',updated_at=?,last_error_code=NULL WHERE out_trade_no=? AND status!='paid'").bind(now, row.out_trade_no).run();
    }
  } catch (e) {
    // Even a timeout must keep its merchant order: never automatically submit a replacement.
    await env.USAGE.prepare("UPDATE wechat_single_order SET last_error_code=? WHERE out_trade_no=? AND status!='paid'").bind(code(e.providerCode), row.out_trade_no).run();
  }
  return byId(env.USAGE, row.out_trade_no);
}
function orderResult(row, env, now) {
  if (!row) return { enabled: true, order: null };
  const out = { enabled: true, order: { out_trade_no: row.out_trade_no, status: row.status,
    amount_fen: row.amount_fen, paid_at: row.paid_at, confirmed_by: row.confirmed_by,
    last_error_code: row.last_error_code, expires_at: row.expires_at } };
  if (row.status === 'pending' && row.prepay_id && now < row.expires_at) {
    const params = { appid: env.WECHAT_PAY_APP_ID, partnerid: env.WECHAT_PAY_MCH_ID,
      prepayid: row.prepay_id, package: 'Sign=WXPay', noncestr: nonce(), timestamp: String(Math.floor(now / 1000)) };
    out.payment = { ...params, sign: wechatV2Sign(params, env.WECHAT_PAY_API_V2_KEY) };
  }
  return out;
}
function expireTime(at) {
  return new Date(at + 8 * 3600000).toISOString().slice(0,19).replace(/[-T:]/g, '');
}

export async function handleWechatSinglePayRoute(url, request, env, fetcher = fetch, now = Date.now()) {
  if (!url.pathname.startsWith(PREFIX + '/')) return null;
  const notify = url.pathname === PREFIX + '/notify' && request.method === 'POST';
  // Disabling new test payments does not discard callbacks for already-created orders.
  if (!notify && String(env.WECHAT_PAY_SINGLE_TEST_ENABLED) !== 'true') return json({ error: 'disabled' }, 404);
  if (!ready(env)) return notify ? reply(false) : json({ error: 'payment-not-configured' }, 503);
  try {
    if (notify) {
      if (Number(request.headers.get('content-length')) > 16384) return reply(false);
      const raw = await request.text();
      if (raw.length > 16384) return reply(false);
      const p = parseWechatXml(raw);
      if (!p || p.return_code !== 'SUCCESS' || p.result_code !== 'SUCCESS'
          || !verifyWechatV2(p, env.WECHAT_PAY_API_V2_KEY) || !identity(p, env)) return reply(false);
      const row = await byId(env.USAGE, p.out_trade_no || '');
      return reply(!!row && await markPaid(env, row, p, now, 'notify'));
    }
    const token = bearerToken(request);
    const session = token && env.SESSION_SECRET ? await verifySession(token, env.SESSION_SECRET) : null;
    const scope = session?.scope || (token ? await anonScopeFromToken(token) : null);
    if (!scope) return json({ error: 'unauthorized' }, 401);
    if (url.pathname === PREFIX + '/status' && request.method === 'GET') {
      return json(orderResult(await reconcile(env, await latest(env.USAGE, scope), fetcher, now), env, now));
    }
    if (url.pathname !== PREFIX + '/order' || request.method !== 'POST') return json({ error: 'not-found' }, 404);
    let body;
    try { body = JSON.parse(await request.text()); } catch { return json({ error: 'invalid-request' }, 400); }
    if (!body || !/^[a-f0-9-]{36}$/.test(body.request_id || '') || Object.keys(body).some(k => k !== 'request_id')) return json({ error: 'invalid-request' }, 400);
    const orderId = 'VDT' + createHash('sha256').update(scope + ':' + body.request_id).digest('hex').slice(0,29);
    let row = await byId(env.USAGE, orderId);
    if (row) return json(orderResult(await reconcile(env, row, fetcher, now), env, now));
    row = await env.USAGE.prepare(`SELECT * FROM wechat_single_order WHERE user_sub=? AND status IN ${OPEN} LIMIT 1`).bind(scope).first();
    if (row) {
      row = await reconcile(env, row, fetcher, now);
      if (['creating','pending','unknown'].includes(row.status)) return json(orderResult(row, env, now));
      // The previous payment may have completed while the user was retrying. Show its result first.
      if (row.status === 'paid') return json(orderResult(row, env, now));
    }
    const count = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM wechat_single_order WHERE user_sub=? AND created_at>?').bind(scope, now - 86400000).first();
    if (count.n >= 10) return json({ error: 'too-many-orders' }, 429);
    const ip = request.headers.get('cf-connecting-ip');
    if (!ip || !isIP(ip)) return json({ error: 'client-ip-unavailable' }, 400);
    const origin = new URL(env.WECHAT_PAY_CALLBACK_BASE_URL);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return json({ error: 'payment-not-configured' }, 503);
    const expiresAt = now + 20 * 60000;
    const inserted = await env.USAGE.prepare("INSERT OR IGNORE INTO wechat_single_order (out_trade_no,user_sub,amount_fen,status,created_at,updated_at,expires_at) VALUES (?,?,1,'creating',?,?,?)")
      .bind(orderId, scope, now, now, expiresAt).run();
    if (inserted.meta?.changes !== 1) return json(orderResult(await latest(env.USAGE, scope), env, now));
    try {
      const p = await provider(env, 'unifiedorder', { body: 'VoiceDrop单次支付测试', out_trade_no: orderId,
        total_fee: 1, fee_type: 'CNY', spbill_create_ip: ip, notify_url: origin.origin + PREFIX + '/notify',
        trade_type: 'APP', time_expire: expireTime(expiresAt) }, fetcher);
      if (p.trade_type !== 'APP' || !p.prepay_id || p.prepay_id.length > 64) throw failure('WECHAT_INVALID_RESPONSE');
      await env.USAGE.prepare("UPDATE wechat_single_order SET status='pending',prepay_id=?,updated_at=? WHERE out_trade_no=? AND status='creating'")
        .bind(p.prepay_id, now, orderId).run();
    } catch (e) {
      // The remote outcome can be ambiguous. Store it for query/reconciliation, never auto-recharge.
      await env.USAGE.prepare("UPDATE wechat_single_order SET status=?,last_error_code=?,updated_at=? WHERE out_trade_no=? AND status='creating'")
        .bind(e.definitive ? 'failed' : 'unknown', code(e.providerCode), now, orderId).run();
    }
    return json(orderResult(await byId(env.USAGE, orderId), env, now));
  } catch {
    return notify ? reply(false) : json({ error: 'payment-unavailable' }, 503);
  }
}
