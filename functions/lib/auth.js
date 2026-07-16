// Auth + crypto primitives — SINGLE SOURCE OF TRUTH.
//
// Token verification is security-sensitive: the Files API
// (functions/files/api/[[path]].js) and the agent worker (agent/src/index.js)
// must verify/sign tokens IDENTICALLY. These were previously copy-pasted
// "verbatim" in both places — a drift here would be a security bug. Keep them
// HERE only; both import from this module. Do not re-inline.

// Strip the "Bearer " prefix off a request's Authorization header ("" if absent).
// SINGLE SOURCE for token extraction — was hand-inlined ~28x across workers.
export function bearerToken(request) {
  return (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
}

export function sanitizeSeg(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

export function b64url(str) {
  return bytesToB64url(new TextEncoder().encode(str));
}

export async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

// Verify a signed session token "<h>.<p>.<sig>"; returns { scope, apple, wechat } or null.
export async function verifySession(tokenStr, secret) {
  const parts = tokenStr.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = await hmacSign(`${h}.${p}`, secret);
  if (!timingSafeEqual(s, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToString(p)); } catch { return null; }
  if (!payload.scope) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return { scope: payload.scope, apple: !!payload.apple, wechat: !!payload.wechat };
}

// The users/anon-<hash>/ scope an anon token maps to.
export async function anonScopeFromToken(token) {
  if (!token || !token.startsWith("anon_") || token.length < 20) return null;
  const id = (await sha256hex(token)).slice(0, 32);
  return `users/anon-${id}/`;
}

// 「这个 scope 绑过实名身份吗？」——Apple/微信登录会把 appleSub / wechatOpenid /
// wechatUnionid 写进 ${scope}ACCOUNT.json（files API 的 auth 分支）。社区写门槛
// （分享/发帖/投币）的目的只是可追责：匿名设备 token 落在一个绑过实名的 scope 上
// 时，匿名 scope → ACCOUNT.json → Apple/微信 的追责链已经成立，所以放行——
// 「实名 session」或「绑过实名的匿名 scope」二者取其一（设计定稿 2026-07-16）。
// 从未绑定过的裸匿名 token 仍然 403，引导登录。
export async function hasVerifiedBinding(env, scope) {
  if (!scope || !scope.startsWith("users/") || !env.FILES) return false;
  try {
    const obj = await env.FILES.get(`${scope}ACCOUNT.json`);
    if (!obj) return false;
    const acct = JSON.parse(await obj.text());
    return !!(acct.appleSub || acct.wechatOpenid || acct.wechatUnionid);
  } catch {
    return false;
  }
}
