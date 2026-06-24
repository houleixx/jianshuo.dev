// Public, unauthenticated preview of a single mined VoiceDrop article set.
//
// URL:  https://jianshuo.dev/voicedrop/<id>   (e.g. /voicedrop/Ab3xK9_p2Q)
// The short <id> is minted server-side by GET /files/api/share/<name>
// (authenticated), which stores a shares/<id> → "users/<sub>/articles/<stem>.json"
// record in R2. This page resolves that mapping and serves ONLY the target
// article JSON — never audio, the file list, or any other key. A segment with no
// mapping (e.g. "privacy") falls through to the static assets, so it never
// shadows /voicedrop/ or /voicedrop/privacy/.

export async function onRequest(context) {
  const { params, env } = context;
  const id = params.token || '';

  // Only short, URL-safe ids are share links; anything else → static fallthrough.
  if (!/^[A-Za-z0-9_-]{6,16}$/.test(id)) return context.next();
  const map = await env.FILES.get(`shares/${id}`);
  if (!map) return context.next();
  const key = await map.text();
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

  // Load session photos as inline data URIs (1-based), so [[photo:N]] markers in
  // the body render as <img> on the public page too. Photos live under the same
  // user prefix as the article key.
  const photoURIs = await loadPhotoURIs(env, key, doc.photos);

  const bodyHtml = articles.map((a) =>
    `<article><h1>${esc(a.title || '无题')}</h1>${renderPhotos(mdToHtml(a.body || ''), photoURIs)}</article>`
  ).join('<hr/>');
  const og = { description: plainExcerpt(stripPhotoMarkers(articles[0].body), 120), url: context.request.url };
  return html(page(title, bodyHtml, og), 200, true);
}

// Strip [[photo:N]] markers from text (for excerpts / fallback).
function stripPhotoMarkers(s) {
  return String(s).replace(/\[\[photo:\d+\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Replace [[photo:N]] markers in rendered HTML with inline <figure><img>. A marker
// on its own line became its own <p>; handle both that and any stray inline ones.
function renderPhotos(htmlStr, photoURIs) {
  const fig = (n) => {
    const uri = photoURIs[Number(n)];
    return uri ? `<figure class="vd-photo"><img src="${uri}" alt="" loading="lazy"/></figure>` : '';
  };
  return htmlStr
    .replace(/<p>\s*\[\[photo:(\d+)\]\]\s*<\/p>/g, (_, n) => fig(n))
    .replace(/\[\[photo:(\d+)\]\]/g, (_, n) => fig(n));
}

// Read each session photo from R2 and return a 1-based map index -> data URI.
async function loadPhotoURIs(env, articleKey, photos) {
  if (!Array.isArray(photos) || !photos.length) return {};
  const prefix = articleKey.slice(0, articleKey.indexOf('/articles/') + 1);  // users/<sub>/
  const out = {};
  for (let i = 0; i < photos.length; i++) {
    try {
      const obj = await env.FILES.get(prefix + photos[i]);
      if (!obj) continue;
      const buf = await obj.arrayBuffer();
      out[i + 1] = `data:image/jpeg;base64,${b64(buf)}`;
    } catch { /* skip a missing photo */ }
  }
  return out;
}

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
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

// A short, plain-text excerpt for og:description — strip markdown marks, collapse
// whitespace, trim to `max` chars on a clean-ish boundary.
function plainExcerpt(body, max) {
  const t = String(body).replace(/[#*`>_~]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/[，。、；,.;:\s]+$/, '') + '…';
}

function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

// Open Graph + Twitter Card tags. No og:image on purpose — sharing the same
// branded banner over and over reads as spam, so links render as a plain
// text card (title + description) instead of a large image card.
function metaTags(title, og) {
  const t = escAttr(title);
  const d = escAttr(og.description || '把口述，变成文章');
  const u = escAttr(og.url || 'https://jianshuo.dev/voicedrop/');
  return [
    '<meta property="og:type" content="article"/>',
    '<meta property="og:site_name" content="VoiceDrop"/>',
    `<meta property="og:title" content="${t}"/>`,
    `<meta property="og:description" content="${d}"/>`,
    `<meta property="og:url" content="${u}"/>`,
    '<meta name="twitter:card" content="summary"/>',
    `<meta name="twitter:title" content="${t}"/>`,
    `<meta name="twitter:description" content="${d}"/>`,
  ].join('\n');
}

function page(title, inner, og) {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<title>${esc(title)}</title>
${og ? metaTags(title, og) : ''}
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
.vd-photo{margin:1.4rem 0}
.vd-photo img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:12px;display:block}
.muted{color:#86868b}
footer{margin-top:3rem;padding-top:1.2rem;border-top:1px solid #ececec;
  color:#a1a1a6;font-size:.82rem}
footer a{color:#86868b;text-decoration:none}
::selection{background:#ffe49b}
</style></head>
<body><div class="wrap">
${inner}
<footer>由 <a href="https://jianshuo.dev/voicedrop/">VoiceDrop</a> 口述生成</footer>
</div></body></html>`;
}

function html(body, status = 200, cache = false) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (cache) headers['Cache-Control'] = 'public, max-age=300';
  return new Response(body, { status, headers });
}
