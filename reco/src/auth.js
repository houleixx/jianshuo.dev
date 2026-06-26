// 复刻自核心 functions/files/api/[[path]].js(行 840–887)。reco 独立验 token。
export async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifySession(tokenStr, secret) {
  const parts = tokenStr.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = await hmacSign(`${h}.${p}`, secret);
  if (!timingSafeEqual(s, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToString(p)); } catch { return null; }
  if (!payload.scope) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return { scope: payload.scope, apple: !!payload.apple };
}

async function anonScopeFromToken(token) {
  if (!token || !token.startsWith("anon_") || token.length < 20) return null;
  const id = (await sha256hex(token)).slice(0, 32);
  return `users/anon-${id}/`;
}

// 任意有效 token → scope;否则 null。reco 不接受 temp/admin token。
export async function resolveScope(token, secret) {
  if (!token) return null;
  if (secret) {
    const sess = await verifySession(token, secret);
    if (sess) return sess.scope;
  }
  return await anonScopeFromToken(token);
}

// ── b64url / timing-safe(复刻核心)──
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToString(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
