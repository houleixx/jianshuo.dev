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
//   POST   /files/api/auth/wechat      body {code[,platform,appid,nickname,avatar]}
//                                       -> verify with WeChat Open Platform or Mini Program,
//                                       mint a long-lived WeChat session JWT.
//   GET    /files/api/list             -> JSON list (admin: all keys; user: own prefix)
//   PUT    /files/api/upload/<name>    -> upload (raw body)
//   GET    /files/api/download/<name>  -> download
//   DELETE /files/api/file/<name>      -> delete
//
// New env needed:
//   SESSION_SECRET   (Pages secret) — HMAC key for minting/verifying session JWTs
//   APPLE_BUNDLE_ID  (var)          — expected `aud`, the iOS app bundle id

import { TITLE_FALLBACK, readArticleDoc, writeArticleDoc, setHead, setQuestionStatus, resolveArticles, withTopLevelArticles, byNewestFirst, articleTime, indexEntryFor, removeIndexEntry, setIndexFlag } from "../../lib/article-store.js";
import { silentM4aBytes } from "../../lib/silent-m4a.js";
import { shareIdFor, communityKey, reportKey, isShareId, promptPostTitle } from "../../lib/community-store.js";
import { readStyleDoc, writeStyleDoc, setStyleHead, resolveStyle, parseStyleMarkdown, readProfileName, mergeProfile, ensureStyleSeeded, isDefaultSeed, readLegacyStyleMd } from "../../lib/style-store.js";
import { sanitizeSeg, sha256hex, timingSafeEqual, bytesToB64url, b64urlToBytes, b64urlToString, b64url, hmacSign, verifySession, anonScopeFromToken, bearerToken, hasVerifiedBinding } from "../../lib/auth.js";
import { checkArticlesShareable } from "../../lib/moderation.js";
import { coreLoadPromptShares, coreDeleteUserData, coreListArticles, coreReplaceArticles, coreUpsertRecording, coreDeleteRecording, coreListRecordings, coreReplaceRecordings, coreGetIdentity, corePutIdentity, coreUpsertProfile, coreGetProfile, corePutPushToken, corePutReport, coreDeleteReport, coreGetReport, corePendingReportIds, coreListReports } from "../../lib/core-db.js";

// Miner sidecars that live under articles/ and end in .json but are NOT article
// docs: <stem>.asr.json (resumable-ASR task) and <stem>.asrdone.json (ASR
// checkpoint). They must never be listed as articles nor run through
// readArticleDoc/migrateToV3.
const isAsrSidecar = (key) => key.endsWith('.asr.json') || key.endsWith('.asrdone.json');

const WECHAT_COMPONENT_KEY = 'config/wechat-component.json';
const WECHAT_AUTH_STATE_CONTEXT = 'wechat-auth-state:';
const WECHAT_AUTH_STATE_TTL_MS = 10 * 60 * 1000;

async function createWechatAuthState(scope, secret) {
  if (!secret || !/^users\/[^/]+\/$/.test(scope)) return '';
  const payload = b64url(JSON.stringify({ s: scope, e: Date.now() + WECHAT_AUTH_STATE_TTL_MS }));
  return payload + '.' + await hmacSign(WECHAT_AUTH_STATE_CONTEXT + payload, secret);
}

async function verifyWechatAuthState(state, secret) {
  if (!state || !secret) return null;
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = await hmacSign(WECHAT_AUTH_STATE_CONTEXT + parts[0], secret);
  if (!timingSafeEqual(parts[1], expected)) return null;
  let payload;
  try { payload = JSON.parse(b64urlToString(parts[0])); } catch { return null; }
  if (!payload || !/^users\/[^/]+\/$/.test(payload.s)
      || !Number.isFinite(payload.e) || payload.e <= Date.now()) return null;
  return { scope: payload.s, expiresAt: payload.e };
}

async function loadWechatComponent(env) {
  try {
    const obj = await env.FILES.get(WECHAT_COMPONENT_KEY);
    return obj ? JSON.parse(await obj.text()) : {};
  } catch { return {}; }
}

function wechatRelayBaseURL(env) {
  const configured = String(env.WECHAT_RELAY_URL || '').trim();
  if (!configured) return '';
  return configured
    .replace(/\/(?:publish|validate)\/?$/, '')
    .replace(/\/+$/, '');
}

async function callWechatRelay(env, operation, payload) {
  const base = wechatRelayBaseURL(env);
  if (!base || !env.WECHAT_RELAY_SECRET) throw new Error('relay_not_configured');
  const response = await fetch(base + '/' + operation, {
    method: 'POST',
    headers: {
      'X-Relay-Secret': env.WECHAT_RELAY_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('relay_http_' + response.status);
  const data = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('relay_invalid_response');
  }
  return data;
}

async function getWechatComponentAccessToken(env) {
  const component = await loadWechatComponent(env);
  if (component.component_access_token
      && Number(component.component_access_token_expires_at) > Date.now() + 60_000) {
    return { token: component.component_access_token, component };
  }
  if (!component.component_verify_ticket || !env.WECHAT_COMPONENT_APP_ID || !env.WECHAT_COMPONENT_APP_SECRET) {
    return { token: '', component };
  }
  let data;
  try {
    data = await callWechatRelay(env, 'component-token', {
      component_appid: env.WECHAT_COMPONENT_APP_ID,
      component_appsecret: env.WECHAT_COMPONENT_APP_SECRET,
      component_verify_ticket: component.component_verify_ticket,
    });
  } catch { return { token: '', component }; }
  if (!data || !data.component_access_token) return { token: '', component };
  const next = {
    ...component,
    component_access_token: data.component_access_token,
    component_access_token_expires_at: Date.now() + Math.max(0, Number(data.expires_in || 7200) - 60) * 1000,
  };
  await env.FILES.put(WECHAT_COMPONENT_KEY, JSON.stringify(next), {
    httpMetadata: { contentType: 'application/json' },
  });
  return { token: next.component_access_token, component: next };
}

async function refreshWechatAuthorizerAccessToken(env, wc) {
  const storedAccessToken = typeof wc.access_token === 'string' ? wc.access_token.trim() : '';
  if (!wc.authorizer_appid) {
    return { token: '', refreshed: false, error: 'wechat_authorization_incomplete' };
  }
  if (storedAccessToken && Number(wc.access_token_expires_at) > Date.now() + 60_000) {
    return { token: storedAccessToken, refreshed: false };
  }
  if (!wc.refresh_token || !env.WECHAT_COMPONENT_APP_ID) {
    return { token: '', refreshed: false, error: 'wechat_authorization_incomplete' };
  }
  const component = await getWechatComponentAccessToken(env);
  if (!component.token) {
    return { token: '', refreshed: false, error: 'wechat_component_token_unavailable' };
  }
  let data;
  try {
    data = await callWechatRelay(env, 'authorizer-token', {
      component_access_token: component.token,
      component_appid: env.WECHAT_COMPONENT_APP_ID,
      authorizer_appid: wc.authorizer_appid,
      authorizer_refresh_token: wc.refresh_token,
    });
  } catch {
    return { token: '', refreshed: false, error: 'wechat_authorizer_token_unavailable' };
  }
  if (!data || !data.authorizer_access_token) {
    return {
      token: '',
      refreshed: false,
      error: 'wechat_authorizer_token_refresh_failed',
      errcode: data && data.errcode,
      errmsg: data && data.errmsg,
    };
  }
  wc.access_token = data.authorizer_access_token;
  wc.access_token_expires_at = Date.now() + Math.max(0, Number(data.expires_in || 7200) - 60) * 1000;
  if (data.authorizer_refresh_token) wc.refresh_token = data.authorizer_refresh_token;
  return { token: wc.access_token, refreshed: true };
}

async function isWechatComponentCallbackSignatureValid(url, token, encrypted = '') {
  const signature = url.searchParams.get(encrypted ? 'msg_signature' : 'signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  if (!token || !signature || !timestamp || !nonce) return false;
  const data = new TextEncoder().encode([token, timestamp, nonce, ...(encrypted ? [encrypted] : [])].sort().join(''));
  const digest = await crypto.subtle.digest('SHA-1', data);
  const expected = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(expected, signature);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function decryptWechatComponentMessage(encrypted, encodingAesKey, componentAppId) {
  if (!encrypted || !encodingAesKey || !componentAppId) return '';
  try {
    // 微信 EncodingAESKey 是 43 位 base64（末尾的 '=' 在平台界面省略）。
    const keyBytes = base64ToBytes(encodingAesKey + '=');
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
    const cipher = base64ToBytes(encrypted);
    if (!cipher.length || cipher.length % 16 !== 0) return '';
    // Web Crypto always validates/removes AES's 16-byte padding, while WeChat
    // uses PKCS#7 with a 32-byte block size. Append one valid AES padding block
    // so Web Crypto removes only that block and gives us WeChat's raw padded
    // plaintext; the 32-byte padding is validated and removed below.
    const tailIv = cipher.slice(cipher.length - 16);
    const paddingBlock = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: tailIv }, key, new Uint8Array()));
    const extendedCipher = new Uint8Array(cipher.length + paddingBlock.length);
    extendedCipher.set(cipher);
    extendedCipher.set(paddingBlock, cipher.length);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: keyBytes.slice(0, 16) }, key, extendedCipher));
    let end = plain.length;
    const pad = plain[end - 1];
    if (pad >= 1 && pad <= 32 && plain.slice(end - pad).every((b) => b === pad)) end -= pad;
    if (end < 20) return '';
    const size = ((plain[16] << 24) >>> 0) + (plain[17] << 16) + (plain[18] << 8) + plain[19];
    if (size < 0 || 20 + size > end) return '';
    const receivedAppId = new TextDecoder().decode(plain.slice(20 + size, end));
    if (receivedAppId !== componentAppId) return '';
    return new TextDecoder().decode(plain.slice(20, 20 + size));
  } catch { return ''; }
}

function xmlText(xml, name) {
  const match = new RegExp('<' + name + '><!\\[CDATA\\[(.*?)\\]\\]><\\/' + name + '>|<' + name + '>(.*?)<\\/' + name + '>', 's').exec(xml);
  return match ? (match[1] ?? match[2] ?? '').trim() : '';
}

// 文章摘要索引全量对账（GET /articles 与 GET /recordings 的后台自愈共用）。
// R2 listing 是权威（blob 本体在 R2）：扫 articles/ 前缀全部对象，与 D1 行比
// etag 指纹只重读新/变的 doc，删掉已不存在的条目；同一次 listing 顺手重建
// empty/blocked/tags 三种 sidecar 标记（零额外 R2 成本），脏了整体回写 D1。
// 返回按时间倒序的文章列表。
async function reconcileArticlesIndex(env, articleScope) {
  const prefix = `${articleScope}articles/`;
  const fp = (o) => o.etag || `${o.size}:${o.uploaded?.toISOString?.() || ''}`;

  let cursor, allObjects = [];
  do {
    const listed = await env.FILES.list({ prefix, limit: 1000, cursor });
    allObjects.push(...listed.objects);
    cursor = listed.truncated ? listed.cursor : null;
  } while (cursor);
  const jsonObjects = allObjects.filter((o) => o.key.endsWith('.json') && !isAsrSidecar(o.key));
  // sidecar 标记文件 → stem → {empty?/blocked?/tags?}
  const sidecars = {};
  for (const o of allObjects) {
    const m = /^([^/]+)\.(empty|blocked|tags)$/.exec(o.key.slice(prefix.length));
    if (m) (sidecars[m[1]] ||= {})[m[2]] = true;
  }

  // D1 行是指纹缓存（fp = 写入时的 etag）；D1 不可用 → 空缓存，全量重读 blob，
  // 列表照出，只是这次回写不了 D1。
  const index = {};
  for (const r of (await coreListArticles(env, articleScope)) || []) {
    let entry = null;
    if (r.entry) { try { entry = JSON.parse(r.entry); } catch {} }
    index[r.stem] = { fp: r.fp, entry,
      ...(r.empty ? { empty: true } : {}), ...(r.blocked ? { blocked: true } : {}), ...(r.tags ? { tags: true } : {}) };
  }

  const articles = [];
  const stale = [];
  const liveStems = new Set(Object.keys(sidecars));   // 只有标记没有 doc 的条目也算活
  for (const o of jsonObjects) {
    const s = o.key.slice(prefix.length, -'.json'.length);
    liveStems.add(s);
    const cached = index[s];
    if (cached && cached.fp === fp(o)) {
      if (cached.entry) articles.push(cached.entry);
    } else {
      stale.push(o);
    }
  }
  let dirty = stale.length > 0;
  for (const s of Object.keys(index)) {
    if (!liveStems.has(s)) { delete index[s]; dirty = true; }
  }

  // Read only new/changed docs, in parallel batches (an unbounded fan-out
  // at ~100 articles used to saturate the subrequest budget).
  const BATCH = 20;
  for (let i = 0; i < stale.length; i += BATCH) {
    await Promise.all(stale.slice(i, i + BATCH).map(async (o) => {
      const s = o.key.slice(prefix.length, -'.json'.length);
      const obj = await env.FILES.get(o.key);
      if (!obj) { delete index[s]; return; }
      let doc;
      try { doc = JSON.parse(await obj.text()); }
      catch {
        // Unparseable object: cache the miss so it isn't re-fetched every list.
        index[s] = { ...(index[s] || {}), fp: fp(o), entry: null };
        return;
      }
      const entry = indexEntryFor(s, doc);
      index[s] = { ...(index[s] || {}), fp: fp(o), entry };
      articles.push(entry);
    }));
  }

  // sidecar 标记以 listing 为准：该打的打上，该掉的掉（标记文件已删）。
  for (const s of liveStems) {
    const f = sidecars[s] || {};
    const it = index[s] || (index[s] = { fp: null, entry: null });
    for (const flag of ['empty', 'blocked', 'tags']) {
      if (f[flag] && !it[flag]) { it[flag] = true; dirty = true; }
      if (!f[flag] && it[flag]) { delete it[flag]; dirty = true; }
    }
  }

  if (dirty) {
    try {
      await coreReplaceArticles(env, articleScope, Object.entries(index).map(([s, it]) => ({
        stem: s,
        entryJson: it.entry ? JSON.stringify(it.entry) : null,
        fp: it.fp || null,
        createdMs: it.entry ? articleTime(it.entry.createdAt) : 0,
        empty: !!it.empty, blocked: !!it.blocked, tags: !!it.tags,
      })));
    } catch { /* 回写失败不打断本次列表，下次对账再收敛 */ }
  }

  articles.sort(byNewestFirst);
  return articles;
}

// ── 录音索引（D1 recordings 表）────────────────────────────────────────────────
// GET /recordings 的直出数据源：items = { "<leaf>.m4a": { uploaded } }。上传/删除
// 路由同步增删；权威是根目录 delimiter listing（.m4a blob 在 R2），由下面的对账
// 重建（并发上传的 lost update、绕过 API 的直写在下一次打开后收敛）。

async function reconcileRecordingsIndex(env, scope) {
  const items = {};
  let cursor;
  do {
    const listed = await env.FILES.list({ prefix: scope, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of listed.objects) {
      const leaf = o.key.slice(scope.length);
      if (leaf.startsWith('VoiceDrop-') && leaf.endsWith('.m4a')) {
        items[leaf] = { uploaded: o.uploaded?.toISOString?.() || String(o.uploaded || '') };
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  try {
    const prev = await coreListRecordings(env, scope);
    const same = prev && Object.keys(prev).length === Object.keys(items).length
      && Object.keys(items).every((k) => prev[k] && prev[k].uploaded === items[k].uploaded);
    if (!same) await coreReplaceRecordings(env, scope, items);
  } catch { /* 回写失败不打断本次列表，下次对账再收敛 */ }
  return items;
}

// 上传/删除路由的同步维护（行级 UPSERT / DELETE；并发漂移靠对账兜底）。
async function updateRecordingsIndex(env, scope, leaf, meta /* null = 删 */) {
  try {
    if (meta) await coreUpsertRecording(env, scope, leaf, meta.uploaded);
    else await coreDeleteRecording(env, scope, leaf);
  } catch { /* 加速层 */ }
}

export async function onRequest(context) {
  // 报警打点包裹：任何 4xx/5xx 响应 fire-and-forget 通知 voicedrop-agent 的
  // ops 计数器（分钟桶），worker 的 */5 cron 聚合并按阈值 APNs 报警——
  // 照片 400 风暴那种「服务端默默拒了几小时」的事故从此有人喊。401 除外
  //（未登录探测太常见，纯噪声）。打点失败不影响响应。
  const resp = await handleRequest(context);
  try {
    if (resp && resp.status >= 400 && resp.status !== 401) {
      const route = (Array.isArray(context.params.path) ? context.params.path[0] : context.params.path) || '?';
      // photo 404 是业务预期（客户端轮询 AI 图直到生成 + 偶发死图），量大且无行动价值，
      // 进报警只会淹掉真故障（2026-07-22 的 4xx 报警风暴一半是它）。photo 400/5xx 照报。
      if (route === 'photo' && resp.status === 404) return resp;
      context.waitUntil(fetch('https://jianshuo.dev/agent/ops/tick', {
        method: 'POST',
        body: JSON.stringify({ route: `files/${route}`, status: resp.status }),
      }).catch(() => {}));
    }
  } catch (_) {}
  return resp;
}

async function handleRequest(context) {
  const { request, env, params } = context;
  // 响应发出后继续跑的后台活（社区索引对账用）；测试里的裸 context 没有它 → null。
  const waitUntil = typeof context.waitUntil === 'function' ? context.waitUntil.bind(context) : null;
  const segments = Array.isArray(params.path) ? params.path : [params.path || ''];
  const action = segments[0] || '';
  const sub2 = segments[1] || '';
  const name = decodeURIComponent(segments.slice(1).join('/'));
  const url = new URL(request.url);

  // 微信第三方平台每十分钟推送 component_verify_ticket。回调令牌属于
  // Pages secret，票据与运行时 component_access_token 只放 R2 config。
  if (action === 'wechat' && sub2 === 'component-callback') {
    const raw = request.method === 'POST' ? await request.text() : '';
    const encrypted = request.method === 'GET'
      ? (url.searchParams.get('encrypt_type') === 'aes' ? (url.searchParams.get('echostr') || '') : '')
      : xmlText(raw, 'Encrypt');
    if (!await isWechatComponentCallbackSignatureValid(url, env.WECHAT_COMPONENT_CALLBACK_TOKEN, encrypted)) {
      return new Response('forbidden', { status: 403 });
    }
    if (request.method === 'GET') {
      const challenge = encrypted
        ? await decryptWechatComponentMessage(encrypted, env.WECHAT_COMPONENT_AES_KEY, env.WECHAT_COMPONENT_APP_ID)
        : url.searchParams.get('echostr') || '';
      return challenge ? new Response(challenge, { headers: { 'content-type': 'text/plain; charset=utf-8' } }) : new Response('forbidden', { status: 403 });
    }
    if (request.method === 'POST') {
      const body = encrypted
        ? await decryptWechatComponentMessage(encrypted, env.WECHAT_COMPONENT_AES_KEY, env.WECHAT_COMPONENT_APP_ID)
        : raw;
      if (!body) return new Response('forbidden', { status: 403 });
      if (xmlText(body, 'InfoType') === 'component_verify_ticket') {
        const ticket = xmlText(body, 'ComponentVerifyTicket');
        if (ticket) {
          const current = await loadWechatComponent(env);
          await env.FILES.put(WECHAT_COMPONENT_KEY, JSON.stringify({ ...current, component_verify_ticket: ticket, component_verify_ticket_at: Date.now() }), {
            httpMetadata: { contentType: 'application/json' },
          });
        }
      }
      return new Response('success', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return new Response('method not allowed', { status: 405 });
  }

  // This page is opened in Android's WebView without a VoiceDrop bearer token.
  // A short-lived HMAC state carries only the server-resolved user scope and
  // expiry. The pre-auth code is created here so it never needs R2 persistence.
  if (request.method === 'GET' && action === 'wechat' && sub2 === 'scan') {
    const state = url.searchParams.get('state') || '';
    const authState = await verifyWechatAuthState(state, env.SESSION_SECRET);
    if (!authState) {
      return new Response('授权链接已失效，请返回 VoiceDrop 后重新连接。', {
        status: 410,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        },
      });
    }
    if (!env.WECHAT_COMPONENT_APP_ID) {
      return new Response('微信公众号授权服务尚未配置。', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const componentAccess = await getWechatComponentAccessToken(env);
    if (!componentAccess.token) {
      return new Response('服务端暂时无法打开微信授权，请稍后重试。', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    let preAuth;
    try {
      preAuth = await callWechatRelay(env, 'pre-auth-code', {
        component_access_token: componentAccess.token,
        component_appid: env.WECHAT_COMPONENT_APP_ID,
      });
    } catch { preAuth = null; }
    if (!preAuth || !preAuth.pre_auth_code) {
      return new Response('微信授权页面暂时无法打开，请稍后重试。', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const base = (env.WECHAT_AUTH_BASE_URL || (url.origin + '/files/api')).replace(/\/$/, '');
    const callback = base + '/wechat/auth-callback?state=' + encodeURIComponent(state);
    const authUrl = 'https://mp.weixin.qq.com/cgi-bin/componentloginpage?component_appid='
      + encodeURIComponent(env.WECHAT_COMPONENT_APP_ID) + '&pre_auth_code=' + encodeURIComponent(preAuth.pre_auth_code)
      + '&redirect_uri=' + encodeURIComponent(callback) + '&auth_type=1';
    const html = '<!doctype html><meta charset="utf-8"><title>正在打开微信授权</title>'
      + '<p>正在打开微信授权二维码页…</p><script>window.location.replace('
      + JSON.stringify(authUrl) + ');</script>';
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'origin',
      },
    });
  }

  if (request.method === 'GET' && action === 'wechat' && sub2 === 'auth-callback') {
    const state = url.searchParams.get('state') || '';
    const authCode = url.searchParams.get('auth_code') || '';
    const authState = await verifyWechatAuthState(state, env.SESSION_SECRET);
    if (!authCode || !authState) {
      return new Response('授权链接已失效，请返回 VoiceDrop 后重新连接。', { status: 410, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const component = await getWechatComponentAccessToken(env);
    if (!component.token || !env.WECHAT_COMPONENT_APP_ID) {
      return new Response('服务端暂时无法完成授权，请稍后重试。', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    let authInfo;
    try {
      authInfo = await callWechatRelay(env, 'query-auth', {
        component_access_token: component.token,
        component_appid: env.WECHAT_COMPONENT_APP_ID,
        authorization_code: authCode,
      });
    } catch { authInfo = null; }
    const authorization = authInfo && authInfo.authorization_info;
    if (!authorization || !authorization.authorizer_appid || !authorization.authorizer_access_token || !authorization.authorizer_refresh_token) {
      return new Response('微信授权信息获取失败，请返回 VoiceDrop 后重试。', { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    let accountName = '';
    try {
      const detail = await callWechatRelay(env, 'authorizer-info', {
        component_access_token: component.token,
        component_appid: env.WECHAT_COMPONENT_APP_ID,
        authorizer_appid: authorization.authorizer_appid,
      });
      accountName = detail && detail.authorizer_info && detail.authorizer_info.nick_name || '';
    } catch {}
    const wechatKey = authState.scope + 'WECHAT.json';
    let current = {};
    try {
      const obj = await env.FILES.get(wechatKey);
      if (obj) current = JSON.parse(await obj.text());
    } catch {}
    // Existing cover/media ids belong to the account that created them. Keep an
    // owner hint for legacy article entries that predate per-article ownership.
    const mediaOwner = current.media_authorizer_appid
      || current.authorizer_appid
      || current.appid
      || '';
    const next = {
      ...current,
      provider: 'wechat_third_party',
      authorizer_appid: authorization.authorizer_appid,
      account_name: accountName,
      access_token: authorization.authorizer_access_token,
      refresh_token: authorization.authorizer_refresh_token,
      access_token_expires_at: Date.now() + Math.max(0, Number(authorization.expires_in || 7200) - 60) * 1000,
    };
    if (mediaOwner) next.media_authorizer_appid = mediaOwner;
    if (mediaOwner && mediaOwner !== authorization.authorizer_appid) delete next.coverMediaIds;
    await env.FILES.put(wechatKey, JSON.stringify(next), { httpMetadata: { contentType: 'application/json' } });
    return new Response(null, {
      status: 302,
      headers: {
        location: '/files/api/wechat/auth-success',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    });
  }

  if (request.method === 'GET' && action === 'wechat' && sub2 === 'auth-success') {
    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>授权成功</title><body style="margin:0;background:#fbf7f1;font-family:sans-serif;display:grid;place-items:center;min-height:100vh;color:#2f2925"><main style="text-align:center"><div style="margin:auto;width:64px;height:64px;border-radius:50%;background:#5e8a6a;color:#fff;line-height:64px"><svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="授权成功"><path d="M18.5 32.5 27.5 41.5 46 23" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div><h1>微信公众号授权成功</h1><p>请返回 VoiceDrop，系统会自动更新连接状态。</p></main></body>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }

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
    const appleExtId = sanitizeSeg(sub);
    let scope = null;
    // 身份→scope 解析：D1 identities（first-write-wins）。
    const d1scope = await coreGetIdentity(env, 'apple', appleExtId);
    if (typeof d1scope === 'string') scope = d1scope;
    const now = Date.now();
    if (!scope) {
      // D1 不可用（null）时不能盲建新绑定——否则老用户会被岔进一个空号。宁可让
      // 这次登录失败重试。
      if (d1scope === null) return json({ error: 'storage unavailable, retry' }, 503);
      const callerAnon = bearerToken(request);
      scope = (await anonScopeFromToken(callerAnon)) || `users/${sanitizeSeg(sub)}/`;
      await corePutIdentity(env, 'apple', appleExtId, scope, now);
    }
    // Persist the Apple-provided identity. fullName is handed over ONLY on the first
    // authorization (and again only if the user revokes + re-grants), so it is
    // first-write-wins (COALESCE keeps the D1-stored name); email rides in the
    // verified token and is refreshed each sign-in.
    {
      const email = tokenEmail || bodyEmail;
      await coreUpsertProfile(env, scope, {
        apple_sub: sub, email: email || undefined,
        name: bodyName || undefined,
        linked_at: now, last_seen_at: now,
      });
    }
    const session = await mintSession(scope, true, env.SESSION_SECRET);
    return json({ session, scope });
  }

  // ---- Unauthenticated: exchange a WeChat login code for a session ----
  if (request.method === 'POST' && action === 'auth' && sub2 === 'wechat') {
    if (!env.SESSION_SECRET) return json({ error: 'server misconfigured: no SESSION_SECRET' }, 500);
    let code = '', nickname = null, avatar = null, platform = '', appid = '';
    try {
      const body = await request.json();
      code = (body && body.code) || '';
      nickname = (body && body.nickname) || null;
      avatar = (body && body.avatar) || null;
      platform = (body && body.platform) || '';
      appid = (body && body.appid) || '';
    } catch {}
    if (!code) return json({ error: 'missing code' }, 400);
    const isMiniProgram = String(platform).toLowerCase() === 'mini_program';
    if (isMiniProgram) {
      if (!env.WECHAT_MINI_APP_ID || !env.WECHAT_MINI_APP_SECRET) {
        return json({ error: 'server misconfigured: no wechat mini program credentials' }, 500);
      }
      if (appid && appid !== env.WECHAT_MINI_APP_ID) return json({ error: 'wechat appid mismatch' }, 400);
    } else if (!env.WECHAT_OPEN_APP_ID || !env.WECHAT_OPEN_APP_SECRET) {
      return json({ error: 'server misconfigured: no wechat app credentials' }, 500);
    }
    let wx;
    try {
      wx = isMiniProgram ? await exchangeWechatMiniCode(code, env) : await exchangeWechatCode(code, env);
    } catch (e) {
      return json({ error: 'invalid wechat code', detail: String(e.message || e) }, 401);
    }
    const wechatId = wx.unionid ? `unionid-${wx.unionid}` : `openid-${wx.openid}`;
    const wechatExtId = sanitizeSeg(wechatId);
    let scope = null;
    // 身份→scope 解析：D1 identities（first-write-wins）。
    const d1scope = await coreGetIdentity(env, 'wechat', wechatExtId);
    if (typeof d1scope === 'string') scope = d1scope;
    const now = Date.now();
    if (!scope) {
      if (d1scope === null) return json({ error: 'storage unavailable, retry' }, 503);
      const callerAnon = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      scope = (await anonScopeFromToken(callerAnon)) || `users/wechat-${sanitizeSeg(wechatId)}/`;
      await corePutIdentity(env, 'wechat', wechatExtId, scope, now);
    }
    {
      const av = avatar ? String(avatar).slice(0, 500) : null;
      await coreUpsertProfile(env, scope, {
        wechat_openid: wx.openid, wechat_unionid: wx.unionid || undefined,
        name: nickname ? String(nickname).slice(0, 80) : undefined, avatar: av || undefined,
        linked_at: now, wechat_linked_at: now, last_seen_at: now,
      });
    }
    const session = await mintWechatSession(scope, env.SESSION_SECRET);
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
    // A missing photo must NOT be cached: edited/AI images are written a bit after
    // the article points at them, and clients poll this endpoint until the object
    // appears. A cacheable 404 (the old default) froze the "not yet generated"
    // state for hours, so the image never loaded even once it existed.
    if (!obj) return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
        'Content-Length': String(obj.size),
        // Photo keys are write-once (hashed uid + timestamp + random tail; AI regen
        // mints a NEW key), so a found photo is immutable — cache it for a year
        // everywhere (EO edge follows origin, CF edge, browsers, iOS). Only the 404
        // above must stay no-store (clients poll until the object appears).
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // ---- Public (no auth): resolve a share/community id for universal links ----
  // GET link/<id> → {type:"article"|"community", owner:"users/<sub>/", stem,
  //                  title, articles:[{title,body}], photos?}
  // The app receives https://voicedrop.cn/<id> as a universal link and asks what
  // the id points at: its OWN article (owner == whoami scope) opens the native
  // detail view; a community post opens the native post view; anyone else's plain
  // share renders natively from the content returned here (read-only reader).
  // Exposes nothing new — the same mapping AND content are already served as
  // public HTML by functions/[token].js, and a reported community post 404s here
  // exactly like there (Apple 1.2).
  if (request.method === 'GET' && action === 'link' && sub2) {
    const id = sub2;
    if (!/^[A-Za-z0-9_-]{6,16}$/.test(id)) return json({ error: 'bad id' }, 400);
    let key = null, type = 'article';
    const map = await env.FILES.get(`shares/${id}`);
    if (map) {
      key = (await map.text()).trim();
    } else {
      const cm = await env.FILES.get(communityKey(id));
      if (cm) {
        // 举报=隐藏（Apple 1.2）：D1 有 pending 行即 404。
        if (await coreGetReport(env, id)) return json({ error: 'not found' }, 404);
        type = 'community';
        try { key = JSON.parse(await cm.text()).articleKey || null; } catch { /* fallthrough */ }
      }
    }
    const m = key && key.match(/^(users\/[^/]+\/)articles\/([^/]+)\.json$/);
    if (!m) return json({ error: 'not found' }, 404);
    const obj = await env.FILES.get(key);
    if (!obj) return json({ error: 'not found' }, 404);
    let doc; try { doc = JSON.parse(await obj.text()); } catch { return json({ error: 'not found' }, 404); }
    const articles = resolveArticles(doc)
      .filter((a) => a && (a.body || '').trim())
      .map((a) => ({ title: a.title, body: a.body }));
    // `photos` = legacy [[photo:N]] resolution only (new articles use key markers).
    return json({
      type, owner: m[1], stem: m[2],
      title: articles[0]?.title || '', articles,
      ...(Array.isArray(doc.photos) && doc.photos.length ? { photos: doc.photos } : {}),
    });
  }

  // ---- Authenticate every other route ----
  const token = bearerToken(request) || url.searchParams.get('token') || '';

  let scope = null; // null = unauthorized, '' = admin/full bucket, 'users/<id>/' = user
  let readonly = false;
  let apple = false; // true only for an Apple-verified session JWT (community write gate)
  let wechat = false; // true only for a WeChat-verified Android session JWT
  if (env.FILES_TOKEN && token === env.FILES_TOKEN) {
    scope = '';
  } else if (token) {
    const sess = env.SESSION_SECRET ? await verifySession(token, env.SESSION_SECRET) : null;
    if (sess) {
      // Signed-in (Sign in with Apple) user — scope is carried in the JWT.
      scope = sess.scope;
      apple = sess.apple;
      wechat = sess.wechat;
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

  // Third-party Official Account connection state. The authoritative per-user
  // record stays in the existing R2 configuration object so legacy clients can
  // continue using the same WECHAT.json path.
  if (request.method === 'GET' && action === 'wechat' && sub2 === 'bind-status') {
    const key = scope + 'WECHAT.json';
    let wc = {};
    try {
      const obj = await env.FILES.get(key);
      if (obj) wc = JSON.parse(await obj.text());
    } catch {}
    const connected = wc.provider === 'wechat_third_party'
      && !!wc.authorizer_appid
      && !!wc.refresh_token;
    return json(connected ? {
      connected: true,
      authorizer_appid: wc.authorizer_appid,
      account_name: wc.account_name || '',
      enabled: wc.enabled !== false,
    } : { connected: false });
  }

  if (request.method === 'POST' && action === 'wechat' && sub2 === 'unbind') {
    const key = scope + 'WECHAT.json';
    let wc = {};
    try {
      const obj = await env.FILES.get(key);
      if (obj) wc = JSON.parse(await obj.text());
    } catch {}
    for (const field of [
      'provider', 'authorizer_appid', 'account_name',
      'access_token', 'refresh_token', 'access_token_expires_at',
      'media_authorizer_appid',
    ]) delete wc[field];
    await env.FILES.put(key, JSON.stringify(wc), {
      httpMetadata: { contentType: 'application/json' },
    });
    return json({ connected: false });
  }

  if (request.method === 'POST' && action === 'wechat' && sub2 === 'authorization') {
    if (!env.WECHAT_COMPONENT_APP_ID) {
      return json({ error: 'wechat_component_not_configured' }, 500);
    }
    const state = await createWechatAuthState(scope, env.SESSION_SECRET);
    if (!state) return json({ error: 'wechat_authorization_user_required' }, 400);
    const base = (env.WECHAT_AUTH_BASE_URL || (url.origin + '/files/api')).replace(/\/$/, '');
    return json({ scan_url: base + '/wechat/scan?state=' + encodeURIComponent(state) });
  }

  // ── Delete account (Apple 5.1.1(v)) ──────────────────────────────────────
  // POST account/delete — permanently erases the calling user, whether they are
  // an anonymous identity or Apple-signed-in (both are "accounts" to App Review):
  //   1. their community posts (owner == scope) + those posts' report markers,
  //   2. public share links (shares/<id>) resolving into their scope,
  //   3. every object under users/<sub>/ (recordings, articles, photos, settings),
  //   4. sign-in bindings (links/apple-<sub>.json, links/wechat-*.json).
  // Irreversible. The client then discards its tokens/local data, so the next
  // launch starts a brand-new empty identity. Admin and read-only tokens can't
  // call this (read-only is already 403'd above).
  if (request.method === 'POST' && action === 'account' && sub2 === 'delete') {
    if (!scope) return json({ error: 'admin token cannot delete an account' }, 400);

    // Grab identity bindings (D1 user_profiles) before the scope is wiped —
    // the legacy links/*.json cleanup below still needs the external ids.
    let appleSub = null, wechatUnionid = null, wechatOpenid = null;
    const prof = await coreGetProfile(env, scope);
    if (prof) {
      appleSub = prof.apple_sub || null;
      wechatUnionid = prof.wechat_unionid || null;
      wechatOpenid = prof.wechat_openid || null;
    }

    let communityPosts = 0;
    {
      const listed = await env.FILES.list({ prefix: 'community/', limit: 1000 });
      const posts = listed.objects.filter((o) => /^community\/[^/]+\.json$/.test(o.key));
      await mapLimit(posts, 16, async (o) => {
        try {
          const obj = await env.FILES.get(o.key);
          if (!obj) return;
          const p = JSON.parse(await obj.text());
          if (p.owner !== scope) return;
          await env.FILES.delete(o.key);
          await env.FILES.delete(reportKey(p.shareId)).catch(() => {});
          await coreDeleteReport(env, p.shareId);   // P3：D1 举报行同生同死
          communityPosts++;
        } catch {}
      });
      await indexDeleteOwner(scope);
    }

    let shareLinks = 0;
    {
      const listed = await env.FILES.list({ prefix: 'shares/', limit: 1000 });
      await mapLimit(listed.objects, 16, async (o) => {
        try {
          const obj = await env.FILES.get(o.key);
          if (!obj) return;
          if (!(await obj.text()).trim().startsWith(scope)) return;
          await env.FILES.delete(o.key);
          shareLinks++;
        } catch {}
      });
    }

    // 提示词分享码：shares/<码> 的值对提示词条目是 JSON（'{'开头），上面那段纯文本
    // startsWith(scope) 匹配永远打不中，销号后这些码会永久公开孤立、无人能关。
    // 读 D1 prompt_shares 逐个删 shares/<码>，同生同死。borrowed 条目必须跳过
    // （溯源转发 spec 2026-07-22）：那些 code 指向【原作者的】shares/<码>，销号删它
    // 等于毁掉别人的活跃分享。读不到静默跳过：销号主路径不能被它打断。
    let promptCodes = 0;
    {
      const codes = new Set();
      try {
        const d1 = await coreLoadPromptShares(env, scope);
        if (d1) for (const entry of Object.values(d1.byItem)) if (entry && entry.code && !entry.borrowed) codes.add(String(entry.code));
      } catch {}
      await mapLimit([...codes], 16, async (code) => {
        await env.FILES.delete(`shares/${code}`).catch(() => {});
        promptCodes++;
      });
    }

    // D1 侧行清理（prompt_shares / invites / refhits / share_stats）——best-effort，
    // 绝不打断销号主路径。
    await coreDeleteUserData(env, scope);

    // The whole user prefix, re-listing until empty (R2 lists max 1000 per call).
    // MUST delete as an array — R2 bulk delete takes up to 1000 keys as ONE
    // operation. Per-key deletes blew the Pages Function subrequest budget on a
    // large account (913 objects → invocation killed mid-loop, 246 keys left,
    // found 2026-07-06). Round cap so a stuck delete can never spin forever.
    let objects = 0;
    for (let round = 0; round < 100; round++) {
      const listed = await env.FILES.list({ prefix: scope, limit: 1000 });
      if (!listed.objects.length) break;
      await env.FILES.delete(listed.objects.map((o) => o.key));
      objects += listed.objects.length;
      if (!listed.truncated && listed.objects.length < 1000) break;
    }

    if (appleSub) {
      await env.FILES.delete(`links/apple-${sanitizeSeg(appleSub)}.json`).catch(() => {});
    }
    if (wechatUnionid) {
      await env.FILES.delete(`links/wechat-unionid-${sanitizeSeg(wechatUnionid)}.json`).catch(() => {});
    }
    if (wechatOpenid) {
      await env.FILES.delete(`links/wechat-openid-${sanitizeSeg(wechatOpenid)}.json`).catch(() => {});
    }

    return json({ ok: true, deleted: { objects, communityPosts, shareLinks, promptCodes } });
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
  // Day-folder listing must page with the cursor: R2's delimited list truncates
  // by keys *scanned*, not prefixes returned — one un-paged call stops rolling
  // up new day folders once the older days hold enough objects (this is how the
  // llm admin page froze at 2026-07-13 while logs kept writing).
  const listDateFolders = async (prefix) => {
    const dates = [];
    let cursor;
    do {
      const listed = await env.FILES.list({ prefix, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : {}) });
      dates.push(...(listed.delimitedPrefixes || [])
        .map((p) => p.slice(prefix.length).replace(/\/$/, ''))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return dates.sort().reverse();
  };
  if (request.method === 'GET' && action === 'llmlog') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    if (sub2 === 'dates') {
      return json({ dates: await listDateFolders('llmlogs/') });
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

  // ── Admin-only: 用户反馈 (voicedrop/admin/feedback.html) ─────────────────────
  // 反馈由 agent worker POST /agent/feedback 落盘 feedback/<date>/<ts>-<rand>.json，
  // 这里只读：dates 列日期文件夹，list 把当天所有条目连内容一起返回（单条很小）。
  if (request.method === 'GET' && action === 'feedback') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    if (sub2 === 'dates') {
      return json({ dates: await listDateFolders('feedback/') });
    }
    if (sub2 === 'list') {
      const date = url.searchParams.get('date') || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'date=YYYY-MM-DD required' }, 400);
      const keys = [];
      let cursor;
      do {
        const listed = await env.FILES.list({ prefix: `feedback/${date}/`, limit: 500, ...(cursor ? { cursor } : {}) });
        keys.push(...listed.objects.map((o) => o.key));
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      const items = (await Promise.all(keys.map(async (key) => {
        try {
          const obj = await env.FILES.get(key);
          return { key, ...JSON.parse(await obj.text()) };
        } catch { return null; }
      }))).filter(Boolean).sort((a, b) => (a.ts < b.ts ? 1 : -1));
      return json({ items });
    }
    return json({ error: 'unknown feedback action' }, 404);
  }

  // ── Admin-only: mine run log (voicedrop/admin/mine.html) ─────────────────────
  // Per-audio events written by miner.js under minelogs/<date>/<ts>-<stem>.json.
  if (request.method === 'GET' && action === 'minelog') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    if (sub2 === 'dates') {
      return json({ dates: await listDateFolders('minelogs/') });
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

  // GET /recordings — 主界面「我的录音」的轻量列表（2026-07-13）。
  // 老路是 GET /list 全量翻用户所有 R2 对象（照片/文章/字幕全在内，~1500 个对象
  // 串行翻两页 + 170KB 回传 ≈ 2.5s），App 再自己筛出 .m4a 和 sidecar 存在性。
  // 现在两张 D1 表两条 SELECT 直出：recordings（上传/删除时行级维护）+ articles
  // 摘要（四个状态位：成文/无语音/算力不足/预置标签）。权威仍是 R2 blob listing：
  // 响应后 waitUntil 里两个对账各跑一次收敛漂移；D1 空/不可用则同步对账重建
  // （覆盖没有 D1 行的老账号——一次 delimiter listing ~1.3s，仅此一回）。
  if (request.method === 'GET' && action === 'recordings') {
    if (!scope) return json({ error: 'user token required' }, 400);
    let [items, d1Arts] = await Promise.all([coreListRecordings(env, scope), coreListArticles(env, scope)]);
    if (items && Object.keys(items).length) {
      if (waitUntil) waitUntil(reconcileRecordingsIndex(env, scope).catch(() => {}));
    } else {
      items = await reconcileRecordingsIndex(env, scope);   // 空/不可用：同步重建
    }
    if ((!d1Arts || !d1Arts.length) && Object.keys(items).length) {
      // 有录音但 D1 没有任何文章行：多半是没回填的老账号，同步对账一次把状态位补齐
      //（否则整页显示「待处理」）。真没文章的账号 articles/ 前缀为空，这一步很便宜。
      await reconcileArticlesIndex(env, scope).catch(() => {});
      d1Arts = await coreListArticles(env, scope);
    } else if (waitUntil) {
      waitUntil(reconcileArticlesIndex(env, scope).catch(() => {}));
    }
    const flags = {};
    for (const a of d1Arts || []) flags[a.stem] = a;
    const recordings = Object.entries(items).map(([leaf, meta]) => {
      const it = flags[leaf.slice(0, -4)] || {};
      return {
        name: leaf,
        uploaded: meta.uploaded || '',
        hasArticles: !!it.entry,
        isEmpty: !!it.empty,
        blocked: !!it.blocked,
        hasTags: !!it.tags,
      };
    });
    return json({ recordings });
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
    // 入口护栏：上传路径的每个字符必须是 ASCII（允许 '/' 分段——照片传
    // photos/<ts>/<n>.jpg、标签传 articles/<stem>.tags 都是多段路径；2026-07-08
    // 曾误禁 '/'，把所有照片/标签上传 400 拒掉，教训）。真正要挡的是非 ASCII：
    // 历史上安卓版本发中文名（VoiceDrop-…-周三-上午.m4a），文章/标记被写到 URL
    // 编码后的 R2 key，而 miner 用解码 key 查存在性 → 永远对不上 → 每轮重挖。
    // '..' 由 keyFor 拒绝（路径穿越）。iOS 命名本就 ASCII-only，不受影响。
    if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
      const badChars = [...new Set(name.match(/[^A-Za-z0-9._/-]/g) || [])].join('');
      return json({
        error: 'invalid_upload_name',
        reason: '上传路径只允许 ASCII 字符 [A-Za-z0-9._/-]。' +
          (badChars ? `当前含非法字符：${badChars}。` : '') +
          '非 ASCII 文件名会让服务端存 R2 的 key 与挖矿检查用的 key 不一致，导致录音无法被处理。',
        rule: '^[A-Za-z0-9._/-]+$',
        name,
        hint: '请用纯 ASCII 命名（如中文星期/时段换成 Wed/Afternoon）后重新 PUT /files/api/upload/<path>',
      }, 400);
    }
    const key = keyFor(name);
    if (!key) return json({ error: 'bad name' }, 400);
    // WECHAT.json is shared by legacy credential clients and the third-party
    // authorization flow. Legacy builds upload a whole JSON document, so keep
    // server-owned authorization fields when such a client saves its settings.
    if (name === 'WECHAT.json') {
      let incoming;
      try { incoming = await request.json(); } catch { return json({ error: 'invalid wechat config' }, 400); }
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return json({ error: 'invalid wechat config' }, 400);
      }
      let current = {};
      try {
        const obj = await env.FILES.get(key);
        if (obj) current = JSON.parse(await obj.text());
      } catch {}
      const thirdPartyFields = [
        'provider', 'authorizer_appid', 'account_name',
        'access_token', 'refresh_token', 'access_token_expires_at',
        'media_authorizer_appid',
      ];
      const merged = { ...current, ...incoming };
      if (current.provider === 'wechat_third_party') {
        for (const field of thirdPartyFields) merged[field] = current[field];
      }
      await env.FILES.put(key, JSON.stringify(merged), {
        httpMetadata: { contentType: 'application/json' },
      });
      return json({ ok: true, name });
    }
    const putRes = await env.FILES.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
    });
    // 新录音同步进录音索引（GET /recordings 直出它）。key 形态对用户/admin 通用。
    const mRec = /^(users\/[^/]+\/)(VoiceDrop-[^/]+\.m4a)$/.exec(key);
    if (mRec) {
      await updateRecordingsIndex(env, mRec[1], mRec[2],
        { uploaded: putRes?.uploaded?.toISOString?.() || new Date().toISOString() });
    }
    // A new recording → kick the miner. Fire-and-forget so the upload returns
    // immediately; the mine.yml `concurrency: mine` group coalesces bursts into
    // at most one running + one queued run.
    const leaf = name.split('/').pop() || name;
    if (leaf.startsWith('VoiceDrop-') && leaf.endsWith('.m4a')) {
      const userAuth = request.headers.get('Authorization') || '';
      const kick = dispatchMine(userAuth);
      if (waitUntil) waitUntil(kick); else kick.catch(() => {});
    }
    // 照片落盘 → 带 photoTs poke 该用户的 Miner DO：iOS 已不再保证「照片先于音频」，
    // 晚到照片（甚至文章已成文后才到）由 DO 的 backfillSessionPhotos 补 [[photo:key]]
    // 标记兜底。不做 doc-exists 预检——预检自带竞态，全量 poke + DO 串行无时序假设。
    const mPhoto = /^(users\/[^/]+\/)photos\/([0-9-]+)\/[^/]+\.jpe?g$/i.exec(key);
    if (mPhoto) {
      // scope 一并带上：用户 token 下 trigger 忽略它（按 token 解析）；admin 直传
      // 照片（人工验证/重放）靠它定向到目标用户分片而不是 sweep。
      const kick = dispatchMine(request.headers.get('Authorization') || '', mPhoto[2], mPhoto[1]);
      if (waitUntil) waitUntil(kick); else kick.catch(() => {});
    }
    // 挖矿前预置的标签 sidecar（articles/<stem>.tags）→ 索引打 tags 标记，
    // recordings 轻量接口靠它告诉 App「这条待处理录音带标签，去拉内容」。
    const mTag = /^(.*\/)articles\/([^/]+)\.tags$/.exec(key);
    if (mTag) await setIndexFlag(env, mTag[1], mTag[2], 'tags');
    // 存储迁移 P3：push token 由 App 走本上传路由写 users/<sub>/push-token.json，
    // 这里顺手双写 D1 push_tokens（sendPush 读它）。scope 已鉴权，key 形态固定。
    const mPush = /^(users\/[^/]+\/)push-token\.json$/.exec(key);
    if (mPush) {
      try {
        const reg = JSON.parse(await (await env.FILES.get(key)).text());
        if (reg && reg.token) await corePutPushToken(env, mPush[1], reg.token, reg.env, reg.updatedAt || Date.now());
      } catch {}
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
    if (request.method === 'GET' && /\/articles\/[^/]+\.json$/.test(key) && !isAsrSidecar(key)) {
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
    // 摘要索引联动：直删 sidecar 标记文件 → 摘掉对应标记；直删文章 doc →
    // 摘掉整个条目；直删录音 .m4a → 从录音索引摘掉。（对账兜底，但立刻摘掉
    // 能让 recordings/articles 快路径即时正确。）
    const mFlag = /^(.*\/)articles\/([^/]+)\.(empty|blocked|tags)$/.exec(key);
    const mRecDel = /^(users\/[^/]+\/)(VoiceDrop-[^/]+\.m4a)$/.exec(key);
    if (mFlag) await setIndexFlag(env, mFlag[1], mFlag[2], mFlag[3], false);
    else if (/^.*\/articles\/[^/]+\.json$/.test(key) && !isAsrSidecar(key)) await removeIndexEntry(env, key);
    else if (mRecDel) await updateRecordingsIndex(env, mRecDel[1], mRecDel[2], null);
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
    // 分享链接用 voicedrop.cn（.cn 域名，微信内打开不弹「非官方网页」提示）根路径
    // 短链；老的 jianshuo.dev/voicedrop/<id> 继续有效（functions/[token].js 转发）。
    return json({ url: `https://voicedrop.cn/${id}` });
  }

  // Pre-save WeChat credential check. The app calls this before persisting
  // WECHAT.json: the relay fetches a real access_token from the whitelisted VPS
  // IP, so a wrong AppID/AppSecret or a missing IP-whitelist entry fails HERE
  // (relay returns {ok:false,errcode,errmsg}, e.g. 40164 = IP not whitelisted)
  // instead of surfacing at first publish. Auth'd like every other route; the
  // creds are only forwarded to the relay, never stored by this endpoint.
  if (request.method === 'POST' && action === 'wechat-validate') {
    if (!env.WECHAT_RELAY_URL || !env.WECHAT_RELAY_SECRET) {
      return json({ error: 'relay_not_configured' }, 500);
    }
    let creds = null;
    try { creds = await request.json(); } catch {}
    if (!creds || !creds.appid || !creds.secret) return json({ error: 'missing appid/secret' }, 400);
    try {
      const rr = await fetch(env.WECHAT_RELAY_URL.replace(/\/publish$/, '') + '/validate', {
        method: 'POST',
        headers: { 'X-Relay-Secret': env.WECHAT_RELAY_SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid: creds.appid, secret: creds.secret }),
      });
      const relay = await rr.json().catch(() => null);
      if (!rr.ok || !relay) return json({ error: 'relay_error', detail: relay }, 502);
      return json(relay);
    } catch (e) {
      return json({ error: 'relay_unreachable', detail: String((e && e.message) || e) }, 502);
    }
  }

  // On-demand WeChat draft push for ONE mined article. The app calls this when
  // the user taps 发布微信公众号草稿. The Function refreshes third-party credentials
  // when needed, then synchronously calls the IP-whitelisted Tokyo relay. The relay
  // creates a draft or updates the existing media id and returns the real result.
  if (request.method === 'POST' && action === 'wechat' && name) {
    const key = keyFor(name);
    if (!key || !/^users\/[^/]+\/articles\/[^/]+\.json$/.test(key)) {
      return json({ error: 'not publishable' }, 400);
    }
    const prefix = key.slice(0, key.indexOf('/articles/') + 1);   // users/<sub>/
    // Legacy direct credentials and third-party authorization share WECHAT.json.
    let wc = null;
    const wcObj = await env.FILES.get(prefix + 'WECHAT.json');
    if (wcObj) { try { wc = JSON.parse(await wcObj.text()); } catch {} }
    if (!wc) return json({ error: 'wechat_not_configured' }, 409);
    // A stored authorizer access_token always wins over legacy appid/secret,
    // even for records created before the provider marker was introduced.
    const hasAuthorizerAccessToken = typeof wc.access_token === 'string' && !!wc.access_token.trim();
    const thirdParty = hasAuthorizerAccessToken || wc.provider === 'wechat_third_party';
    let authorizerAccessToken = '';
    if (thirdParty) {
      const access = await refreshWechatAuthorizerAccessToken(env, wc);
      authorizerAccessToken = access.token;
      if (access.refreshed) {
        // Persist immediately: a relay timeout must not discard a newly rotated
        // access/refresh token and make the next attempt retry stale credentials.
        await env.FILES.put(prefix + 'WECHAT.json', JSON.stringify(wc), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
      if (!authorizerAccessToken) {
        const transient = access.error === 'wechat_component_token_unavailable'
          || access.error === 'wechat_authorizer_token_unavailable';
        return json({
          error: access.error || 'wechat_authorization_expired',
          ...(access.errcode != null ? { errcode: access.errcode } : {}),
          ...(access.errmsg ? { errmsg: access.errmsg } : {}),
        }, transient ? 503 : 409);
      }
    } else if (!wc.appid || !wc.secret) {
      return json({ error: 'wechat_not_configured' }, 409);
    }

    // Load the article doc (schema-3; current content = versions[head]).
    const doc = await readArticleDoc(env, key);
    if (!doc) return json({ error: 'not found' }, 404);
    const currentArticles = resolveArticles(doc);
    const publishArticles = thirdParty ? currentArticles.map((article) => {
      if (!article || !article.wechatMediaId) return article;
      const mediaOwner = article.wechatAuthorizerAppid || wc.media_authorizer_appid || '';
      if (mediaOwner === wc.authorizer_appid) return article;
      const clean = { ...article };
      delete clean.wechatMediaId;
      delete clean.wechatAuthorizerAppid;
      return clean;
    }) : currentArticles;
    // Relay expects a flat article object with top-level `articles`.
    const relayDoc = { ...doc, articles: publishArticles };
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
        body: JSON.stringify(thirdParty
          ? { access_token: authorizerAccessToken, authorizer_appid: wc.authorizer_appid, owner: prefix, cover_media_ids: wc.coverMediaIds || {}, article: relayDoc }
          : { appid: wc.appid, secret: wc.secret, owner: prefix, cover_media_ids: wc.coverMediaIds || {}, article: relayDoc }),
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
    const returnedArticles = (relay.article.articles ?? currentArticles).map((article) =>
      thirdParty && article && article.wechatMediaId
        ? { ...article, wechatAuthorizerAppid: wc.authorizer_appid }
        : article);
    await writeArticleDoc(env, key, { ...doc, articles: returnedArticles }, 'wechat');
    if (thirdParty || (relay.cover_media_ids && JSON.stringify(relay.cover_media_ids) !== JSON.stringify(wc.coverMediaIds || {}))) {
      // A token refresh is just as important to persist as a new cover id.
      // This merge write preserves legacy fields for clients that still use them.
      if (relay.cover_media_ids) wc.coverMediaIds = relay.cover_media_ids;
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
    if (!(await env.FILES.head(audioKey))) {
      await env.FILES.delete(pointerKey);
      await indexDelete(p.shareId);   // 孤儿指针连展示索引一起清
    }
    return null;
  }

  // 提示词帖（kind:"prompt"）：内容实时读 shares/<码> 写穿副本。副本没了 = 码已关
  // = 帖该死没死（agent 撤帖那步 best-effort 失败过）→ 自愈：清帖清索引，返回 null。
  async function livePromptLeaf(pointerKey, p) {
    // 对齐 liveDocForPointer 的纪律：get() 抛异常 = R2 瞬时读故障，不是「码已死」的
    // 证据——上抛让外层路由自然 500，下次再试；只有明确读到 null（真 404）或副本
    // JSON 损坏（写入方恒写合法 JSON，损坏=人工改坏）才自愈删帖。
    const o = await env.FILES.get(`shares/${p.promptCode}`);
    if (o) {
      let doc = null;
      try { doc = JSON.parse(await o.text()); } catch {}
      if (doc && doc.type === "prompt" && typeof doc.instruction === "string") return doc;
    }
    await env.FILES.delete(pointerKey);
    await indexDelete(p.shareId);
    return null;
  }

  // Share (or re-share) one of the user's own articles. Writes a schema-2 pointer
  // with no content copy. shareId is HMAC-derived from the article key so re-sharing
  // updates the same post in place; firstSharedAt is preserved.
  if (request.method === 'POST' && action === 'community' && sub2 === 'share') {
    if (!scope) return json({ error: 'admin cannot share' }, 403);
    if (!env.SESSION_SECRET) return json({ error: 'server misconfigured' }, 500);
    // Community write gate: posting to the shared space requires accountability —
    // a verified session, OR an anon token whose scope has ever bound Apple/WeChat
    // (ACCOUNT.json, see hasVerifiedBinding; this admits MCP-paired tokens). A
    // never-bound anon token gets 403 needs_apple_signin, which the app catches
    // -> presents the sign-in sheet -> binds -> retries the share.
    if (!apple && !wechat && !(await hasVerifiedBinding(env, scope))) {
      return json({ error: signinRequiredError(request) }, 403);
    }
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
    // Author = readProfileName 内部封装存储细节与无名兜底，只给 scope。
    const author = await readProfileName(env, scope);
    const shareId = await shareIdFor(articleKey, env.SESSION_SECRET);
    const postKey = communityKey(shareId);
    let replyTo = null;
    try { const body = await request.clone().json(); replyTo = (body && body.replyTo) || null; } catch {}
    let firstSharedAt = Date.now();
    let existingReplyTo = null;
    const existing = await env.FILES.get(postKey);
    if (existing) {
      try { const ep = JSON.parse(await existing.text()); firstSharedAt = ep.firstSharedAt || firstSharedAt; existingReplyTo = ep.replyTo || null; } catch {}
    }
    if (!replyTo) replyTo = existingReplyTo;
    const post = { schema: 2, shareId, owner: scope, articleKey, author, firstSharedAt,
                   ...(replyTo ? { replyTo } : {}) };
    await env.FILES.put(postKey, JSON.stringify(post), { httpMetadata: { contentType: 'application/json' } });
    await indexUpsert(post, articles, doc.photos);
    return json({ ok: true, shareId });
  }

  // 双排瀑布流卡片素材：从第一篇文章正文提取封面图与文字预览（design handoff
  // 2026-07-13）。列表 CommunityPost 本来只有 metadata，客户端为每卡拉全文是 N 次
  // 请求——所以在 list 侧一次补齐。marker 两代格式同 resolvePhotoKey：新 = token
  // 即相对 key，旧 = photos 数组 1-based 序号。coverPhotoKey 返回完整 R2 key
  // （owner 前缀已拼好），客户端直接走公开 /photo/<key> 端点。
  function cardExtras(articles, photos, owner) {
    const body = articles[0]?.body || '';
    const m = body.match(/\[\[photo:([^\]]+)\]\]/);
    let coverPhotoKey;
    if (m) {
      const rel = /^\d+$/.test(m[1]) ? (photos || [])[Number(m[1]) - 1] : m[1];
      // 封面 key 必须过与 /photo 路由同一把白名单尺（photos/ 前缀 + 图片扩展名）。
      // 口述内容被误当 [[photo:]] 标记时（如 [[photo:最新截图]]），拼出来的畸形 key
      // 进了 D1 封面索引 → 每个刷社区的用户拉一次 400 → 4xx 报警风暴（2026-07-22 实锤，
      // 对账自愈还会把它反复写回）。形状不合法就当没封面，卡片走纯文字。
      if (rel && /^photos\/.+\.(jpe?g|png)$/i.test(rel)) coverPhotoKey = (owner || '') + rel;
    }
    const preview = body
      .replace(/<!--[\s\S]*?-->/g, '')            // origin/meta comments
      .replace(/\[\[photo:[^\]]+\]\]/g, '')       // photo markers
      .replace(/^#{1,6}\s+/gm, '')                // markdown headings
      .replace(/[*_`~]/g, '')                     // inline markdown
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return { hasPhoto: !!coverPhotoKey,
             ...(coverPhotoKey ? { coverPhotoKey } : {}),
             ...(preview ? { preview } : {}) };
  }

  // ── D1 社区展示索引（reco 同库，binding RECO_DB，表 community_posts）─────────
  // R2 是真源；这张表只是 /reco/feed 用的展示索引。写失败一律吞掉（绝不打断主
  // 路径），坏了/漂了用 POST community/reindex 全量重建。hidden 与 report 标记
  // 同步；详情打开（community/get）时顺手 upsert 一次，文章编辑后的过期数据靠
  // 这个自愈。
  async function indexUpsert(p, articles, photos, { hidden = null, kind = null } = {}) {
    if (!env.RECO_DB) return;
    try {
      const k = kind || p.kind || 'article';
      // 提示词帖的"正文"是提示词文本——里面的 [[photo:{{KEY}}]] 之类是给 AI 的
      // 占位标记，不是真图。绝不能拿去当封面（曾把 {{KEY}} 拼成假题图，
      // 2026-07-16 真机 bug）；预览沿用 cardExtras 的清洗（顺带剥掉标记）。
      const ex0 = cardExtras(articles, photos, p.owner);
      const ex = k === 'prompt' ? { hasPhoto: false, ...(ex0.preview ? { preview: ex0.preview } : {}) } : ex0;
      const title = articles[0]?.title ?? p.title ?? '';
      // hidden 未显式给定时查 D1 举报态（不可用按未举报处理——展示索引由对账收敛）。
      const hid = hidden !== null ? (hidden ? 1 : 0) : ((await coreGetReport(env, p.shareId)) ? 1 : 0);
      await env.RECO_DB.prepare(
        `INSERT INTO community_posts (share_id, owner, article_key, author, title, preview,
           cover_photo_key, has_photo, article_count, first_shared_at, updated_at, reply_to, hidden, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(share_id) DO UPDATE SET
           owner=excluded.owner, article_key=excluded.article_key, author=excluded.author,
           title=excluded.title, preview=excluded.preview, cover_photo_key=excluded.cover_photo_key,
           has_photo=excluded.has_photo, article_count=excluded.article_count,
           first_shared_at=excluded.first_shared_at, updated_at=excluded.updated_at,
           reply_to=excluded.reply_to, hidden=excluded.hidden, kind=excluded.kind`,
      ).bind(p.shareId, p.owner || '', p.articleKey || null, p.author || '', title,
             ex.preview || null, ex.coverPhotoKey || null, ex.hasPhoto ? 1 : 0,
             articles.length || 1, p.firstSharedAt || null,
             p.updatedAt || p.firstSharedAt || null, p.replyTo || null, hid, k).run();
    } catch (e) { console.log('[community-index] upsert failed', String(e?.message || e)); }
  }
  async function indexDelete(shareId) {
    if (!env.RECO_DB) return;
    try { await env.RECO_DB.prepare('DELETE FROM community_posts WHERE share_id=?').bind(shareId).run(); }
    catch (e) { console.log('[community-index] delete failed', String(e?.message || e)); }
  }
  async function indexSetHidden(shareId, hidden) {
    if (!env.RECO_DB) return;
    try { await env.RECO_DB.prepare('UPDATE community_posts SET hidden=? WHERE share_id=?').bind(hidden ? 1 : 0, shareId).run(); }
    catch (e) { console.log('[community-index] hide failed', String(e?.message || e)); }
  }
  async function indexDeleteOwner(owner) {
    if (!env.RECO_DB) return;
    try { await env.RECO_DB.prepare('DELETE FROM community_posts WHERE owner=?').bind(owner).run(); }
    catch (e) { console.log('[community-index] owner-delete failed', String(e?.message || e)); }
  }

  // 全量对账：R2 真源 → D1 展示索引。admin reindex 端点与 list 快路径的
  // waitUntil 后台自愈共用这一个函数——读全部指针 + 活文章，逐行 upsert
  // （hidden 随 report 标记），最后把 R2 已不存在的行从索引删掉。
  async function reconcileIndex() {
    const listed = await env.FILES.list({ prefix: 'community/', limit: 1000 });
    // 隐藏集 = D1 pending 举报（一条 SELECT）；不可用按空集处理，下次对账收敛。
    const hidden = (await corePendingReportIds(env)) || new Set();
    const postObjects = listed.objects.filter(o => /^community\/[^/]+\.json$/.test(o.key));
    const seen = new Set();
    let indexed = 0;
    await mapLimit(postObjects, 16, async (o) => {
      try {
        const obj = await env.FILES.get(o.key);
        if (!obj) return;
        const p = JSON.parse(await obj.text());
        if (p.kind === 'prompt') {
          const o2 = await env.FILES.get(`shares/${p.promptCode}`);
          let leaf = null;
          try { const d = o2 && JSON.parse(await o2.text()); if (d?.type === 'prompt') leaf = d; } catch {}
          if (!leaf) { await env.FILES.delete(o.key); await indexDelete(p.shareId); return; }
          await indexUpsert(p, [{ title: promptPostTitle(leaf) || '', body: leaf.instruction }], undefined,
                            { hidden: hidden.has(p.shareId), kind: 'prompt' });
          seen.add(p.shareId); indexed++;
          return;
        }
        let articles = p.articles || [], photos = p.photos;
        if (p.articleKey) {
          const live = await liveDocForPointer(o.key, p);
          if (!live) return;   // 孤儿已顺手清掉；重挖中的先不进索引
          articles = resolveArticles(live);
          photos = live.photos;
        }
        await indexUpsert(p, articles, photos, { hidden: hidden.has(p.shareId) });
        seen.add(p.shareId);
        indexed++;
      } catch {}
    });
    let removed = 0;
    try {
      const { results } = await env.RECO_DB.prepare('SELECT share_id FROM community_posts').all();
      for (const r of results || []) {
        if (!seen.has(r.share_id)) { await indexDelete(r.share_id); removed++; }
      }
    } catch {}
    return { indexed, removed };
  }

  // List community posts (metadata only), newest-first by first-share time.
  // 快路径（2026-07-13）：一条 SQL 读 D1 展示索引出全列表——旧的 R2 逐帖拉
  // 全文（指针 + 整篇文章 JSON）在 ~100 帖时要 7 秒，这里降到毫秒级，老版本
  // app（不走 /reco/feed 的）也吃到。响应发出后 waitUntil 里全量对账
  // （reconcileIndex），文章编辑/删除/重挖造成的索引漂移在每次打开后收敛。
  // D1 缺失/出错/空表 → 原样走 R2 真源慢路径兜底，行为与旧版一致。
  if (request.method === 'GET' && action === 'community' && sub2 === 'list') {
    if (env.RECO_DB) {
      try {
        const { results } = await env.RECO_DB.prepare(
          // 提示词退出社区 feed（2026-07-22，同 reco feedRows）：只出文章帖。
          `SELECT share_id, owner, author, title, preview, cover_photo_key, has_photo,
                  article_count, first_shared_at, updated_at, reply_to, kind
           FROM community_posts WHERE hidden=0 AND kind!='prompt'
           ORDER BY first_shared_at DESC LIMIT 200`).all();
        if (results && results.length) {
          if (waitUntil) waitUntil(reconcileIndex().catch(() => {}));
          return json({ posts: results.map(r => ({
            shareId: r.share_id, author: r.author, title: r.title,
            firstSharedAt: r.first_shared_at, updatedAt: r.updated_at || r.first_shared_at,
            count: r.article_count, mine: r.owner === scope,
            hasPhoto: !!r.has_photo, kind: r.kind || 'article',
            ...(r.cover_photo_key ? { coverPhotoKey: r.cover_photo_key } : {}),
            ...(r.preview ? { preview: r.preview } : {}),
            ...(r.reply_to ? { replyTo: r.reply_to } : {}),
          })) });
        }
      } catch (e) { console.log('[community-index] list read failed', String(e?.message || e)); }
      // 索引空/坏 → 本次走 R2 慢路径，后台重建一次
      if (waitUntil) waitUntil(reconcileIndex().catch(() => {}));
    }
    const listed = await env.FILES.list({ prefix: 'community/', limit: 1000 });
    // Apple 1.2: a reported post is HIDDEN immediately (pending owner review).
    // 隐藏集 = D1 pending 举报；不可用按空集处理（瞬时，宁可短暂多显示不 500）。
    const hidden = (await corePendingReportIds(env)) || new Set();
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
        if (p.kind === 'prompt') return null;   // 提示词退出社区 feed（2026-07-22，同 D1 快路径过滤）
        // Seed from stored data (schema-1 fallback); overwrite with live article for schema-2.
        let title = p.title || '', count = (p.articles || []).length, updatedAt = p.updatedAt || p.firstSharedAt;
        let extras = cardExtras(p.articles || [], p.photos, p.owner);
        if (p.articleKey) {
          const live = await liveDocForPointer(o.key, p);
          if (!live) return null;   // orphan (reaped) or mid-regeneration — drop the empty row
          const liveArticles = resolveArticles(live);
          title = liveArticles[0]?.title ?? title;
          count = liveArticles.length;
          extras = cardExtras(liveArticles, live.photos, p.owner);
        }
        return { shareId: p.shareId, author: p.author, title,
                 firstSharedAt: p.firstSharedAt, updatedAt, count, mine: p.owner === scope,
                 kind: p.kind || 'article',
                 ...extras,
                 ...(p.replyTo ? { replyTo: p.replyTo } : {}) };
      } catch { return null; }
    });
    const posts = results.filter(Boolean);
    posts.sort((a, b) => (b.firstSharedAt || 0) - (a.firstSharedAt || 0));
    return json({ posts });
  }

  // Admin: 全量重建 D1 展示索引（幂等）。用途：首次回填、索引漂移兜底。
  // 逻辑与 list 相同（读全部指针 + 活文章），额外把 R2 已不存在的行从索引删掉。
  if (request.method === 'POST' && action === 'community' && sub2 === 'reindex') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    if (!env.RECO_DB) return json({ error: 'no RECO_DB binding' }, 503);
    const { indexed, removed } = await reconcileIndex();
    return json({ ok: true, indexed, removed });
  }

  // Un-share (delete) a community post — owner only.
  if (request.method === 'POST' && action === 'community' && sub2 === 'unshare') {
    if (!scope) return json({ error: 'unauthorized' }, 403);
    // Same accountability gate as share (verified session or ever-bound anon scope).
    if (!apple && !wechat && !(await hasVerifiedBinding(env, scope))) {
      return json({ error: signinRequiredError(request) }, 403);
    }
    const shareId = segments[2] || '';
    if (!isShareId(shareId)) return json({ error: 'bad id' }, 400);
    const key = communityKey(shareId);
    const obj = await env.FILES.get(key);
    if (!obj) return json({ ok: true });
    let parsed = null; try { parsed = JSON.parse(await obj.text()); } catch {}
    const owner = parsed?.owner ?? null;
    if (owner !== scope) return json({ error: 'not owner' }, 403);
    if (parsed?.kind === 'prompt' && parsed.promptCode) {
      // 同生同死的反方向：社区撤帖 = 关分享（码立即失效）。owner 索引保留，
      // 提示词编辑页开关状态（按 shares/<码> head 判断）自动归位。
      await env.FILES.delete(`shares/${parsed.promptCode}`);
    }
    await env.FILES.delete(key);
    await indexDelete(shareId);
    return json({ ok: true });
  }

  // Report a community post — any signed-in user. Apple 1.2: a report HIDES the post
  // from the feed immediately (pending owner review), recording the reporter (deduped).
  // The owner reviews + removes/restores at /voicedrop/admin/reports.
  if (request.method === 'POST' && action === 'community' && sub2 === 'report') {
    const shareId = segments[2] || '';
    if (!isShareId(shareId)) return json({ error: 'bad id' }, 400);
    if (!(await env.FILES.head(communityKey(shareId)))) return json({ error: 'not found' }, 404);
    let reason = ''; try { const b = await request.clone().json(); reason = (b && b.reason) || ''; } catch {}
    let rec = { shareId, status: 'pending', firstAt: Date.now(), reporters: [] };
    const d1rec = await coreGetReport(env, shareId);
    if (d1rec) rec = { ...rec, ...d1rec, status: 'pending' };
    if (!Array.isArray(rec.reporters)) rec.reporters = [];
    const by = scope || 'admin';
    if (!rec.reporters.some(r => r.by === by)) rec.reporters.push({ by, at: Date.now(), reason: String(reason).slice(0, 200) });
    await corePutReport(env, shareId, 'pending', rec.firstAt, rec.reporters);
    await indexSetHidden(shareId, true);
    return json({ ok: true });
  }

  // Admin: list pending reports with the reported post's current title/author/excerpt.
  if (request.method === 'GET' && action === 'community' && sub2 === 'reports') {
    if (scope !== '') return json({ error: 'admin only' }, 403);
    // pending 举报明细：D1 一条 SELECT；不可用报 503（admin 页可重试，不给假空表）。
    const base = await coreListReports(env);
    if (base === null) return json({ error: 'storage unavailable, retry' }, 503);
    const out = [];
    for (const rec of base) {
      const shareId = rec.shareId;
      let title = '', author = '', body = '', gone = false;
      const pObj = await env.FILES.get(communityKey(shareId));
      if (!pObj) gone = true;
      else try {
        const p = JSON.parse(await pObj.text());
        author = p.author || '';
        if (p.kind === 'prompt' && p.promptCode) {
          // 提示词帖没有 articleKey——内容真源是 shares/<码> 写穿副本。帖将死也无妨，
          // 读不到就留空串（catch 兜底），不额外处理。
          const leafObj = await env.FILES.get(`shares/${p.promptCode}`);
          if (leafObj) {
            const leaf = JSON.parse(await leafObj.text());
            title = leaf?.label || '分享提示词';
            body = (leaf?.instruction || '').slice(0, 600);
          }
        } else {
          const live = p.articleKey ? await env.FILES.get(p.articleKey) : null;
          if (live) { const arts = resolveArticles(JSON.parse(await live.text())); title = arts[0]?.title || ''; body = (arts[0]?.body || '').slice(0, 600); }
        }
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
    if (!isShareId(shareId)) return json({ error: 'bad id' }, 400);
    let act = 'restore'; try { const b = await request.clone().json(); act = (b && b.action) || 'restore'; } catch {}
    if (act === 'remove') {
      const key = communityKey(shareId);
      // 同生同死：帖是提示词帖就把 shares/<码> 也带走（对齐 unshare 的写法），
      // 否则举报下架只杀帖不杀码，voicedrop.cn/<码> 继续公开可访问。
      try {
        const obj = await env.FILES.get(key);
        if (obj) {
          const parsed = JSON.parse(await obj.text());
          if (parsed?.kind === 'prompt' && parsed.promptCode) {
            await env.FILES.delete(`shares/${parsed.promptCode}`).catch(() => {});
          }
        }
      } catch {}
      await env.FILES.delete(key).catch(() => {});
      await env.FILES.delete(reportKey(shareId)).catch(() => {});
      await coreDeleteReport(env, shareId);
      await indexDelete(shareId);
      return json({ ok: true, removed: true });
    }
    await env.FILES.delete(reportKey(shareId)).catch(() => {});
    await coreDeleteReport(env, shareId);
    await indexSetHidden(shareId, false);
    return json({ ok: true, restored: true });
  }

  // Get one community post — reads the live article and merges with pointer metadata.
  if (request.method === 'GET' && action === 'community' && sub2 === 'get') {
    const shareId = segments[2] || '';
    if (!isShareId(shareId)) return json({ error: 'bad id' }, 400);
    const obj = await env.FILES.get(communityKey(shareId));
    if (!obj) return json({ error: 'not found' }, 404);
    let p; try { p = JSON.parse(await obj.text()); } catch { return json({ error: 'bad post' }, 500); }
    if (p.kind === 'prompt') {
      const leaf = await livePromptLeaf(communityKey(shareId), p);
      if (!leaf) return json({ error: 'not found' }, 404);
      const articles = [{ title: promptPostTitle(leaf) || '分享提示词', body: leaf.instruction }];
      const heal = indexUpsert(p, articles, undefined, { kind: 'prompt' });
      if (waitUntil) waitUntil(heal); else await heal;
      return json({ shareId: p.shareId, author: p.author, title: articles[0].title,
                    articles, owner: p.owner, firstSharedAt: p.firstSharedAt,
                    kind: 'prompt', promptCode: p.promptCode,
                    ...(Array.isArray(leaf.appliesTo) ? { appliesTo: leaf.appliesTo } : {}),
                    ...(p.replyTo ? { replyTo: p.replyTo } : {}) });
    }
    // Seed from stored data (schema-1 fallback); overwrite with live article for schema-2.
    let articles = (p.articles || []).map(a => ({ title: a.title, body: a.body }));
    let title = p.title || articles[0]?.title || '';
    let legacyPhotos = p.photos;   // legacy [[photo:N]] resolution; new posts have none
    if (p.articleKey) {
      const live = await liveDocForPointer(communityKey(shareId), p);
      if (!live) return json({ error: 'not found' }, 404);   // orphan (reaped) or mid-regeneration
      articles = resolveArticles(live).map(a => ({ title: a.title, body: a.body }));
      title = articles[0]?.title ?? title;
      legacyPhotos = live.photos;
      // 展示索引自愈：live 文章此刻刚读过，顺手把最新标题/封面/预览刷回索引——
      // 文章编辑后 feed 里的过期卡片在任何人打开详情时更新。放 waitUntil 后台跑：
      // 它内部还有一次 R2 head（report 标记）+ D1 写，同步做要多背 ~0.3s。
      const heal = indexUpsert(p, articles, legacyPhotos);
      if (waitUntil) waitUntil(heal); else await heal;
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
    const shareId = await shareIdFor(articleKey, env.SESSION_SECRET);
    const exists = await env.FILES.head(communityKey(shareId));
    return json({ shared: !!exists, shareId: exists ? shareId : undefined });
  }


  // List posts that are responses to `shareId`, oldest-first.
  // 快路径同 list：reply_to 列直接从 D1 索引查（毫秒级），旧路径要全量扫
  // community/ 前缀再逐帖拉活文章。索引新鲜度由 share 时的同步双写 +
  // list 打开时的后台对账保证；D1 缺失/出错 → 回退 R2 慢路径。
  if (request.method === 'GET' && action === 'community' && sub2 === 'replies') {
    const shareId = segments[2] || '';
    if (!isShareId(shareId)) return json({ error: 'bad id' }, 400);
    if (env.RECO_DB) {
      try {
        const { results } = await env.RECO_DB.prepare(
          `SELECT share_id, author, title, first_shared_at, reply_to
           FROM community_posts WHERE reply_to=? AND hidden=0
           ORDER BY first_shared_at ASC`).bind(shareId).all();
        return json({ posts: (results || []).map(r => ({
          shareId: r.share_id, author: r.author, title: r.title,
          firstSharedAt: r.first_shared_at, replyTo: r.reply_to })) });
      } catch (e) { console.log('[community-index] replies read failed', String(e?.message || e)); }
    }
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
        ? await ensureStyleSeeded(env, styleScope)
        : await readStyleDoc(env, styleScope);
      if (doc) return json({ style: resolveStyle(doc), name: (doc.profile && doc.profile.name) || '', head: doc.head, createdAt: doc.createdAt || 0, updatedAt: doc.updatedAt || 0, default: isDefaultSeed(doc) });
      const md = await readLegacyStyleMd(env, styleScope);
      if (md) {
        const m = md.match(/#\s*我的名字\s*\n+([^\n#]+)/);
        return json({ style: parseStyleMarkdown(md), name: (m && m[1].trim()) || '', head: 0, legacy: true });
      }
      return json({ error: 'not found' }, 404);
    }

    if (request.method === 'GET' && subaction === 'history') {
      const doc = await readStyleDoc(env, styleScope);
      if (!doc) return json({ error: 'not found' }, 404);
      return json({ head: doc.head, versions: doc.versions || [] });
    }

    if (request.method === 'PUT' && !subaction) {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const style = typeof body.style === 'string' ? body.style : '';
      // Non-versioned profile fields, merged in one patch (extensible: name, …).
      // 旧客户端还会 PUT {styles}（已下线的多风格对比）——直接忽略该字段。
      const profilePatch = {};
      if (typeof body.name === 'string') profilePatch.name = body.name.trim();
      const hasProfile = Object.keys(profilePatch).length > 0;
      if (!style.trim() && !hasProfile) return json({ error: 'empty_content' }, 400);
      const source = body.source === 'agent' ? 'agent' : (scope ? 'app' : 'mine');
      // profile fields → no version; style → a new version. profile survives the style
      // write (writeStyleDoc carries it forward), so doing profile first is safe.
      let head;
      if (hasProfile) { head = (await mergeProfile(env, styleScope, profilePatch)).head; }
      if (style.trim()) { head = (await writeStyleDoc(env, styleScope, style, source)).head; }
      return json({ ok: true, head: head ?? 0 });
    }

    if (request.method === 'PATCH' && subaction === 'head') {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const newHead = typeof body.head === 'number' ? body.head : null;
      if (!newHead) return json({ error: 'head required' }, 400);
      const doc = await setStyleHead(env, styleScope, newHead);
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
        let deleted = 0;
        // Clear BOTH: the corpus samples (style/*.json) AND the legacy raw drop files
        // (top-level VoiceDrop-style-*.<ext> uploaded by the old SLCompose extension).
        // Deleting only the samples let the miner's collectStyle re-collect them from the
        // lingering raw files → items "reappeared" and couldn't be deleted. Prefix
        // `VoiceDrop-style-` does NOT match `VoiceDrop-writing-style-intro` (the intro).
        for (const prefix of [`${styleScope}style/`, `${styleScope}VoiceDrop-style-`]) {
          let cursor;
          do {
            const listed = await env.FILES.list({ prefix, cursor });
            for (const o of listed.objects) { await env.FILES.delete(o.key); deleted++; }
            cursor = listed.truncated ? listed.cursor : null;
          } while (cursor);
        }
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
    // URL-decode each segment — CF Pages leaves params.path percent-encoded, and Android
    // recordings carry Chinese stems (e.g. VoiceDrop-…-周三-上午). Without decoding, the
    // article/marker is STORED under the encoded key (…%E5%91%A8…) while the miner's
    // existence check (env.FILES.head on the decoded key) never matches → the recording
    // is re-mined every pass, burning ASR+LLM tokens and blocking the queue. Matches the
    // decodeURIComponent already used by the raw-file handlers above.
    const rest = segments.slice(1).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
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

    // GET /articles — list.
    // 快路径：D1 articles 表一条 SELECT 直出（entry 原样回吐）——R2 listing 本身
    // 就要 ~1s（几百个对象一页），是这个接口慢的大头，所以稳态不再等它。索引行
    // 由每个写入口同步维护（article-store 的 putArticleDoc / 下面的 DELETE），
    // 新挖出的文章在 miner PUT 返回前就已入索引，App 刷新即见。R2 listing 仍是
    // 权威：响应发出后 waitUntil 里跑 reconcileArticles 全量对账，写-写并发的
    // lost update、绕过 API 的直写（agent 的 style-intro）一次打开后收敛。
    // D1 空/不可用，或运行时没有 waitUntil（测试）→ 同步对账，行为同旧版。
    if (request.method === 'GET' && !stem) {
      if (waitUntil) {
        const d1rows = await coreListArticles(env, articleScope);
        if (d1rows && d1rows.length) {
          const cached = [];
          for (const r of d1rows) {
            if (!r.entry) continue;
            try { cached.push(JSON.parse(r.entry)); } catch {}
          }
          if (cached.length) {
            cached.sort(byNewestFirst);
            waitUntil(reconcileArticlesIndex(env, articleScope).catch(() => {}));
            return json({ articles: cached });
          }
        }
      }
      return json({ articles: await reconcileArticlesIndex(env, articleScope) });
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
      // 「我的录音」以 .m4a 为锚：没有同名录音的文章 doc 在列表里根本不显示。录音走正常
      // 流程时锚早就在了；但 agent/MCP 拿一个全新 stem 直接建文章（write_article）时没有，
      // 于是文章写进去了却谁也看不见。补一个 0s 静音占位，和 merge_articles、写作风格 intro
      // 的做法一致。JSON 先写、m4a 后写 —— 反过来 miner 会把这个裸 m4a 当成新录音去转写。
      const audioKey = `${articleScope}${stem}.m4a`;
      if (!(await env.FILES.head(audioKey))) {
        await env.FILES.put(audioKey, silentM4aBytes(), { httpMetadata: { contentType: 'audio/mp4' } });
      }
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

    // PATCH /articles/<stem>/question — 追问状态（answered/skipped），元数据写，不铸版本
    if (request.method === 'PATCH' && subaction === 'question') {
      let body; try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const qid = typeof body.id === 'string' ? body.id : '';
      const status = typeof body.status === 'string' ? body.status : '';
      if (!qid || !status) return json({ error: 'id and status required' }, 400);
      const doc = await setQuestionStatus(env, key, qid, status);
      if (!doc) return json({ error: 'question not found' }, 404);
      return json({ ok: true, questions: doc.questions });
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
      await setIndexFlag(env, articleScope, stem, 'empty');   // recordings 轻量接口的状态源
      return json({ ok: true });
    }

    // PUT /articles/<stem>/blocked — mark no-credit
    if (request.method === 'PUT' && subaction === 'blocked') {
      const blockedKey = `${articleScope}articles/${stem}.blocked`;
      let body; try { body = await request.json(); } catch { body = {}; }
      await env.FILES.put(blockedKey, JSON.stringify({ status: 'blocked', reason: body.reason || 'no-credit' }), { httpMetadata: { contentType: 'application/json' } });
      await setIndexFlag(env, articleScope, stem, 'blocked');
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
        env.FILES.delete(`${prefix}.tags`),
        removeIndexEntry(env, `${prefix}.json`),   // 摘要索引条目一并摘掉（list 快路径直出它）
      ]);
      return json({ ok: true });
    }

    return json({ error: 'bad request' }, 400);
  }

  return json({ error: 'bad request' }, 400);
}

// Kick the Cloudflare miner Worker. authHeader is the caller's Authorization
// header — any valid session token (user or admin) is accepted by /agent/mine/trigger.
// photoTs（可选）= 照片落盘 poke：让该用户的 Miner DO 记一个晚到照片补写待办。
// scope（可选）= 照片所属用户前缀；仅 admin 调用方生效（trigger 用它定向分片）。
async function dispatchMine(authHeader, photoTs = '', scope = '') {
  try {
    // Use the workers.dev URL to bypass same-zone Pages routing (which returns
    // 405 for POST on static paths before the Worker zone route can handle it).
    const qs = [
      photoTs ? `photoTs=${encodeURIComponent(photoTs)}` : '',
      scope ? `scope=${encodeURIComponent(scope)}` : '',
    ].filter(Boolean).join('&');
    const resp = await fetch('https://voicedrop-agent.jianshuo.workers.dev/agent/mine/trigger'
        + (qs ? `?${qs}` : ''), {
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

async function exchangeWechatCode(code, env) {
  const qs = new URLSearchParams({
    appid: env.WECHAT_OPEN_APP_ID,
    secret: env.WECHAT_OPEN_APP_SECRET,
    code,
    grant_type: 'authorization_code',
  });
  const resp = await fetch(`https://api.weixin.qq.com/sns/oauth2/access_token?${qs.toString()}`);
  if (!resp.ok) throw new Error(`wechat HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.errcode) throw new Error(data.errmsg || `wechat errcode ${data.errcode}`);
  if (!data.openid) throw new Error('wechat missing openid');
  return {
    openid: data.openid,
    unionid: data.unionid || null,
  };
}

async function exchangeWechatMiniCode(code, env) {
  const qs = new URLSearchParams({
    appid: env.WECHAT_MINI_APP_ID,
    secret: env.WECHAT_MINI_APP_SECRET,
    js_code: code,
    grant_type: 'authorization_code',
  });
  const resp = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${qs.toString()}`);
  if (!resp.ok) throw new Error(`wechat HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.errcode) throw new Error(data.errmsg || `wechat errcode ${data.errcode}`);
  if (!data.openid) throw new Error('wechat missing openid');
  return {
    openid: data.openid,
    unionid: data.unionid || null,
  };
}

function signinRequiredError(request) {
  const platform = (request.headers.get('X-VD-Platform') || request.headers.get('X-VD-Client') || '').toLowerCase();
  return platform === 'android' ? 'needs_wechat_signin' : 'needs_apple_signin';
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

async function mintWechatSession(scope, secret) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ scope, wechat: true, iat: now, exp: now + 365 * 24 * 3600 }));
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
