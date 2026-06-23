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
    // Bind (alias) this Apple identity to a data box. If we've seen this sub,
    // reuse its bound scope; otherwise bind it to the caller's current anon box
    // (no data moves) or a fresh users/<sub>/ if they have none.
    const linkKey = `links/apple-${sanitizeSeg(sub)}.json`;
    let scope = null;
    const existing = await env.FILES.get(linkKey);
    if (existing) {
      try { scope = JSON.parse(await existing.text()).scope; } catch {}
    }
    if (!scope) {
      const callerAnon = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      scope = (await anonScopeFromToken(callerAnon)) || `users/${sanitizeSeg(sub)}/`;
      const now = Date.now();
      await env.FILES.put(linkKey, JSON.stringify({ scope, linkedAt: now }),
        { httpMetadata: { contentType: 'application/json' } });
      await env.FILES.put(`${scope}ACCOUNT.json`, JSON.stringify({ appleSub: sub, linkedAt: now }),
        { httpMetadata: { contentType: 'application/json' } });
    }
    const session = await mintSession(scope, true, env.SESSION_SECRET);
    return json({ session, scope });
  }

  // ---- Public (no auth): WeChat cover assets in assets/wechat-covers/ ----
  // Non-sensitive cover images, read by the publish relay + the miner to pick a
  // per-article cover by hash. Restricted to that one prefix, GET only.
  if (request.method === 'GET' && action === 'asset' && sub2 === 'wechat-covers') {
    const rel = name.slice('wechat-covers/'.length); // '' => listing
    if (!rel) {
      const listed = await env.FILES.list({ prefix: 'assets/wechat-covers/', limit: 1000 });
      const covers = listed.objects
        .map((o) => o.key.slice('assets/wechat-covers/'.length))
        .filter((n) => n && !n.endsWith('/'));
      return json({ covers });
    }
    if (rel.includes('..') || rel.startsWith('/')) return json({ error: 'bad name' }, 400);
    const obj = await env.FILES.get('assets/wechat-covers/' + rel);
    if (!obj) return json({ error: 'not found' }, 404);
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'image/png',
        'Content-Length': String(obj.size),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // ---- Authenticate every other route ----
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';

  let scope = null; // null = unauthorized, '' = admin/full bucket, 'users/<id>/' = user
  let readonly = false;
  let apple = false; // true only for an Apple-verified session JWT (community write gate)
  if (env.FILES_TOKEN && token === env.FILES_TOKEN) {
    scope = '';
  } else if (token) {
    const sess = env.SESSION_SECRET ? await verifySession(token, env.SESSION_SECRET) : null;
    if (sess) {
      // Signed-in (Sign in with Apple) user — scope is carried in the JWT.
      scope = sess.scope;
      apple = sess.apple;
    } else {
      // Try 24 h read-only temp token (issued by GET /token/articles).
      const tempScope = env.SESSION_SECRET ? await verifyTempToken(token, env.SESSION_SECRET) : null;
      if (tempScope) {
        scope = tempScope;
        readonly = true;
      } else if (token.startsWith('anon_') && token.length >= 20) {
        // Anonymous capability token: a high-entropy secret the app generates on
        // first launch and stores in the user's iCloud Keychain (zero-login,
        // same Apple ID -> same token across devices). Possession = access.
        // Scope by a hash so the secret itself is never the directory name.
        const id = (await sha256hex(token)).slice(0, 32);
        scope = `users/anon-${id}/`;
      }
    }
  }
  if (scope === null) return json({ error: 'unauthorized' }, 401);
  // Read-only tokens may only list and download.
  if (readonly && !(request.method === 'GET' && (action === 'list' || action === 'download'))) {
    return json({ error: 'read-only token' }, 403);
  }

  // Guard: a user-supplied name must not escape its scope.
  function keyFor(n) {
    if (!n) return null;
    if (n.startsWith('/') || n.split('/').some((s) => s === '..')) return null;
    return scope + n;
  }

  // Mint a 24 h read-only articles link for the current user's scope.
  if (request.method === 'GET' && action === 'token' && sub2 === 'articles') {
    if (!scope) return json({ error: 'admin cannot use this endpoint' }, 403);
    if (!env.SESSION_SECRET) return json({ error: 'server misconfigured: no SESSION_SECRET' }, 500);
    const t = await mintTempToken(scope, env.SESSION_SECRET);
    const pageURL = `${url.origin}/voicedrop/articles?t=${encodeURIComponent(t)}`;
    return json({ token: t, url: pageURL, expires_in: 86400 });
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
    // A new recording → kick the miner. Fire-and-forget so the upload returns
    // immediately; the mine.yml `concurrency: mine` group coalesces bursts into
    // at most one running + one queued run.
    const leaf = name.split('/').pop() || name;
    if (leaf.startsWith('VoiceDrop-') && leaf.endsWith('.m4a')) {
      context.waitUntil(dispatchMine(env));
    }
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

  // Mint a SHORT public share link for one mined article JSON. The id is the
  // first 10 chars of HMAC(key) — deterministic (same article → same link),
  // unguessable (~60 bits), and resolved via a tiny shares/<id> → key record in
  // R2. Only this user's own articles/<stem>.json is shareable. The public page
  // lives at /voicedrop/<id> (functions/voicedrop/[token].js).
  if (request.method === 'GET' && action === 'share' && name) {
    if (!env.SESSION_SECRET) return json({ error: 'server misconfigured: no SESSION_SECRET' }, 500);
    const key = keyFor(name);
    if (!key || !/^users\/[^/]+\/articles\/[^/]+\.json$/.test(key)) {
      return json({ error: 'not shareable' }, 400);
    }
    const id = (await hmacSign('share:' + key, env.SESSION_SECRET)).slice(0, 10);
    await env.FILES.put(`shares/${id}`, key);
    return json({ url: `${url.origin}/voicedrop/${id}` });
  }

  // On-demand WeChat draft push for ONE mined article. The app calls this when
  // the user taps 发布微信公众号草稿. WeChat's API only works from the whitelisted
  // Tokyo proxy (in GitHub Actions), so we can't push from here — instead dispatch
  // publish-wechat.yml with the full article key. It creates the draft, or updates
  // the existing one in place if this article was published before. Async (~1 min).
  if (request.method === 'POST' && action === 'wechat' && name) {
    const key = keyFor(name);
    if (!key || !/^users\/[^/]+\/articles\/[^/]+\.json$/.test(key)) {
      return json({ error: 'not publishable' }, 400);
    }
    const prefix = key.slice(0, key.indexOf('/articles/') + 1);   // users/<sub>/
    // WeChat creds. Missing appid/secret → 409 so the app reopens the config sheet.
    let wc = null;
    const wcObj = await env.FILES.get(prefix + 'WECHAT.json');
    if (wcObj) { try { wc = JSON.parse(await wcObj.text()); } catch {} }
    if (!wc || !wc.appid || !wc.secret) return json({ error: 'wechat_not_configured' }, 409);

    // Load the article doc.
    const docObj = await env.FILES.get(key);
    if (!docObj) return json({ error: 'not found' }, 404);
    let doc;
    try { doc = JSON.parse(await docObj.text()); } catch { return json({ error: 'bad article' }, 500); }

    // Publish SYNCHRONOUSLY via the Tokyo VPS relay — its IP is WeChat-whitelisted,
    // so it calls api.weixin.qq.com directly and returns the real result (vs. the old
    // fire-and-forget GitHub Action). The relay holds no R2 token; we persist here.
    if (!env.WECHAT_RELAY_URL || !env.WECHAT_RELAY_SECRET) {
      return json({ error: 'relay_not_configured' }, 500);
    }
    let relay;
    try {
      const rr = await fetch(env.WECHAT_RELAY_URL, {
        method: 'POST',
        headers: { 'X-Relay-Secret': env.WECHAT_RELAY_SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid: wc.appid, secret: wc.secret, cover_media_ids: wc.coverMediaIds || {}, article: doc }),
      });
      relay = await rr.json().catch(() => null);
      if (!rr.ok) return json({ error: 'relay_error', detail: relay }, 502);
    } catch (e) {
      return json({ error: 'relay_unreachable', detail: String((e && e.message) || e) }, 502);
    }
    // A real WeChat-side failure: relay the actual errcode/errmsg to the app.
    if (!relay || relay.ok !== true) {
      return json({ error: 'wechat', errcode: relay && relay.errcode, errmsg: relay && relay.errmsg }, 502);
    }

    // Persist: the article now carries wechatMediaId(s); the cover thumb may be new.
    await env.FILES.put(key, JSON.stringify(relay.article), { httpMetadata: { contentType: 'application/json' } });
    if (relay.cover_media_ids && JSON.stringify(relay.cover_media_ids) !== JSON.stringify(wc.coverMediaIds || {})) {
      wc.coverMediaIds = relay.cover_media_ids;
      await env.FILES.put(prefix + 'WECHAT.json', JSON.stringify(wc), { httpMetadata: { contentType: 'application/json' } });
    }
    return json({ ok: true, created: relay.created || 0, updated: relay.updated || 0 });
  }

  // ── Community: a shared, cross-user space of article snapshots ────────────
  // Share (or re-share) one of the user's own articles to the community. The
  // snapshot is a COPY — later edits don't change it until re-shared. shareId is
  // derived from the article key so re-sharing updates the same post in place,
  // and firstSharedAt is preserved for stable newest-first ordering.
  if (request.method === 'POST' && action === 'community' && sub2 === 'share') {
    if (!scope) return json({ error: 'admin cannot share' }, 403);
    if (!env.SESSION_SECRET) return json({ error: 'server misconfigured' }, 500);
    const articleKey = keyFor(decodeURIComponent(segments.slice(2).join('/')));
    if (!articleKey || !/^users\/[^/]+\/articles\/[^/]+\.json$/.test(articleKey)) {
      return json({ error: 'not shareable' }, 400);
    }
    const obj = await env.FILES.get(articleKey);
    if (!obj) return json({ error: 'article not found' }, 404);
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return json({ error: 'bad article' }, 400); }
    const articles = (Array.isArray(doc.articles) && doc.articles.length)
      ? doc.articles
      : (doc.body ? [{ title: doc.title || '(无题)', body: doc.body }] : []);
    if (!articles.length) return json({ error: 'empty article' }, 400);
    let author = '匿名';
    const md = await env.FILES.get(scope + 'CLAUDE.md');
    if (md) { const m = (await md.text()).match(/#\s*我的名字\s*\n+([^\n#]+)/); if (m && m[1].trim()) author = m[1].trim(); }
    const shareId = (await hmacSign('community:' + articleKey, env.SESSION_SECRET)).slice(0, 12);
    const communityKey = `community/${shareId}.json`;
    let firstSharedAt = Date.now();
    const existing = await env.FILES.get(communityKey);
    if (existing) { try { firstSharedAt = JSON.parse(await existing.text()).firstSharedAt || firstSharedAt; } catch {} }
    const post = {
      schema: 1, shareId, owner: scope, author,
      title: articles[0].title,
      articles: articles.map((a) => ({ title: a.title, body: a.body })),
      firstSharedAt, updatedAt: Date.now(),
    };
    await env.FILES.put(communityKey, JSON.stringify(post), { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true, shareId });
  }

  // List community posts (metadata only), newest-first by first-share time.
  if (request.method === 'GET' && action === 'community' && sub2 === 'list') {
    const listed = await env.FILES.list({ prefix: 'community/', limit: 1000 });
    const posts = [];
    for (const o of listed.objects.slice(0, 200)) {
      const obj = await env.FILES.get(o.key);
      if (!obj) continue;
      try {
        const p = JSON.parse(await obj.text());
        posts.push({ shareId: p.shareId, author: p.author, title: p.title,
                     firstSharedAt: p.firstSharedAt, updatedAt: p.updatedAt,
                     count: (p.articles || []).length, mine: p.owner === scope });
      } catch {}
    }
    posts.sort((a, b) => (b.firstSharedAt || 0) - (a.firstSharedAt || 0));
    return json({ posts });
  }

  // Un-share (delete) a community post — owner only.
  if (request.method === 'POST' && action === 'community' && sub2 === 'unshare') {
    if (!scope) return json({ error: 'unauthorized' }, 403);
    const shareId = segments[2] || '';
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(shareId)) return json({ error: 'bad id' }, 400);
    const key = `community/${shareId}.json`;
    const obj = await env.FILES.get(key);
    if (!obj) return json({ ok: true });                 // already gone
    let owner = null;
    try { owner = JSON.parse(await obj.text()).owner; } catch {}
    if (owner !== scope) return json({ error: 'not owner' }, 403);
    await env.FILES.delete(key);
    return json({ ok: true });
  }

  // Get one community post (full snapshot).
  if (request.method === 'GET' && action === 'community' && sub2 === 'get') {
    const shareId = segments[2] || '';
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(shareId)) return json({ error: 'bad id' }, 400);
    const obj = await env.FILES.get(`community/${shareId}.json`);
    if (!obj) return json({ error: 'not found' }, 404);
    return new Response(obj.body, { headers: { 'Content-Type': 'application/json' } });
  }

  // Whether the user's own article is currently shared to the community (for the
  // 分享 / 更新 label on the article ⋯ menu).
  if (request.method === 'GET' && action === 'community' && sub2 === 'shared') {
    if (!scope || !env.SESSION_SECRET) return json({ shared: false });
    const articleKey = keyFor(decodeURIComponent(segments.slice(2).join('/')));
    if (!articleKey || !/^users\/[^/]+\/articles\/[^/]+\.json$/.test(articleKey)) return json({ shared: false });
    const shareId = (await hmacSign('community:' + articleKey, env.SESSION_SECRET)).slice(0, 12);
    const exists = await env.FILES.head(`community/${shareId}.json`);
    return json({ shared: !!exists });
  }

  // "加急处理": let a signed-in app user kick the article miner now instead of
  // waiting for the hourly cron. The GitHub token lives only as a Pages secret.
  if (request.method === 'POST' && action === 'mine') {
    const r = await dispatchMine(env);
    if (r.ok) return json({ ok: true });
    return json({ error: 'dispatch failed', detail: r.detail }, r.status === 0 ? 500 : 502);
  }

  return json({ error: 'bad request' }, 400);
}

// Dispatch the GitHub article-miner workflow (mine.yml). Used by POST /mine
// (加急处理) and automatically on every new VoiceDrop-*.m4a upload.
async function dispatchMine(env) {
  return dispatchWorkflow(env, 'mine.yml');
}

// Fire a repository workflow_dispatch on jianshuo/voicedrop. `inputs` is optional
// (mine.yml takes none; publish-wechat.yml takes {article_key}). The GitHub token
// lives only as a Pages secret.
async function dispatchWorkflow(env, workflow, inputs) {
  if (!env.GH_DISPATCH_TOKEN) return { ok: false, status: 0, detail: 'no GH_DISPATCH_TOKEN' };
  try {
    const body = { ref: 'main' };
    if (inputs) body.inputs = inputs;
    const gh = await fetch(`https://api.github.com/repos/jianshuo/voicedrop/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'voicedrop-files',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(body),
    });
    if (gh.status === 204) return { ok: true, status: 204, detail: '' };
    return { ok: false, status: gh.status, detail: (await gh.text()).slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, detail: String(e && e.message || e) };
  }
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
async function mintTempToken(scope, secret) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ scope, ro: true, iat: now, exp: now + 86400 }));
  const sig = await hmacSign(`${h}.${p}`, secret);
  return `${h}.${p}.${sig}`;
}

async function verifyTempToken(tokenStr, secret) {
  const parts = tokenStr.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = await hmacSign(`${h}.${p}`, secret);
  if (!timingSafeEqual(s, expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToString(p)); } catch { return null; }
  if (!payload.scope || !payload.ro) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload.scope;
}

async function mintSession(scope, apple, secret) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ scope, apple: !!apple, iat: now, exp: now + 365 * 24 * 3600 }));
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
  if (!payload.scope) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return { scope: payload.scope, apple: !!payload.apple };
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

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The users/anon-<hash>/ scope an anon token maps to (mirrors the inline anon logic).
async function anonScopeFromToken(token) {
  if (!token || !token.startsWith('anon_') || token.length < 20) return null;
  const id = (await sha256hex(token)).slice(0, 32);
  return `users/anon-${id}/`;
}

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
