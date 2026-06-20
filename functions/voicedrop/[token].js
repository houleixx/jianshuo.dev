// Public, unauthenticated preview of a single mined VoiceDrop article set.
//
// URL:  https://jianshuo.dev/voicedrop/<token>
// where <token> = b64url(fullKey) + "." + HMAC_b64url("share:"+payload, SESSION_SECRET)
// and fullKey is "users/<sub>/articles/<stem>.json" in the FILES R2 bucket.
//
// The token is minted server-side by GET /files/api/share/<name> (authenticated),
// so the HMAC secret never leaves the worker. This page serves ONLY a validly
// signed article JSON — never audio, the file list, or any other key. A segment
// that isn't a valid token (e.g. "privacy") falls through to the static assets,
// so it never shadows /voicedrop/ or /voicedrop/privacy/.

export async function onRequest(context) {
  const { params, env } = context;
  const token = params.token || '';

  const dot = token.lastIndexOf('.');
  if (dot < 0 || !env.SESSION_SECRET) return context.next();
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = await hmacSign('share:' + payload, env.SESSION_SECRET);
  if (!timingSafeEqual(sig, expected)) return context.next(); // not ours → static fallthrough

  let key;
  try { key = b64urlToString(payload); } catch { return context.next(); }
  if (!/^users\/[^/]+\/articles\/[^/]+\.json$/.test(key)) return context.next();

  const obj = await env.FILES.get(key);
  if (!obj) return html(page('文章不存在', '<p class="muted">这篇文章可能已经被删除了。</p>'), 404);

  let doc;
  try { doc = JSON.parse(await obj.text()); } catch { return html(page('无法打开', '<p class="muted">文章内容损坏。</p>'), 500); }

  const articles = resolveArticles(doc);
  if (!articles.length) {
    return html(page('暂无内容', '<p class="muted">这条录音还没有挖出文章。</p>'), 200);
  }
  const title = articles[0].title || 'VoiceDrop';
  const bodyHtml = articles.map((a) =>
    `<article><h1>${esc(a.title || '无题')}</h1>${mdToHtml(a.body || '')}</article>`
  ).join('<hr/>');
  return html(page(title, bodyHtml), 200, true);
}

// --- minimal, safe markdown -> HTML (escape first, then a few block rules) ---
function mdToHtml(src) {
  const blocks = String(src).replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((b) => {
    const t = b.trim();
    if (!t) return '';
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = Math.min(h[1].length + 1, 4); return `<h${n}>${inline(h[2])}</h${n}>`; }
    const lines = t.split('\n');
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return '<ul>' + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('') + '</ul>';
    }
    if (lines.every((l) => /^\s*\d+\.\s+/.test(l))) {
      return '<ol>' + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('') + '</ol>';
    }
    return `<p>${inline(t.replace(/\n/g, '<br/>'))}</p>`;
  }).join('\n');
}
function inline(s) {
  // s is already HTML-escaped; apply bold/italic/code on top.
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveArticles(doc) {
  if (Array.isArray(doc.articles) && doc.articles.length) {
    return doc.articles.filter((a) => a && (a.body || '').trim());
  }
  if (doc.body && String(doc.body).trim()) return [{ title: doc.title || '无题', body: doc.body }];
  return [];
}

function page(title, inner) {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<title>${esc(title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#faf9f7;color:#1d1d1f;
  font:17px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  -webkit-text-size-adjust:100%}
.wrap{max-width:680px;margin:0 auto;padding:40px 22px 64px}
article h1{font-size:1.6rem;line-height:1.3;margin:0 0 1rem;font-weight:700}
article h2{font-size:1.2rem;margin:1.8rem 0 .6rem}
article h3,article h4{font-size:1.05rem;margin:1.4rem 0 .5rem}
p{margin:0 0 1.05rem}
ul,ol{margin:0 0 1.05rem;padding-left:1.4rem}
li{margin:.25rem 0}
code{background:#efeee9;padding:.1em .35em;border-radius:4px;font-size:.92em}
strong{font-weight:650}
hr{border:none;border-top:1px solid #e6e3dd;margin:2.4rem 0}
.muted{color:#86868b}
footer{margin-top:3rem;padding-top:1.2rem;border-top:1px solid #ececec;
  color:#a1a1a6;font-size:.82rem}
footer a{color:#86868b;text-decoration:none}
::selection{background:#ffe49b}
</style></head>
<body><div class="wrap">
${inner}
<footer>由 <a href="https://jianshuo.dev/voicedrop/">VoiceDrop</a> 口述生成 · 王建硕</footer>
</div></body></html>`;
}

function html(body, status = 200, cache = false) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (cache) headers['Cache-Control'] = 'public, max-age=300';
  return new Response(body, { status, headers });
}

// --- crypto / encoding helpers (mirror of files/api) ---
async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
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
