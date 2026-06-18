// File transfer API backed by R2 (bucket: jianshuo-dev-files, binding: FILES)
//
// Auth tiers (resolved per request):
//   1. Bearer == env.FILES_TOKEN     -> ADMIN. Full bucket, raw keys. Back-compat
//                                       with the old single-token flow and王建硕's
//                                       Mac pipeline (voicedrop-inbox.sh).
//   2. Bearer == session JWT (HS256, -> USER. Scoped to "users/<sub>/" only. <sub>
//      signed with env.SESSION_SECRET)  is the stable Sign-in-with-Apple user id.
//
// Routes:
//   POST   /files/api/auth/apple       body {identityToken} -> verify w/ Apple JWKS,
//                                       mint a long-lived session JWT for this user.
//   GET    /files/api/list             -> JSON list (admin: all keys; user: own prefix)
//   PUT    /files/api/upload/<name>    -> upload (raw body)
//   GET    /files/api/download/<name>  -> download
//   DELETE /files/api/file/<name>      -> delete
//
// New env needed:
//   SESSION_SECRET   (Pages secret) — HMAC key for minting/verifying session JWTs
//   APPLE_BUNDLE_ID  (var)          — expected `aud`, the iOS app bundle id

export async function onRequest(context) {
  const { request, env, params } = context;
  const segments = Array.isArray(params.path) ? params.path : [params.path || ''];
  const action = segments[0] || '';
  const sub2 = segments[1] || '';
  const name = decodeURIComponent(segments.slice(1).join('/'));
  const url = new URL(request.url);

  // ---- Unauthenticated: exchange an Apple identity token for a session ----
  if (request.method === 'POST' && action === 'auth' && sub2 === 'apple') {
    if (!env.SESSION_SECRET) return json({ error: 'server misconfigured: no SESSION_SECRET' }, 500);
    let idToken = '';
    try {
      const body = await request.json();
      idToken = (body && (body.identityToken || body.id_token)) || '';
    } catch { idToken = (await request.text()).trim(); }
    if (!idToken) return json({ error: 'missing identityToken' }, 400);
    let sub;
    try {
      sub = await verifyAppleIdentityToken(idToken, env.APPLE_BUNDLE_ID || 'com.wangjianshuo.VoiceDrop');
    } catch (e) {
      return json({ error: 'invalid apple token', detail: String(e.message || e) }, 401);
    }
    const session = await mintSession(sub, env.SESSION_SECRET);
    return json({ session, sub });
  }

  // ---- Authenticate every other route ----
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';

  let scope = null; // null = unauthorized, '' = admin/full bucket, 'users/<sub>/' = user
  if (env.FILES_TOKEN && token === env.FILES_TOKEN) {
    scope = '';
  } else if (token && env.SESSION_SECRET) {
    const sub = await verifySession(token, env.SESSION_SECRET);
    if (sub) scope = `users/${sanitizeSeg(sub)}/`;
  }
  if (scope === null) return json({ error: 'unauthorized' }, 401);

  // Guard: a user-supplied name must not escape its scope.
  function keyFor(n) {
    if (!n) return null;
    if (n.startsWith('/') || n.split('/').some((s) => s === '..')) return null;
    return scope + n;
  }

  if (request.method === 'GET' && action === 'list') {
    const opts = { limit: 1000 };
    if (scope) opts.prefix = scope;
    const listed = await env.FILES.list(opts);
    const files = listed.objects.map((o) => ({
      name: scope ? o.key.slice(scope.length) : o.key,
      size: o.size,
      uploaded: o.uploaded,
    }));
    return json({ files });
  }

  if ((request.method === 'PUT' || request.method === 'POST') && action === 'upload' && name) {
    const key = keyFor(name);
    if (!key) return json({ error: 'bad name' }, 400);
    await env.FILES.put(key, request.body, {
      httpMetadata: {
        contentType: request.headers.get('Content-Type') || 'application/octet-stream',
      },
    });
    return json({ ok: true, name });
  }

  if (request.method === 'GET' && action === 'download' && name) {
    const key = keyFor(name);
    if (!key) return json({ error: 'bad name' }, 400);
    const object = await env.FILES.get(key);
    if (!object) return json({ error: 'not found' }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': String(object.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name.split('/').pop())}`,
      },
    });
  }

  if (request.method === 'DELETE' && action === 'file' && name) {
    const key = keyFor(name);
    if (!key) return json({ error: 'bad name' }, 400);
    await env.FILES.delete(key);
    return json({ ok: true });
  }

  return json({ error: 'bad request' }, 400);
}

// ---------------------------------------------------------------------------
// Apple "Sign in with Apple" identity-token verification (RS256 over JWKS).
// ---------------------------------------------------------------------------
let _appleKeys = null;
let _appleKeysAt = 0;
async function getAppleKeys() {
  const now = Date.now();
  if (_appleKeys && now - _appleKeysAt < 6 * 3600 * 1000) return _appleKeys;
  const resp = await fetch('https://appleid.apple.com/auth/keys');
  if (!resp.ok) throw new Error('cannot fetch apple keys');
  const data = await resp.json();
  _appleKeys = data.keys;
  _appleKeysAt = now;
  return _appleKeys;
}

async function verifyAppleIdentityToken(idToken, expectedAud) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const header = JSON.parse(b64urlToString(h));
  const payload = JSON.parse(b64urlToString(p));
  const keys = await getAppleKeys();
  const jwk = keys.find((k) => k.kid === header.kid && k.alg === (header.alg || 'RS256'));
  if (!jwk) throw new Error('no matching apple key');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!ok) throw new Error('bad signature');
  if (payload.iss !== 'https://appleid.apple.com') throw new Error('bad iss');
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(expectedAud)) throw new Error(`bad aud: ${payload.aud}`);
  if (!payload.sub) throw new Error('no sub');
  if (payload.exp * 1000 < Date.now()) throw new Error('expired');
  return payload.sub;
}

// ---------------------------------------------------------------------------
// Stateless session JWT (HS256). No KV — verified by HMAC on every request.
// ---------------------------------------------------------------------------
async function mintSession(sub, secret) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ sub, iat: now, exp: now + 365 * 24 * 3600 }));
  const sig = await hmacSign(`${h}.${p}`, secret);
  return `${h}.${p}.${sig}`;
}

async function verifySession(tokenStr, secret) {
  const parts = tokenStr.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = await hmacSign(`${h}.${p}`, secret);
  if (!timingSafeEqual(s, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToString(p)); } catch { return null; }
  if (!payload.sub) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload.sub;
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function sanitizeSeg(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, '_'); }

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function b64url(str) { return bytesToB64url(new TextEncoder().encode(str)); }
function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) { return new TextDecoder().decode(b64urlToBytes(s)); }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
