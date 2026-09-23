import { createHash, createHmac, timingSafeEqual, randomBytes } from "node:crypto";
const md5=s=>createHash("md5").update(String(s),"utf8").digest("hex").toUpperCase();

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

export function wechatV2Ready(env) {
  return !!(env.WECHAT_PAY_APP_ID && env.WECHAT_PAY_MCH_ID && env.WECHAT_PAY_API_V2_KEY);
}

const PAYMENT_PATHS = new Set(['/pay/contractorder', '/pay/orderquery', '/pay/closeorder']);
export async function wechatV2Request(env, path, payload, fetcher = fetch) {
  if (!PAYMENT_PATHS.has(path)) throw new Error('invalid-payment-path');
  const response = await fetcher('https://api.mch.weixin.qq.com' + path, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: {'Content-Type':'text/xml; charset=utf-8', 'User-Agent':'VoiceDrop-Agent/1.0'},
    body: wechatV2Xml({appid:env.WECHAT_PAY_APP_ID, mch_id:env.WECHAT_PAY_MCH_ID,
      nonce_str:randomBytes(16).toString('hex'), ...payload},env.WECHAT_PAY_API_V2_KEY),
  });
  if(response.status>=300 && response.status<400) {
    await response.body?.cancel();
    throw new Error('unexpected-payment-redirect');
  }
  const data=parseWechatXml(await response.text());
  const verified=verifyWechatV2(data,env.WECHAT_PAY_API_V2_KEY) &&
    data.appid===env.WECHAT_PAY_APP_ID && data.mch_id===env.WECHAT_PAY_MCH_ID;
  if(!response.ok || !data || data.return_code!=='SUCCESS' || data.result_code!=='SUCCESS') {
    throw Object.assign(new Error('wechat-payment-request-failed'),{
      // Only an authenticated error may influence order recovery.
      code:verified ? data.err_code || 'payment-error' : 'unconfirmed', verified,
      providerMessage:typeof data?.err_code_des==='string' ? data.err_code_des.slice(0,512) : null,
    });
  }
  if(!verified)throw new Error('invalid-payment-response-signature');
  return data;
}

// APP SDK uses the same MD5 signing mode as contractorder. Field casing is part of the protocol.
export function wechatV2AppPayParams(env, prepayId, now=Date.now()) {
  const p={appid:env.WECHAT_PAY_APP_ID,partnerid:env.WECHAT_PAY_MCH_ID,prepayid:prepayId,
    package:'Sign=WXPay',noncestr:randomBytes(16).toString('hex'),timestamp:String(Math.floor(now/1000))};
  return {appId:p.appid,partnerId:p.partnerid,prepayId:p.prepayid,packageValue:p.package,
    nonceStr:p.noncestr,timeStamp:p.timestamp,sign:wechatV2Sign(p,env.WECHAT_PAY_API_V2_KEY)};
}

export function wechatPaymentTime(at) {
  return new Date(at+8*3600000).toISOString().slice(0,19).replace(/[-:T]/g,'');
}
