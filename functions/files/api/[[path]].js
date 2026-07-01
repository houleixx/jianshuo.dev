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

import { readArticleDoc, writeArticleDoc, setHead, resolveArticles, withTopLevelArticles } from "../../lib/article-store.js";
import { readStyleDoc, writeStyleDoc, setStyleHead, resolveStyle, parseStyleMarkdown, readProfileName, mergeProfile, ensureStyleSeeded, isDefaultSeed } from "../../lib/style-store.js";
import { sanitizeSeg, sha256hex, timingSafeEqual, bytesToB64url, b64urlToBytes, b64urlToString, b64url, hmacSign, verifySession, anonScopeFromToken } from "../../lib/auth.js";
import { checkArticlesShareable } from "../../lib/moderation.js";

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
    let idToken = '', bodyName = null, bodyEmail = null;
    try {
      const body = await request.json();
      idToken = (body && (body.identityToken || body.id_token)) || '';
      bodyName = (body && body.fullName) || null;   // present only on the user's FIRST authorization
      bodyEmail = (body && body.email) || null;
    } catch { idToken = (await request.text()).trim(); }
    if (!idToken) return json({ error: 'missing identityToken' }, 400);
    let sub, tokenEmail = null;
    try {
      const verified = await verifyAppleIdentityToken(idToken, env.APPLE_BUNDLE_ID || 'com.wangjianshuo.VoiceDrop');
      sub = verified.sub; tokenEmail = verified.email;
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
    const now = Date.now();
    if (!scope) {
      const callerAnon = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      scope = (await anonScopeFromToken(callerAnon)) || `users/${sanitizeSeg(sub)}/`;
      await env.FILES.put(linkKey, JSON.stringify({ scope, linkedAt: now }),
        { httpMetadata: { contentType: 'application/json' } });
    }
    // Persist the Apple-provided identity. fullName is handed over ONLY on the first
    // authorization (and again only if the user revokes + re-grants), so it is
    // first-write-wins; email rides in the verified token and is refreshed each sign-in.
    // Merge so a later null never clobbers a previously-captured name.
    {
      const acctKey = `${scope}ACCOUNT.json`;
      let acct = {};
      const acctObj = await env.FILES.get(acctKey);
      if (acctObj) { try { acct = JSON.parse(await acctObj.text()); } catch {} }
      acct.appleSub = sub;
      if (!acct.linkedAt) acct.linkedAt = now;
      acct.lastSeenAt = now;
      const email = tokenEmail || bodyEmail;
      if (email) acct.email = email;
      if (bodyName && !acct.name) acct.name = bodyName;
      await env.FILES.put(acctKey, JSON.stringify(acct),
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

  // ---- Public (no auth): a session photo by its full R2 key ----
  // GET photo/<users/<sub>/photos/.../x.jpg> — the ONE photo endpoint used everywhere
  // (VD社区, the public /voicedrop share page, exported HTML, anywhere): render straight
  // from the photo's original R2 location as a plain <img src>. No token, no per-post
  // reference check. The only guard is a file-type allowlist — it can serve ONLY
  // `users/*/photos/*.(jpg|jpeg|png)`, never articles or credentials (WECHAT.json) —
  // plus a `..` traversal block. Photo keys carry a hashed user id + timestamp + random
  // tail, so a full key is effectively unguessable; only keys already embedded in shared
  // content are ever visible. CORS `*` + public cache so any page can load + cache it.
  if (request.method === 'GET' && action === 'photo') {
    const key = decodeURIComponent(segments.slice(1).join('/'));
    if (key.includes('..') || !/^users\/[^/]+\/photos\/.+\.(jpe?g|png)$/i.test(key)) {
      return json({ error: 'not a photo' }, 400);
    }
    const obj = await env.FILES.get(key);
    if (!obj) return json({ error: 'not found' }, 404);
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
        'Content-Length': String(obj.size),
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
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
  if (readonly && !((request.method === 'GET' || request.method === 'HEAD') && (action === 'list' || action === 'download'))) {
    return json({ error: 'read-only token' }, 403);
  }

  // Guard: a user-supplied name must not escape its scope.
  function keyFor(n) {
    if (!n) return null;
    if (n.startsWith('/') || n.split('/').some((s) => s === '..')) return null;
    return scope + n;
  }

  // Who am I — returns the caller's resolved data scope ("users/<sub>/"). The app
  // caches it once, then joins scope + a relative photo key to build the full R2 key
  // and load its OWN photos from the same public /photo/<key> endpoint the community +
  // share pages use — one photo logic everywhere. (Admin scope is "".)
  if (request.method === 'GET' && action === 'whoami') {
    return json({ scope });
  }

  // Mint a 24 h read-only articles link for the current user's scope.
  if (request.method === 'GET' && action === 'token' && sub2 === 'articles') {
    if (!scope) return json({ error: 'admin cannot use this endpoint' }, 403);
    if (!env.SESSION_SECRET) return json({ error: 'server misconfigured: no SESSION_SECRET' }, 500);
    const t = await mintTempToken(scope, env.SESSION_SECRET);
    const pageURL = `${url.origin}/voicedrop/articles?t=${encodeURIComponent(t)}`;
    return json({ token: t, url: pageURL, expires_in: 86400 });
  }

  // ── Admin-only: LLM interaction log (voicedrop/admin/llm.html) ──────────
  // Records written by mine.py + the agent worker live under llmlogs/<date>/.
  // `dates` lists the day-folders (newest first); `list?date=YYYY-MM-DD` lists
  // that day's entries (reversed → newest first within the page, ?cursor= pages
  // a very busy day). Reading a single record reuses GET /download/<key>.
  if (request.method === 'GET' && action === 'llmlog') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    if (sub2 === 'dates') {
      const listed = await env.FILES.list({ prefix: 'llmlogs/', delimiter: '/', limit: 1000 });
      const dates = (listed.delimitedPrefixes || [])
        .map((p) => p.slice('llmlogs/'.length).replace(/\/$/, ''))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort().reverse();
      return json({ dates });
    }
    if (sub2 === 'list') {
      const date = url.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date=YYYY-MM-DD required' }, 400);
      const cursor = url.searchParams.get('cursor') || undefined;
      const listed = await env.FILES.list({ prefix: `llmlogs/${date}/`, cursor, limit: 200 });
      const objects = listed.objects
        .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
        .reverse();
      return json({ objects, cursor: listed.truncated ? listed.cursor : null, truncated: !!listed.truncated });
    }
    return json({ error: 'unknown llmlog action' }, 404);
  }

  // ── Admin-only: mine run log (voicedrop/admin/mine.html) ─────────────────────
  // Per-audio events written by miner.js under minelogs/<date>/<ts>-<stem>.json.
  if (request.method === 'GET' && action === 'minelog') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    if (sub2 === 'dates') {
      const listed = await env.FILES.list({ prefix: 'minelogs/', delimiter: '/', limit: 1000 });
      const dates = (listed.delimitedPrefixes || [])
        .map((p) => p.slice('minelogs/'.length).replace(/\/$/, ''))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort().reverse();
      return json({ dates });
    }
    if (sub2 === 'list') {
      const date = url.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date=YYYY-MM-DD required' }, 400);
      const cursor = url.searchParams.get('cursor') || undefined;
      const listed = await env.FILES.list({ prefix: `minelogs/${date}/`, cursor, limit: 200 });
      const objects = listed.objects
        .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
        .reverse();
      return json({ objects, cursor: listed.truncated ? listed.cursor : null, truncated: !!listed.truncated });
    }
    return json({ error: 'unknown minelog action' }, 404);
  }

  if (request.method === 'GET' && action === 'list') {
    const opts = { limit: 1000 };
    if (scope) opts.prefix = scope;
    const allObjects = [];
    let cursor;
    do {
      if (cursor) opts.cursor = cursor;
      const listed = await env.FILES.list(opts);
      allObjects.push(...listed.objects);
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    const files = allObjects.map((o) => ({
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
      httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
    });
    // A new recording → kick the miner. Fire-and-forget so the upload returns
    // immediately; the mine.yml `concurrency: mine` group coalesces bursts into
    // at most one running + one queued run.
    const leaf = name.split('/').pop() || name;
    if (leaf.startsWith('VoiceDrop-') && leaf.endsWith('.m4a')) {
      const userAuth = request.headers.get('Authorization') || '';
      context.waitUntil(dispatchMine(userAuth));
    }
    return json({ ok: true, name });
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && action === 'download' && name) {
    const key = keyFor(name);
    if (!key) return json({ error: 'bad name' }, 400);
    // Build-61 compat: old iOS builds (≤ build 77) read the article doc via this
    // raw /download/articles/<stem>.json route and expect a top-level `articles`.
    // Schema-3 docs keep content under versions[head], so those builds got an
    // empty doc and showed 还没成文 even when the list said 已成文. Resolve it here
    // via the same single withTopLevelArticles/resolveArticles as everywhere else,
    // so legacy raw-download clients work without an app update. Newer builds use
    // GET /articles/<stem> and never reach this branch.
    // Only the real article doc (articles/<stem>.json) gets the schema-3→top-level
    // compat transform. EXCLUDE sidecars that also live under articles/ and end in
    // .json (e.g. the resumable-ASR task sidecar <stem>.asr.json) — those must be
    // served RAW, never run through readArticleDoc/migrateToV3 (which would wrap them
    // in a misleading {head,versions,articles} shape).
    if (request.method === 'GET' && /\/articles\/[^/]+\.json$/.test(key) && !key.endsWith('.asr.json')) {
      const doc = await readArticleDoc(env, key);
      if (doc) return json(withTopLevelArticles(doc));
    }
    const object = request.method === 'HEAD' ? await env.FILES.head(key) : await env.FILES.get(key);
    if (!object) return json({ error: 'not found' }, 404);
    const headers = {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Length': String(object.size),
    };
    if (request.method === 'GET') {
      headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(name.split('/').pop())}`;
    }
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
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

    // Load the article doc (schema-3; current content = versions[head]).
    const doc = await readArticleDoc(env, key);
    if (!doc) return json({ error: 'not found' }, 404);
    const currentArticles = resolveArticles(doc);
    // Relay expects a flat article object with top-level `articles`.
    const relayDoc = { ...doc, articles: currentArticles };
    delete relayDoc.versions; delete relayDoc.head;

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
        // `owner` (= users/<sub>/) lets the relay resolve the body's [[photo:<relkey>]]
        // markers to full keys and embed those session photos into the draft.
        body: JSON.stringify({ appid: wc.appid, secret: wc.secret, owner: prefix, cover_media_ids: wc.coverMediaIds || {}, article: relayDoc }),
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

    // Persist: the relay returns the article with wechatMediaId(s) added.
    // Merge updated articles back into the current doc and write as a new version.
    await writeArticleDoc(env, key, { ...doc, articles: relay.article.articles ?? currentArticles }, 'wechat');
    if (relay.cover_media_ids && JSON.stringify(relay.cover_media_ids) !== JSON.stringify(wc.coverMediaIds || {})) {
      wc.coverMediaIds = relay.cover_media_ids;
      await env.FILES.put(prefix + 'WECHAT.json', JSON.stringify(wc), { httpMetadata: { contentType: 'application/json' } });
    }
    return json({ ok: true, created: relay.created || 0, updated: relay.updated || 0 });
  }

  // ── Community: live-linked cross-user article space ─────────────────────
  // Posts are schema-2 pointers: {schema:2, shareId, owner, articleKey, author,
  // firstSharedAt}. Content is always read from the live article — edits to the
  // source article are immediately visible in the community.

  // Run async `fn` over `items` with bounded concurrency, preserving input order.
  // The community list/replies need ~2 R2 reads per post; doing them serially made
  // those endpoints take 7–12s for ~27 posts. This fans them out (capped so we stay
  // well under the Workers subrequest budget even for a large community).
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const idx = next++;
        out[idx] = await fn(items[idx], idx);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
  }

  // resolveArticles is imported from ../../lib/article-store.js (single source of truth).

  // A schema-2 community post is a pointer to a live article; its title/body are
  // read fresh from `articleKey` every time. When the user deletes the underlying
  // recording, that article JSON is gone — the post then renders as an empty,
  // titleless row that opens to "这篇分享已不可用". This resolves the live doc for a
  // pointer and self-heals orphans:
  //   • live article present        → return the parsed doc (display it).
  //   • article gone, audio gone too → whole recording was deleted → reap the
  //     orphan pointer and return null (gone for good).
  //   • article gone, audio present  → article is mid-重新生成 (delete-then-remine);
  //     keep the pointer, return null so the post is hidden until the re-mine lands.
  // Returns null for legacy schema-1 posts (no articleKey, inline content) — callers
  // fall back to their stored content for those.
  async function liveDocForPointer(pointerKey, p) {
    if (!p.articleKey) return null;
    const liveObj = await env.FILES.get(p.articleKey);
    if (liveObj) { try { return JSON.parse(await liveObj.text()); } catch { return null; } }
    const audioKey = p.articleKey.replace('/articles/', '/').replace(/\.json$/, '.m4a');
    if (!(await env.FILES.head(audioKey))) await env.FILES.delete(pointerKey);
    return null;
  }

  // Share (or re-share) one of the user's own articles. Writes a schema-2 pointer
  // with no content copy. shareId is HMAC-derived from the article key so re-sharing
  // updates the same post in place; firstSharedAt is preserved.
  if (request.method === 'POST' && action === 'community' && sub2 === 'share') {
    if (!scope) return json({ error: 'admin cannot share' }, 403);
    if (!env.SESSION_SECRET) return json({ error: 'server misconfigured' }, 500);
    // Community write gate: posting to the shared space requires an Apple-verified
    // identity (accountability). A bare anon/temp token gets 403 needs_apple_signin,
    // which the app catches -> presents the Apple sheet -> binds -> retries the share.
    if (!apple) return json({ error: 'needs_apple_signin' }, 403);
    const articleKey = keyFor(decodeURIComponent(segments.slice(2).join('/')));
    if (!articleKey || !/^users\/[^/]+\/articles\/[^/]+\.json$/.test(articleKey)) {
      return json({ error: 'not shareable' }, 400);
    }
    const obj = await env.FILES.get(articleKey);
    if (!obj) return json({ error: 'article not found' }, 404);
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return json({ error: 'bad article' }, 400); }
    const articles = resolveArticles(doc);
    if (!articles.length) return json({ error: 'empty article' }, 400);
    // Apple 1.2 filter (proactive, zero-cost): scan the article for objectionable
    // keywords at SHARE time — flagged content can never be published to the public
    // community. (A legacy doc.moderation.flagged from the old LLM pass is also honored.)
    if (doc.moderation && doc.moderation.flagged) {
      return json({ error: 'content_flagged', categories: doc.moderation.categories || [] }, 403);
    }
    const kw = await checkArticlesShareable(articles, env);
    if (kw.flagged) return json({ error: 'content_flagged', term: kw.term }, 403);
    // Author = profile.name (CLAUDE.json) → legacy CLAUDE.md「# 我的名字」→ 匿名.
    const author = (await readProfileName(env, scope + 'CLAUDE.json', scope + 'CLAUDE.md')) || '匿名';
    const shareId = (await hmacSign('community:' + articleKey, env.SESSION_SECRET)).slice(0, 12);
    const communityKey = `community/${shareId}.json`;
    let replyTo = null;
    try { const body = await request.clone().json(); replyTo = (body && body.replyTo) || null; } catch {}
    let firstSharedAt = Date.now();
    let existingReplyTo = null;
    const existing = await env.FILES.get(communityKey);
    if (existing) {
      try { const ep = JSON.parse(await existing.text()); firstSharedAt = ep.firstSharedAt || firstSharedAt; existingReplyTo = ep.replyTo || null; } catch {}
    }
    if (!replyTo) replyTo = existingReplyTo;
    const post = { schema: 2, shareId, owner: scope, articleKey, author, firstSharedAt,
                   ...(replyTo ? { replyTo } : {}) };
    await env.FILES.put(communityKey, JSON.stringify(post), { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true, shareId });
  }

  // List community posts (metadata only), newest-first by first-share time.
  // Reads the live article for each schema-2 post to get current title and count.
  if (request.method === 'GET' && action === 'community' && sub2 === 'list') {
    const listed = await env.FILES.list({ prefix: 'community/', limit: 1000 });
    // Apple 1.2: a reported post is HIDDEN immediately (pending owner review). Report
    // markers live at community/reports/<shareId>.json; drop those shareIds from the feed.
    const hidden = new Set(listed.objects
      .filter(o => /^community\/reports\/[^/]+\.json$/.test(o.key))
      .map(o => o.key.replace('community/reports/', '').replace(/\.json$/, '')));
    const postObjects = listed.objects
      .filter(o => /^community\/[^/]+\.json$/.test(o.key))
      .filter(o => !hidden.has(o.key.replace('community/', '').replace(/\.json$/, '')))
      .slice(0, 200);
    // Fan out the per-post reads (pointer + live article) — see mapLimit above.
    const results = await mapLimit(postObjects, 32, async (o) => {
      const obj = await env.FILES.get(o.key);
      if (!obj) return null;
      try {
        const p = JSON.parse(await obj.text());
        // Seed from stored data (schema-1 fallback); overwrite with live article for schema-2.
        let title = p.title || '', count = (p.articles || []).length, updatedAt = p.updatedAt || p.firstSharedAt;
        if (p.articleKey) {
          const live = await liveDocForPointer(o.key, p);
          if (!live) return null;   // orphan (reaped) or mid-regeneration — drop the empty row
          const liveArticles = resolveArticles(live);
          title = liveArticles[0]?.title ?? title;
          count = liveArticles.length;
        }
        return { shareId: p.shareId, author: p.author, title,
                 firstSharedAt: p.firstSharedAt, updatedAt, count, mine: p.owner === scope,
                 ...(p.replyTo ? { replyTo: p.replyTo } : {}) };
      } catch { return null; }
    });
    const posts = results.filter(Boolean);
    posts.sort((a, b) => (b.firstSharedAt || 0) - (a.firstSharedAt || 0));
    return json({ posts });
  }

  // Un-share (delete) a community post — owner only.
  if (request.method === 'POST' && action === 'community' && sub2 === 'unshare') {
    if (!scope) return json({ error: 'unauthorized' }, 403);
    // Same Apple-verified gate as share: editing the shared space needs accountability.
    if (!apple) return json({ error: 'needs_apple_signin' }, 403);
    const shareId = segments[2] || '';
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(shareId)) return json({ error: 'bad id' }, 400);
    const key = `community/${shareId}.json`;
    const obj = await env.FILES.get(key);
    if (!obj) return json({ ok: true });
    let owner = null;
    try { owner = JSON.parse(await obj.text()).owner; } catch {}
    if (owner !== scope) return json({ error: 'not owner' }, 403);
    await env.FILES.delete(key);
    return json({ ok: true });
  }

  // Report a community post — any signed-in user. Apple 1.2: a report HIDES the post
  // from the feed immediately (pending owner review), recording the reporter (deduped).
  // The owner reviews + removes/restores at /voicedrop/admin/reports.
  if (request.method === 'POST' && action === 'community' && sub2 === 'report') {
    const shareId = segments[2] || '';
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(shareId)) return json({ error: 'bad id' }, 400);
    if (!(await env.FILES.head(`community/${shareId}.json`))) return json({ error: 'not found' }, 404);
    let reason = ''; try { const b = await request.clone().json(); reason = (b && b.reason) || ''; } catch {}
    const rk = `community/reports/${shareId}.json`;
    let rec = { shareId, status: 'pending', firstAt: Date.now(), reporters: [] };
    const ex = await env.FILES.get(rk);
    if (ex) { try { rec = { ...rec, ...JSON.parse(await ex.text()), status: 'pending' }; } catch {} }
    if (!Array.isArray(rec.reporters)) rec.reporters = [];
    const by = scope || 'admin';
    if (!rec.reporters.some(r => r.by === by)) rec.reporters.push({ by, at: Date.now(), reason: String(reason).slice(0, 200) });
    await env.FILES.put(rk, JSON.stringify(rec), { httpMetadata: { contentType: 'application/json' } });
    return json({ ok: true });
  }

  // Admin: list pending reports with the reported post's current title/author/excerpt.
  if (request.method === 'GET' && action === 'community' && sub2 === 'reports') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    const listed = await env.FILES.list({ prefix: 'community/reports/', limit: 1000 });
    const out = [];
    for (const o of listed.objects) {
      const shareId = o.key.replace('community/reports/', '').replace(/\.json$/, '');
      let rec = null; try { rec = JSON.parse(await (await env.FILES.get(o.key)).text()); } catch {}
      if (!rec || rec.status !== 'pending') continue;
      let title = '', author = '', body = '', gone = false;
      const pObj = await env.FILES.get(`community/${shareId}.json`);
      if (!pObj) gone = true;
      else try {
        const p = JSON.parse(await pObj.text());
        author = p.author || '';
        const live = p.articleKey ? await env.FILES.get(p.articleKey) : null;
        if (live) { const arts = resolveArticles(JSON.parse(await live.text())); title = arts[0]?.title || ''; body = (arts[0]?.body || '').slice(0, 600); }
      } catch {}
      out.push({ shareId, author, title, body, gone, reports: rec.reporters?.length || 0, firstAt: rec.firstAt, reporters: rec.reporters || [] });
    }
    out.sort((a, b) => (b.firstAt || 0) - (a.firstAt || 0));
    return json({ reports: out });
  }

  // Admin: resolve a report — remove (delete the post for good) or restore (clear the
  // report so the post is visible again).
  if (request.method === 'POST' && action === 'community' && sub2 === 'resolve') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    const shareId = segments[2] || '';
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(shareId)) return json({ error: 'bad id' }, 400);
    let act = 'restore'; try { const b = await request.clone().json(); act = (b && b.action) || 'restore'; } catch {}
    if (act === 'remove') {
      await env.FILES.delete(`community/${shareId}.json`).catch(() => {});
      await env.FILES.delete(`community/reports/${shareId}.json`).catch(() => {});
      return json({ ok: true, removed: true });
    }
    await env.FILES.delete(`community/reports/${shareId}.json`).catch(() => {});
    return json({ ok: true, restored: true });
  }

  // Get one community post — reads the live article and merges with pointer metadata.
  if (request.method === 'GET' && action === 'community' && sub2 === 'get') {
    const shareId = segments[2] || '';
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(shareId)) return json({ error: 'bad id' }, 400);
    const obj = await env.FILES.get(`community/${shareId}.json`);
    if (!obj) return json({ error: 'not found' }, 404);
    let p; try { p = JSON.parse(await obj.text()); } catch { return json({ error: 'bad post' }, 500); }
    // Seed from stored data (schema-1 fallback); overwrite with live article for schema-2.
    let articles = (p.articles || []).map(a => ({ title: a.title, body: a.body }));
    let title = p.title || articles[0]?.title || '';
    let legacyPhotos = p.photos;   // legacy [[photo:N]] resolution; new posts have none
    if (p.articleKey) {
      const live = await liveDocForPointer(`community/${shareId}.json`, p);
      if (!live) return json({ error: 'not found' }, 404);   // orphan (reaped) or mid-regeneration
      articles = resolveArticles(live).map(a => ({ title: a.title, body: a.body }));
      title = articles[0]?.title ?? title;
      legacyPhotos = live.photos;
    }
    // `owner` (= the photo files' "users/<sub>/" prefix) + `photos` let the client build
    // the full R2 key for each [[photo:…]] marker and load it from the public photo URL.
    return json({ shareId: p.shareId, author: p.author, title, articles, owner: p.owner,
                  firstSharedAt: p.firstSharedAt,
                  ...(Array.isArray(legacyPhotos) && legacyPhotos.length ? { photos: legacyPhotos } : {}),
                  ...(p.replyTo ? { replyTo: p.replyTo } : {}) });
  }

  // Whether the user's own article is currently shared; also returns shareId for unshare.
  if (request.method === 'GET' && action === 'community' && sub2 === 'shared') {
    if (!scope || !env.SESSION_SECRET) return json({ shared: false });
    const articleKey = keyFor(decodeURIComponent(segments.slice(2).join('/')));
    if (!articleKey || !/^users\/[^/]+\/articles\/[^/]+\.json$/.test(articleKey)) return json({ shared: false });
    const shareId = (await hmacSign('community:' + articleKey, env.SESSION_SECRET)).slice(0, 12);
    const exists = await env.FILES.head(`community/${shareId}.json`);
    return json({ shared: !!exists, shareId: exists ? shareId : undefined });
  }


  // List posts that are responses to `shareId`, oldest-first.
  if (request.method === 'GET' && action === 'community' && sub2 === 'replies') {
    const shareId = segments[2] || '';
    if (!/^[0-9A-Za-z_-]{1,32}$/.test(shareId)) return json({ error: 'bad id' }, 400);
    const listed = await env.FILES.list({ prefix: 'community/', limit: 1000 });
    const objs = listed.objects.filter(x => /^community\/[^/]+\.json$/.test(x.key));
    const results = await mapLimit(objs, 32, async (o) => {
      const obj = await env.FILES.get(o.key);
      if (!obj) return null;
      try {
        const p = JSON.parse(await obj.text());
        if (p.replyTo !== shareId) return null;
        let title = p.title || '';
        if (p.articleKey) {
          const live = await liveDocForPointer(o.key, p);
          if (!live) return null;   // orphan reply (reaped) or mid-regeneration — drop it
          title = resolveArticles(live)[0]?.title ?? title;
        }
        return { shareId: p.shareId, author: p.author, title, firstSharedAt: p.firstSharedAt, replyTo: p.replyTo };
      } catch { return null; }
    });
    const posts = results.filter(Boolean);
    posts.sort((a, b) => (a.firstSharedAt || 0) - (b.firstSharedAt || 0));
    return json({ posts });
  }

  // "加急处理": let a signed-in app user kick the article miner now instead of
  // waiting for the hourly cron. The GitHub token lives only as a Pages secret.
  if (request.method === 'POST' && action === 'mine') {
    const r = await dispatchMine(request.headers.get('Authorization') || '');
    if (r.ok) return json({ ok: true });
    return json({ error: 'dispatch failed', detail: r.detail }, r.status === 0 ? 500 : 502);
  }

  // ── Article API ──────────────────────────────────────────────────────────
  // High-level CRUD for articles. Version control is built in — callers never
  // touch raw file keys. stem convention:
  //   user token  → stem = filename only (e.g. "VoiceDrop-xxx")
  //   admin token → stem = "<sub>/VoiceDrop-xxx" (includes user sub)
  //
  // Routes:
  //   GET    /articles              list articles
  //   GET    /articles/<stem>       read article
  //   PUT    /articles/<stem>       write article (versioned)
  //   DELETE /articles/<stem>       delete article + sidecars
  //   PUT    /articles/<stem>/srt   write SRT sidecar
  //   PUT    /articles/<stem>/empty mark as no-speech
  //   GET    /articles/<stem>/history       version history
  //   PATCH  /articles/<stem>/head          move head pointer (undo/redo, no new version)

  // ── Style API (文风) ─────────────────────────────────────────────────────
  // Versioned read/write for the user's 文风 — users/<sub>/CLAUDE.json (schema-3,
  // mirrors the article store). The name is NOT here; it stays in the legacy
  // CLAUDE.md for now (read by the author-extraction paths). On read, CLAUDE.json
  // wins; if absent, the legacy CLAUDE.md's 文风 section is parsed as a fallback.
  // Writers only ever write CLAUDE.json.
  //   GET   /style            read current 文风  → {style, head, createdAt, updatedAt}
  //   PUT   /style            write (versioned), body {style, source?} → {ok, head}
  //   GET   /style/history    {head, versions}
  //   PATCH /style/head       move head pointer (undo/redo), body {head} → {ok, head}
  // Admin token may target a user with /style/<sub>[/...].
  if (action === 'style') {
    let styleScope, subaction;
    if (!scope) {
      const adminSub = sub2;
      if (!adminSub) return json({ error: 'admin must supply <sub>' }, 400);
      styleScope = `users/${adminSub}/`;
      subaction = segments[2] || '';
    } else {
      styleScope = scope;
      subaction = sub2;
    }
    const styleKey = `${styleScope}CLAUDE.json`;
    const legacyKey = `${styleScope}CLAUDE.md`;

    if (request.method === 'GET' && !subaction) {
      // `name` is additive (from doc.profile) — old clients decode only `style` and ignore it.
      // Lazy-seed: a user with no CLAUDE.json (and no legacy 文风) gets the default 王建硕
      // style materialized as their own v1 here, so the settings screen shows an editable
      // baseline instead of an empty box. `default:true` flags an un-edited seed.
      // Seed only when the caller reads their OWN style (scope set). An admin
      // reading another user via /style/<sub> must not mutate that user's data
      // (a read shouldn't write) nor pre-freeze the default for users who never
      // touched their style — so the admin-targeted path is a plain read.
      const doc = scope
        ? await ensureStyleSeeded(env, styleKey, legacyKey)
        : await readStyleDoc(env, styleKey);
      if (doc) return json({ style: resolveStyle(doc), name: (doc.profile && doc.profile.name) || '', styles: (doc.profile && doc.profile.styles) || [], head: doc.head, createdAt: doc.createdAt || 0, updatedAt: doc.updatedAt || 0, default: isDefaultSeed(doc) });
      const legacy = await env.FILES.get(legacyKey);
      if (legacy) {
        const md = await legacy.text();
        const m = md.match(/#\s*我的名字\s*\n+([^\n#]+)/);
        return json({ style: parseStyleMarkdown(md), name: (m && m[1].trim()) || '', head: 0, legacy: true });
      }
      return json({ error: 'not found' }, 404);
    }

    if (request.method === 'GET' && subaction === 'history') {
      const doc = await readStyleDoc(env, styleKey);
      if (!doc) return json({ error: 'not found' }, 404);
      return json({ head: doc.head, versions: doc.versions || [] });
    }

    if (request.method === 'PUT' && !subaction) {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const style = typeof body.style === 'string' ? body.style : '';
      // Non-versioned profile fields, merged in one patch (extensible: name, styles, …).
      const profilePatch = {};
      if (typeof body.name === 'string') profilePatch.name = body.name.trim();
      if (Array.isArray(body.styles)) {
        profilePatch.styles = body.styles.filter((n) => Number.isInteger(n)).slice(0, 3);  // 多风格对比：选中的文风版本号
      }
      const hasProfile = Object.keys(profilePatch).length > 0;
      if (!style.trim() && !hasProfile) return json({ error: 'empty_content' }, 400);
      const source = body.source === 'agent' ? 'agent' : (scope ? 'app' : 'mine');
      // profile fields → no version; style → a new version. profile survives the style
      // write (writeStyleDoc carries it forward), so doing profile first is safe.
      let head;
      if (hasProfile) { head = (await mergeProfile(env, styleKey, profilePatch)).head; }
      if (style.trim()) { head = (await writeStyleDoc(env, styleKey, style, source)).head; }
      return json({ ok: true, head: head ?? 0 });
    }

    if (request.method === 'PATCH' && subaction === 'head') {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const newHead = typeof body.head === 'number' ? body.head : null;
      if (!newHead) return json({ error: 'head required' }, 400);
      const doc = await setStyleHead(env, styleKey, newHead);
      if (!doc) return json({ error: 'version not found' }, 404);
      return json({ ok: true, head: doc.head });
    }

    // ── 风格数据集（语料）collect / dataset ─────────────────────────────────
    // A separate raw-corpus feed alongside the versioned 文风 doc above — one
    // sample per submission under `<styleScope>style/<id>.json`. This is the
    // SAME directory `collectStyle()` (agent/src/miner.js) already writes to
    // for shared-file submissions, so `dataset` must tolerate its older shape
    // `{stem,sourceFile,type,needsExtraction,collectedAt,text}` (no id/chars/title).
    //   POST   /style/collect   body {type?,title?,text,source?} → {ok, id}
    //   GET    /style/dataset   → {items:[{id,type,title,chars,source,collectedAt}], count, totalChars}
    //                              newest-first, metadata only (no `text`)
    //   DELETE /style/dataset   → {ok, deleted}  (clears every sample in scope)
    if (subaction === 'collect' && request.method === 'POST') {
      let body; try { body = await request.json(); } catch { body = {}; }
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return json({ error: 'empty_text' }, 400);
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      // title/type must be sanitized to strings the same way `text` is above — a non-string
      // body.title (number/object/array from a malformed client) would otherwise throw on
      // `.slice` (no String.prototype.slice) and 500 the whole request.
      const sample = {
        id,
        type: (typeof body.type === 'string' && body.type) ? body.type : 'text',
        title: typeof body.title === 'string' ? body.title.slice(0, 200) : '',
        chars: [...text].length, source: body.source || '', text,
        collectedAt: new Date().toISOString(),
      };
      await env.FILES.put(`${styleScope}style/${id}.json`, JSON.stringify(sample), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true, id });
    }

    if (subaction === 'dataset') {
      if (request.method === 'GET') {
        const items = [];
        let cursor;
        do {
          const listed = await env.FILES.list({ prefix: `${styleScope}style/`, cursor });
          for (const o of listed.objects) {
            const obj = await env.FILES.get(o.key);
            if (!obj) continue;
            const s = await obj.json().catch(() => null);
            if (!s) continue;
            const id = s.id || o.key.split('/').pop().replace(/\.json$/, '');
            const chars = typeof s.chars === 'number' ? s.chars : [...(s.text || '')].length;
            items.push({ id, type: s.type || '', title: s.title || s.sourceFile || '', chars, source: s.source || '', collectedAt: s.collectedAt || '' });
          }
          cursor = listed.truncated ? listed.cursor : null;
        } while (cursor);
        items.sort((a, b) => (a.collectedAt < b.collectedAt ? 1 : -1));
        return json({ items, count: items.length, totalChars: items.reduce((n, i) => n + (i.chars || 0), 0) });
      }
      if (request.method === 'DELETE') {
        let cursor, deleted = 0;
        do {
          const listed = await env.FILES.list({ prefix: `${styleScope}style/`, cursor });
          for (const o of listed.objects) { await env.FILES.delete(o.key); deleted++; }
          cursor = listed.truncated ? listed.cursor : null;
        } while (cursor);
        return json({ ok: true, deleted });
      }
    }

    return json({ error: 'method not allowed' }, 405);
  }

  if (action === 'articles') {
    // Parse stem and optional sub-action from URL segments.
    // segments = ['articles', ...rest]
    // For user token: rest = [stem] or [stem, subaction]
    // For admin token: rest = [sub, stem] or [sub, stem, subaction]
    const rest = segments.slice(1);
    let stem, subaction;

    if (!scope) {
      // Admin: first segment is <sub>, second is stem (stem optional for list).
      const adminSub = rest[0] || '';
      stem = rest[1] || '';
      subaction = rest[2] || '';
      if (!adminSub) return json({ error: 'admin must supply <sub>[/<stem>]' }, 400);
      if (!stem && !(request.method === 'GET')) return json({ error: 'admin must supply <sub>/<stem>' }, 400);
      // Override scope for this request to the target user's prefix.
      var articleScope = `users/${adminSub}/`;
    } else {
      stem = rest[0] || '';
      subaction = rest[1] || '';
      var articleScope = scope;
    }

    function articleKey(s) {
      if (!s || s.includes('..') || s.includes('/')) return null;
      return `${articleScope}articles/${s}.json`;
    }

    // GET /articles — list
    if (request.method === 'GET' && !stem) {
      const prefix = `${articleScope}articles/`;
      let cursor, allObjects = [];
      do {
        const listed = await env.FILES.list({ prefix, limit: 1000, cursor });
        allObjects.push(...listed.objects);
        cursor = listed.truncated ? listed.cursor : null;
      } while (cursor);
      const articles = [];
      for (const o of allObjects) {
        if (!o.key.endsWith('.json')) continue;
        const s = o.key.slice(prefix.length, -'.json'.length);
        const obj = await env.FILES.get(o.key);
        if (!obj) continue;
        let doc; try { doc = JSON.parse(await obj.text()); } catch { continue; }
        const currentArticles = resolveArticles(doc);
        articles.push({
          stem: s,
          title: currentArticles[0]?.title || '(无题)',
          head: doc.head || 1,
          createdAt: doc.createdAt || 0,
          updatedAt: doc.updatedAt || 0,
          count: currentArticles.length,
        });
      }
      articles.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return json({ articles });
    }

    const key = articleKey(stem);
    if (stem && !key) return json({ error: 'bad stem' }, 400);

    // GET /articles/<stem> — read
    if (request.method === 'GET' && stem && !subaction) {
      const doc = await readArticleDoc(env, key);
      if (!doc) return json({ error: 'not found' }, 404);
      // Reconstruct top-level `articles` from the current head version for
      // backwards compatibility with all callers (iOS, miner, agent worker).
      const { versions: _vs, head: _h, ...pub } = doc;
      return json({ ...pub, articles: resolveArticles(doc) });
    }

    // GET /articles/<stem>/history — version history
    if (request.method === 'GET' && subaction === 'history') {
      const doc = await readArticleDoc(env, key);
      if (!doc) return json({ error: 'not found' }, 404);
      return json({ head: doc.head, versions: doc.versions || [] });
    }

    // PUT /articles/<stem> — write (versioned)
    if (request.method === 'PUT' && stem && !subaction) {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const source = !scope ? 'mine' : 'agent';
      const doc = await writeArticleDoc(env, key, body, source);
      return json({ ok: true, head: doc.head });
    }

    // PATCH /articles/<stem>/head — move head pointer only (undo/redo)
    if (request.method === 'PATCH' && subaction === 'head') {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const newHead = typeof body.head === 'number' ? body.head : null;
      if (!newHead) return json({ error: 'head required' }, 400);
      const doc = await setHead(env, key, newHead);
      if (!doc) return json({ error: 'version not found' }, 404);
      return json({ ok: true, head: doc.head });
    }

    // PUT /articles/<stem>/srt — write SRT sidecar
    if (request.method === 'PUT' && subaction === 'srt') {
      const srtKey = `${articleScope}articles/${stem}.srt`;
      const text = await request.text();
      await env.FILES.put(srtKey, text, { httpMetadata: { contentType: 'text/srt; charset=utf-8' } });
      return json({ ok: true });
    }

    // PUT /articles/<stem>/empty — mark no-speech
    if (request.method === 'PUT' && subaction === 'empty') {
      const emptyKey = `${articleScope}articles/${stem}.empty`;
      let body; try { body = await request.json(); } catch { body = {}; }
      await env.FILES.put(emptyKey, JSON.stringify({ status: 'empty', reason: body.reason || 'no-speech' }), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true });
    }

    // PUT /articles/<stem>/blocked — mark no-credit
    if (request.method === 'PUT' && subaction === 'blocked') {
      const blockedKey = `${articleScope}articles/${stem}.blocked`;
      let body; try { body = await request.json(); } catch { body = {}; }
      await env.FILES.put(blockedKey, JSON.stringify({ status: 'blocked', reason: body.reason || 'no-credit' }), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true });
    }

// DELETE /articles/<stem> — delete article + all sidecars
    if (request.method === 'DELETE' && stem && !subaction) {
      const prefix = `${articleScope}articles/${stem}`;
      await Promise.all([
        env.FILES.delete(`${prefix}.json`),
        env.FILES.delete(`${prefix}.srt`),
        env.FILES.delete(`${prefix}.empty`),
        env.FILES.delete(`${prefix}.blocked`),
      ]);
      return json({ ok: true });
    }

    return json({ error: 'bad request' }, 400);
  }

  return json({ error: 'bad request' }, 400);
}

// Kick the Cloudflare miner Worker. authHeader is the caller's Authorization
// header — any valid session token (user or admin) is accepted by /agent/mine/trigger.
async function dispatchMine(authHeader) {
  try {
    // Use the workers.dev URL to bypass same-zone Pages routing (which returns
    // 405 for POST on static paths before the Worker zone route can handle it).
    const resp = await fetch('https://voicedrop-agent.jianshuo.workers.dev/agent/mine/trigger', {
      method: 'POST',
      headers: { 'Authorization': authHeader },
    });
    if (resp.ok) return { ok: true, status: resp.status, detail: '' };
    return { ok: false, status: resp.status, detail: (await resp.text()).slice(0, 200) };
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
  return { sub: payload.sub, email: payload.email || null };
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

// verifySession/hmacSign/sha256hex/timingSafeEqual/b64url*/sanitizeSeg/
// anonScopeFromToken are imported from ../../lib/auth.js (single source of truth).

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
