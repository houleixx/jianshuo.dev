import { createPrivateKey, createPublicKey, createDecipheriv, randomBytes, sign, verify } from 'node:crypto';

const pem = value => String(value || '').replace(/\\n/g, '\n');
export function wechatV3Ready(env) {
  return ['WECHAT_PAY_MCH_ID', 'WECHAT_PAY_APP_ID', 'WECHAT_PAY_MCH_PRIVATE_KEY',
    'WECHAT_PAY_MCH_SERIAL_NO', 'WECHAT_PAY_PUBLIC_KEY', 'WECHAT_PAY_PUBLIC_KEY_ID',
    'WECHAT_PAY_API_V3_KEY'].every(k => !!env[k]) && Buffer.byteLength(env.WECHAT_PAY_API_V3_KEY, 'utf8') === 32;
}
function rsaSign(env, message) {
  return sign('RSA-SHA256', Buffer.from(message), createPrivateKey(pem(env.WECHAT_PAY_MCH_PRIVATE_KEY))).toString('base64');
}
export function verifyWechatV3(env, headers, body, now = Date.now()) {
  const timestamp = headers.get('Wechatpay-Timestamp'), nonce = headers.get('Wechatpay-Nonce');
  const signature = headers.get('Wechatpay-Signature');
  if (!/^\d{10}$/.test(timestamp || '') || !nonce || !signature ||
      headers.get('Wechatpay-Serial') !== env.WECHAT_PAY_PUBLIC_KEY_ID ||
      Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  try {
    return verify('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),
      createPublicKey(pem(env.WECHAT_PAY_PUBLIC_KEY)), Buffer.from(signature, 'base64'));
  } catch { return false; }
}
export async function wechatV3Request(env, method, path, payload, fetcher = fetch, now = Date.now()) {
  if (!path.startsWith('/v3/') || /[\r\n]/.test(path)) throw new Error('invalid-v3-path');
  const body = payload == null ? '' : JSON.stringify(payload);
  const timestamp = String(Math.floor(now / 1000)), nonce = randomBytes(16).toString('hex');
  const signature = rsaSign(env, `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${env.WECHAT_PAY_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${env.WECHAT_PAY_MCH_SERIAL_NO}",signature="${signature}"`;
  const response = await fetcher('https://api.mch.weixin.qq.com' + path, {
    method, headers: { Authorization: authorization, Accept: 'application/json',
      'Content-Type': 'application/json', 'Wechatpay-Serial': env.WECHAT_PAY_PUBLIC_KEY_ID },
    ...(body ? { body } : {}), signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  const raw = await response.text();
  const verified = verifyWechatV3(env, response.headers, raw, now);
  let data; try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('invalid-v3-response'); }
  if (!response.ok) {
    throw Object.assign(new Error('wechat-v3-request-failed'), {
      code: typeof data.code === 'string' ? data.code : `http-${response.status}`,
      verified, providerMessage: typeof data.message === 'string' ? data.message.slice(0, 512) : null,
    });
  }
  if (!verified) throw new Error('invalid-v3-response-signature');
  return data;
}
export function wechatV3AppPayParams(env, prepayId, now = Date.now()) {
  const timeStamp = String(Math.floor(now / 1000)), nonceStr = randomBytes(16).toString('hex');
  return { appId: env.WECHAT_PAY_APP_ID, partnerId: env.WECHAT_PAY_MCH_ID,
    prepayId, packageValue: 'Sign=WXPay', nonceStr, timeStamp,
    sign: rsaSign(env, `${env.WECHAT_PAY_APP_ID}\n${timeStamp}\n${nonceStr}\n${prepayId}\n`) };
}
export function decryptWechatV3Notification(env, headers, raw, now = Date.now()) {
  if (!verifyWechatV3(env, headers, raw, now)) throw new Error('invalid-v3-notification-signature');
  const envelope = JSON.parse(raw), r = envelope.resource;
  if (envelope.event_type !== 'TRANSACTION.SUCCESS' || !r || r.algorithm !== 'AEAD_AES_256_GCM')
    throw new Error('unexpected-v3-notification');
  const key = Buffer.from(env.WECHAT_PAY_API_V3_KEY || '', 'utf8');
  if (key.length !== 32) throw new Error('invalid-v3-key');
  const encrypted = Buffer.from(r.ciphertext, 'base64');
  if (encrypted.length < 16) throw new Error('invalid-v3-ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(r.nonce, 'utf8'));
  decipher.setAuthTag(encrypted.subarray(-16));
  decipher.setAAD(Buffer.from(r.associated_data || '', 'utf8'));
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8'));
}
