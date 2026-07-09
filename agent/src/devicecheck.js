// src/devicecheck.js — Apple DeviceCheck 两 bit：跨删除重装持久的「此设备已领过」标记。
// bit0 = 已领过邀请奖励。ES256 JWT 与 push.js 同构（iss=team, kid=key）；key 复用
// APNS 那把 .p8（DC_KEY_* secrets 存在则优先——万一 APNs key 没开 DeviceCheck 服务）。
// 一律 fail-safe：拿不到明确答案返回 "unavailable"，由调用方按配置决定放行或拒绝。
const DC_HOST = "https://api.devicecheck.apple.com"; // TestFlight/App Store 构建走生产

let jwtCache = { token: null, exp: 0, keyId: null };

function pemToPkcs8(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function creds(env) {
  const p8 = env.DC_KEY_P8 || env.APNS_KEY_P8;
  const kid = env.DC_KEY_P8 ? env.DC_KEY_ID : env.APNS_KEY_ID;
  const team = env.APNS_TEAM_ID;
  return p8 && kid && team ? { p8, kid, team } : null;
}

async function dcJwt(c) {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache.token && jwtCache.exp > now + 300 && jwtCache.keyId === c.kid) return jwtCache.token;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(c.p8), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: c.kid })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss: c.team, iat: now })));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`));
  const token = `${header}.${payload}.${b64url(sig)}`;
  jwtCache = { token, exp: now + 2400, keyId: c.kid };   // 40 分钟后换新（APNs 同款节奏）
  return token;
}

async function dcPost(c, path, body, fetcher) {
  return (fetcher || fetch)(`${DC_HOST}/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await dcJwt(c)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deviceCheckGate(env, dcToken, fetcher) {
  try {
    const c = creds(env);
    if (!c || !dcToken) return "unavailable";
    const resp = await dcPost(c, "query_two_bits",
      { device_token: dcToken, transaction_id: crypto.randomUUID(), timestamp: Date.now() }, fetcher);
    if (resp.status !== 200) return "unavailable";
    const text = await resp.text();
    if (/Failed to find bit state/i.test(text)) return "fresh"; // 该设备从未置过位
    let bits; try { bits = JSON.parse(text); } catch { return "unavailable"; }
    return bits && bits.bit0 === true ? "used" : "fresh";
  } catch (e) {
    console.error("[devicecheck] query failed:", e && e.message);
    return "unavailable";
  }
}

export async function deviceCheckMark(env, dcToken, fetcher) {
  try {
    const c = creds(env);
    if (!c || !dcToken) return false;
    const resp = await dcPost(c, "update_two_bits",
      { device_token: dcToken, transaction_id: crypto.randomUUID(), timestamp: Date.now(), bit0: true, bit1: false }, fetcher);
    return resp.status === 200;
  } catch (e) {
    console.error("[devicecheck] update failed:", e && e.message);
    return false;
  }
}
