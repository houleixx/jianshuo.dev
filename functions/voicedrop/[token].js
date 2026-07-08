// Public, unauthenticated preview of a single mined VoiceDrop article set.
//
// URL:  https://jianshuo.dev/voicedrop/<id>   (e.g. /voicedrop/Ab3xK9_p2Q)
// The short <id> is minted server-side by GET /files/api/share/<name>
// (authenticated), which stores a shares/<id> → "users/<sub>/articles/<stem>.json"
// record in R2. This page resolves that mapping and serves ONLY the target
// article JSON — never audio, the file list, or any other key. A segment with no
// mapping (e.g. "privacy") falls through to the static assets, so it never
// shadows /voicedrop/ or /voicedrop/privacy/.

import { TITLE_FALLBACK, resolveArticles } from "../lib/article-store.js";
import { communityKey, reportKey } from "../lib/community-store.js";

export async function onRequest(context) {
  const { params, env } = context;
  const id = params.token || '';

  // Only short, URL-safe ids are share links; anything else → static fallthrough.
  if (!/^[A-Za-z0-9_-]{6,16}$/.test(id)) return context.next();

  // ONE public page serves TWO link kinds, both resolving to an article key and
  // rendering identically (same og:image + description):
  //   1. shares/<id>           — a user's own article share (GET /files/api/share/<key>)
  //   2. community/<id>.json    — a VD社区 post (schema-2 live pointer {…,articleKey})
  // So a 社区 post shares to WeChat exactly like an article — no separate page/crawler path.
  let key = null;
  const map = await env.FILES.get(`shares/${id}`);
  if (map) {
    key = await map.text();
  } else {
    const cm = await env.FILES.get(communityKey(id));
    if (cm) {
      // A reported (taken-down) post must not stay publicly viewable (Apple 1.2).
      if (await env.FILES.head(reportKey(id))) {
        return html(page('已不可用', '<p class="muted">这篇分享已被移除。</p>'), 404);
      }
      try { key = JSON.parse(await cm.text()).articleKey || null; } catch { /* fallthrough */ }
    }
  }
  if (!key || !/^users\/[^/]+\/articles\/[^/]+\.json$/.test(key)) return context.next();

  const obj = await env.FILES.get(key);
  if (!obj) return html(page('文章不存在', '<p class="muted">这篇文章可能已经被删除了。</p>'), 404);

  let doc;
  try { doc = JSON.parse(await obj.text()); } catch { return html(page('无法打开', '<p class="muted">文章内容损坏。</p>'), 500); }

  const articles = resolveArticles(doc).filter((a) => a && (a.body || '').trim());
  if (!articles.length) {
    return html(page('暂无内容', '<p class="muted">这条录音还没有挖出文章。</p>'), 200);
  }

  // Honor a ?s=<index> selection — the section the user had open when they shared.
  // The app sends the index of the on-screen article; render (and preview) just
  // that one. An absent / out-of-range value falls back to the whole set so old
  // links keep working.
  const sel = parseInt(new URL(context.request.url).searchParams.get('s'), 10);
  const shown = (Number.isInteger(sel) && sel >= 0 && sel < articles.length)
    ? [articles[sel]]
    : articles;
  const title = shown[0].title || 'VoiceDrop';

  // Resolve the photos the body references ([[photo:<key>]] markers; legacy
  // [[photo:N]] via doc.photos) to public photo URLs. The body is the source of truth.
  const photoRefs = photoRefsInBodies(shown.map((a) => a.body || ''), doc.photos);
  const photoURIs = buildPhotoURLs(key, shown.map((a) => a.body || ''), doc.photos);

  const bodyHtml = shown.map((a) =>
    `<article><h1>${esc(a.title || TITLE_FALLBACK)}</h1>${renderPhotos(mdToHtml(a.body || ''), photoURIs)}</article>`
  ).join('<hr/>');

  // Share-card image = the FIRST photo THIS section references, as an ABSOLUTE URL
  // (WeChat / X crawlers need a full origin, not the root-relative inline src). No
  // photo → no og:image, so photo-less articles still render as a clean text card.
  const fwdHost = context.request.headers?.get?.('x-forwarded-host');
  const origin = fwdHost ? `https://${fwdHost}` : new URL(context.request.url).origin;
  const image = photoRefs.length ? origin + photoURIs[photoRefs[0].token] : '';

  const og = {
    description: plainExcerpt(stripPhotoMarkers(shown[0].body), 120),
    // 规范链接用真实域名 + 干净短链（经备案接入点反代时 request.url 是
    // pages.dev/voicedrop/<id>，直接用会让微信卡片指到内部域名）。
    url: fwdHost ? `${origin}/${id}` : context.request.url,
    image,
  };
  return html(page(title, bodyHtml, og), 200, true);
}

// Strip [[photo:<token>]] markers from text (for excerpts / fallback). Token is a
// relative key (new) or a legacy digit index — both match.
export function stripPhotoMarkers(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, '').replace(/\[\[photo:[^\]]+\]\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

// Replace [[photo:<token>]] markers in rendered HTML with inline <figure><img>. A
// marker on its own line became its own <p>; handle both that and stray inline ones.
// `photoURIs` is keyed BOTH by 1-based index (legacy) and by relative key (new), so
// a numeric token resolves via the index and a key token resolves directly.
export function renderPhotos(htmlStr, photoURIs) {
  const fig = (tok) => {
    const uri = /^\d+$/.test(tok) ? photoURIs[Number(tok)] : photoURIs[tok];
    return uri ? `<figure class="vd-photo"><img src="${uri}" alt="" loading="lazy"/></figure>` : '';
  };
  return htmlStr
    .replace(/<p>\s*\[\[photo:([^\]]+)\]\]\s*<\/p>/g, (_, t) => fig(t))
    .replace(/\[\[photo:([^\]]+)\]\]/g, (_, t) => fig(t));
}

// Collect the photo keys the article bodies actually reference, in first-appearance
// order, deduped by token. Token = relative key (new [[photo:<key>]]) or a legacy
// 1-based index into `legacyPhotos` (old [[photo:N]]). Legacy tokens with no array
// entry are dropped. The body is the source of truth — there is no photos array to
// maintain for new articles.
export function photoRefsInBodies(bodies, legacyPhotos = []) {
  const legacy = Array.isArray(legacyPhotos) ? legacyPhotos : [];
  const out = [];
  const seen = new Set();
  const re = /\[\[photo:([^\]]+)\]\]/g;
  for (const body of bodies) {
    let m;
    while ((m = re.exec(String(body || ''))) !== null) {
      const token = m[1];
      if (seen.has(token)) continue;
      seen.add(token);
      const key = /^\d+$/.test(token) ? legacy[Number(token) - 1] : token;
      if (key) out.push({ token, key });
    }
  }
  return out;
}

// Map each referenced photo token -> a public photo URL. Uses the ONE photo endpoint
// (`/files/api/photo/<full key>`) shared by the app, this page, and any exported HTML —
// render straight from the photo's original R2 location. Root-relative (same host) and
// cacheable as a plain <img src>, instead of inlining megabytes of base64. Keyed by the
// raw token so renderPhotos' fig(token) resolves it (numeric + key tokens both work).
function buildPhotoURLs(articleKey, bodies, legacyPhotos) {
  const refs = photoRefsInBodies(bodies, legacyPhotos);
  if (!refs.length) return {};
  const prefix = articleKey.slice(0, articleKey.indexOf('/articles/') + 1);  // users/<sub>/
  const out = {};
  for (const { token, key } of refs) {
    out[token] = `/files/api/photo/${encodeURI(prefix + key)}`;
  }
  return out;
}

// --- minimal, safe markdown -> HTML (escape first, then a few block rules) ---
function mdToHtml(src) {
  const blocks = String(src).replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').split(/\n{2,}/);
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

// resolveArticles is imported from ../lib/article-store.js (single source of truth).
// The caller drops empty-body articles for display.

// A short, plain-text excerpt for og:description — strip markdown marks, collapse
// whitespace, trim to `max` chars on a clean-ish boundary.
function plainExcerpt(body, max) {
  const t = String(body).replace(/[#*`>_~]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/[，。、；,.;:\s]+$/, '') + '…';
}

function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

// Open Graph + Twitter Card + WeChat share-card tags.
//   title       — the section-aware article title (?s=<i> selects it upstream).
//   description — a plain-text excerpt of THIS section's body. WeChat's crawler
//                 reads <meta name="description"> for the card summary (NOT
//                 og:description), so it's emitted alongside the og/twitter ones.
//   image       — set ONLY when this section references a photo; then the card
//                 upgrades to a large-image card. Each article carries its OWN
//                 first photo (no recycled banner — a shared static image read as
//                 spam), and a photo-less article stays a clean text card.
export function metaTags(title, og) {
  const t = escAttr(title);
  const d = escAttr(og.description || '把口述，变成文章');
  const u = escAttr(og.url || 'https://voicedrop.cn/');
  const img = og.image ? escAttr(og.image) : '';
  const tags = [
    '<meta property="og:type" content="article"/>',
    '<meta property="og:site_name" content="VoiceDrop"/>',
    `<meta property="og:title" content="${t}"/>`,
    `<meta property="og:description" content="${d}"/>`,
    `<meta property="og:url" content="${u}"/>`,
    // WeChat's link-card crawler reads <meta name="description">, not og:description.
    `<meta name="description" content="${d}"/>`,
    `<meta name="twitter:title" content="${t}"/>`,
    `<meta name="twitter:description" content="${d}"/>`,
  ];
  if (img) {
    tags.push(
      `<meta property="og:image" content="${img}"/>`,
      `<meta name="twitter:image" content="${img}"/>`,
      '<meta name="twitter:card" content="summary_large_image"/>',
      // Older WeChat clients pick the thumbnail off <link rel="image_src">.
      `<link rel="image_src" href="${img}"/>`,
    );
  } else {
    tags.push('<meta name="twitter:card" content="summary"/>');
  }
  return tags.join('\n');
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
<footer>由 <a href="https://voicedrop.cn/">VoiceDrop</a> 口述生成</footer>
</div></body></html>`;
}

function html(body, status = 200, cache = false) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (cache) headers['Cache-Control'] = 'public, max-age=300';
  return new Response(body, { status, headers });
}
