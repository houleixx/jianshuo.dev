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
import { communityKey, reportKey, promptPostTitle } from "../lib/community-store.js";
import { writeRefhit, ipHash } from "../lib/refhits.js";
import { phCapture } from "../lib/posthog.js";

// 分享页访问打点（2026-07-17 用户要求：看每张分享页的访问量）。元数据 only；
// distinct_id = ipHash（DEBUG_PLAINTEXT_IP 调试期即明文 IP），真实 IP 提取与
// i/[code].js 同款（反代下取 XFF 首段）。爬虫不过滤只打标——微信/QQ 抓卡片、
// 搜索蜘蛛都会来，PostHog 里按「疑似爬虫 = false」看真人量。best-effort 永不 throw。
async function trackShareView(context, env, id, kind, owner, extra = {}) {
  try {
    const { request } = context;
    const fwdHost = request.headers?.get?.("x-forwarded-host");
    const xff = (request.headers?.get?.("X-Forwarded-For") || "").split(",")[0].trim();
    const ip = (fwdHost && xff) || request.headers?.get?.("CF-Connecting-IP");
    const vid = ip && env.SESSION_SECRET ? await ipHash(ip, env.SESSION_SECRET) : `anon-${id}`;
    const ua = String(request.headers?.get?.("user-agent") || "");
    const p = phCapture(env, "分享页访问", vid, {
      码: id, 类型: kind,
      平台: /iPhone|iPad|iPod/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : "other",
      微信内: /MicroMessenger/i.test(ua),
      疑似爬虫: /bot|spider|crawler|curl|wget|python|httpclient|okhttp|headless/i.test(ua),
      ...(owner ? { 作者: String(owner).replace("users/", "").replace("anon-", "").slice(0, 8) } : {}),
      ...extra,
    });
    if (context.waitUntil) context.waitUntil(p);
  } catch { /* 打点绝不影响页面 */ }
}

const APP_STORE = "https://apps.apple.com/cn/app/id6781565141";

// 落地页 CTA：并进 footer 同一行——「由 VoiceDrop 口述生成。下载，你约得 X 算力，
// 作者约得 Y 算力」（2026-07-09 用户定稿：低调，不影响阅读）。奖励数字按「访问时刻」
// 池子价现算（「约得」自带约，实发以入账时为准，rate 来自 worker 铸币后发布的
// R2 config/mint-rate.json）。rate/cfg 读不到或 enabled:false → 只补「。下载」不提奖励。
// 「下载」点击顺手把本页 URL 写进剪贴板（用户手势，微信内也允许）——App 首启
// 剪贴板兜底归因（第 3 层）靠它。返回值拼在 footer 文案之后。
export function ctaHtml(rate, cfg, id = '', proxied = false) {
  const on = cfg && cfg.enabled !== false && rate && rate.suanliPerCoin > 0;
  // 双边同额（当前 9:9）→「下载和作者各得 X 算力」；不同额时回退双数字句式。
  const equal = on && cfg.newUserCoins === cfg.authorCoins;
  const reward = !on ? ''
    : equal ? `和作者各得 ${Math.round(cfg.newUserCoins * rate.suanliPerCoin)} 算力`
    : `，你约得 ${Math.round(cfg.newUserCoins * rate.suanliPerCoin)} 算力，作者约得 ${Math.round(cfg.authorCoins * rate.suanliPerCoin)} 算力`;
  // ① 第一方 beacon：浏览器直连 jianshuo.dev 报到——voicedrop.cn 反代吃掉真实 IP，
  //    IP 指纹只能靠这条（/agent/referral/hit）写。只在反代页注入：直连页服务端
  //    渲染时已写过指纹，再发 beacon 同一次访问会记两条（2026-07-17 用户发现）。
  //    ② 下载点击写剪贴板：execCommand 先行（微信 webview 里 navigator.clipboard
  //    常年不可用），clipboard API 叠双保险。
  const beacon = (id && proxied) ? `var H='https://jianshuo.dev/agent/referral/hit',C='${esc(id)}';
try{(navigator.sendBeacon&&navigator.sendBeacon(H,C))||fetch(H,{method:'POST',body:C,mode:'no-cors',keepalive:true})}catch(e){}
` : '';
  return `。<a id="vd-dl" href="${APP_STORE}">下载</a>${reward}
<script>${beacon}document.getElementById('vd-dl').addEventListener('click',function(){
try{var t=document.createElement('textarea');t.value=location.href;t.style.cssText='position:fixed;opacity:0';
document.body.appendChild(t);t.select();t.setSelectionRange(0,99999);document.execCommand('copy');document.body.removeChild(t);}catch(e){}
try{navigator.clipboard&&navigator.clipboard.writeText(location.href)}catch(e){}})</script>`;
}

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
  let viaCommunity = false;   // 打点用：article（shares/ 直分享）还是 community（社区帖）
  const map = await env.FILES.get(`shares/${id}`);
  if (map) {
    key = await map.text();
    // 指令分享码（魔法数字）：shares/<码> 是 typed JSON（老式文章条目是纯文本
    // key，JSON.parse 失败自然走原路）。写穿副本自带 label/instruction，零额外读。
    try {
      const ptr = JSON.parse(key);
      if (ptr && typeof ptr === "object") {
        if (ptr.type === "prompt" && typeof ptr.instruction === "string") {
          return promptSharePage(context, env, id, ptr);
        }
        return context.next(); // 未知 typed 条目：不当文章 key 用
      }
    } catch { /* 纯文本文章 key，走原路 */ }
  } else if (/^[1-9][0-9]{6}$/.test(id)) {
    // 纯数字码永远不是静态资源；查无 = 作者已关闭分享（或码不存在）。
    return html(page('分享已停止', '<p class="muted">这条分享已被作者停止，或者链接不存在。</p>'), 404);
  } else {
    const cm = await env.FILES.get(communityKey(id));
    if (cm) {
      // A reported (taken-down) post must not stay publicly viewable (Apple 1.2).
      if (await env.FILES.head(reportKey(id))) {
        return html(page('已不可用', '<p class="muted">这篇分享已被移除。</p>'), 404);
      }
      try {
        const post = JSON.parse(await cm.text());
        // 提示词帖（kind=prompt）没有 articleKey，内容在 shares/<promptCode> 写穿
        // 副本里——在帖子 URL 上原地渲染指令页（URL 不变，微信爬虫抓 og 更稳）。
        // 页面展示/口播的分享码用 7 位码；shares 副本已消失（同生同死被关）→
        // 与纯数字码查无同款「分享已停止」。
        if (post && post.kind === 'prompt' && post.promptCode) {
          const m = await env.FILES.get(`shares/${post.promptCode}`);
          if (m) {
            try {
              const ptr = JSON.parse(await m.text());
              if (ptr && ptr.type === 'prompt' && typeof ptr.instruction === 'string') {
                return promptSharePage(context, env, id, ptr, String(post.promptCode));
              }
            } catch { /* 副本损坏 → 按已停止处理 */ }
          }
          return html(page('分享已停止', '<p class="muted">这条分享已被作者停止，或者链接不存在。</p>'), 404);
        }
        key = post.articleKey || null;
        viaCommunity = true;
      } catch { /* fallthrough */ }
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

  // 邀请归因：记录本次访问的 IP 指纹（归因第 2 层，refhits/，R2 lifecycle 2 天）。
  // 只在直连时服务端写——voicedrop.cn 反代下 CF-Connecting-IP 是代理出口 IP（垃圾），
  // 反代流量由 ctaHtml 里的第一方 beacon 补真实 IP。缺 SESSION_SECRET / IP 时静默跳过。
  const shareOwner = (key.match(/^(users\/[^/]+\/)/) || [])[1];
  const visitorIP = context.request.headers?.get?.('CF-Connecting-IP');
  if (!fwdHost && shareOwner && visitorIP && env.SESSION_SECRET && context.waitUntil) {
    context.waitUntil(
      writeRefhit({ FILES: env.FILES }, visitorIP, env.SESSION_SECRET, shareOwner, id, Date.now())
        .catch(() => {}));
  }
  // CTA 实时价：worker 铸币后发布的现价 + 面额配置，任一读不到就走通用文案。
  let rate = null, refCfg = null;
  try { const o = await env.FILES.get('config/mint-rate.json'); if (o) rate = JSON.parse(await o.text()); } catch {}
  try { const o = await env.FILES.get('config/referral.json'); if (o) refCfg = JSON.parse(await o.text()); } catch {}
  const cta = ctaHtml(rate, refCfg || { enabled: true, authorCoins: 12, newUserCoins: 6 }, id, !!fwdHost);

  await trackShareView(context, env, id, viaCommunity ? "community" : "article", shareOwner);
  return html(page(title, bodyHtml, og, cta), 200, true);
}

// ── 指令分享落地页（魔法数字）────────────────────────────────────────────────
// spec: voicedrop repo docs/superpowers/specs/2026-07-11-prompt-share-magic-number-design.md
// 「怎么用 / 怎么收藏」是这里的渲染期模板，不入存储、不进语音兑换的注入文本。
// `code` = 页面上展示/口播的 7 位分享码；社区帖入口传 promptCode（id 是 12 位帖
// id，只做规范链接），7 位码直接访问时两者相同。
async function promptSharePage(context, env, id, ptr, code = id) {
  const { request } = context;
  const label = String(promptPostTitle(ptr) || '分享提示词');
  const instruction = String(ptr.instruction || '');

  const fwdHost = request.headers?.get?.('x-forwarded-host');
  const origin = fwdHost ? `https://${fwdHost}` : new URL(request.url).origin;
  const og = { description: plainExcerpt(instruction, 120), url: fwdHost ? `${origin}/${id}` : request.url, image: '' };

  // 邀请归因 + 下载 CTA：与文章分享页同款（作者分享指令同样是引流）。
  // 同款反代规则：只在直连时服务端写指纹，反代流量走 ctaHtml 的第一方 beacon。
  const shareOwner = ptr.sub ? `users/${ptr.sub}/` : null;
  const visitorIP = request.headers?.get?.('CF-Connecting-IP');
  if (!fwdHost && shareOwner && visitorIP && env.SESSION_SECRET && context.waitUntil) {
    context.waitUntil(
      writeRefhit({ FILES: env.FILES }, visitorIP, env.SESSION_SECRET, shareOwner, id, Date.now())
        .catch(() => {}));
  }
  let rate = null, refCfg = null;
  try { const o = await env.FILES.get('config/mint-rate.json'); if (o) rate = JSON.parse(await o.text()); } catch {}
  try { const o = await env.FILES.get('config/referral.json'); if (o) refCfg = JSON.parse(await o.text()); } catch {}
  const cta = ctaHtml(rate, refCfg || { enabled: true, authorCoins: 12, newUserCoins: 6 }, id, !!fwdHost);

  const host = fwdHost || new URL(request.url).hostname;
  await trackShareView(context, env, id, "prompt", shareOwner, { 提示词码: code });
  return html(page(label, promptShareHtml(label, code, instruction, host), og, cta), 200, true);
}

// 「收进工具箱」按钮必须是 https universal link 才能拉起 App（voicedrop:// scheme 在
// 微信 webview 里被整个吞掉，点了没反应）。但 universal link 在同域页内点击不触发
// （Safari 规则，见 docs/superpowers/plans/2026-07-09-universal-links.md），所以指向
// 「对面」的 applinks 域名：voicedrop.cn 页 → jianshuo.dev/voicedrop/<码>，其余 →
// voicedrop.cn/<码>。装了 App 跨域点击直接进导入 sheet（AppRouter 两个域名的 7 位码
// 都认）；没装则落到对面域名的同一张分享页，不死链。
function importHref(code, host) {
  return /(^|\.)voicedrop\.cn$/i.test(host)
    ? `https://jianshuo.dev/voicedrop/${esc(code)}`
    : `https://voicedrop.cn/${esc(code)}`;
}

export function promptShareHtml(label, code, instruction, host = '') {
  const note = instruction.includes('{{')
    ? '<p class="muted" style="font-size:.85rem">花括号（如 {{LINE}}、{{QUOTE}}）是占位符，代表你操作时选中的那一行或那张图，AI 会自动对上。</p>'
    : '';
  return `<article>
<h1>${esc(label)}</h1>
<p class="muted">一条 VoiceDrop 提示词 · 分享码</p>
<div class="vd-code">${esc(code)}</div>
<div class="vd-prompt">${mdToHtml(instruction)}</div>
${note}
<a class="vd-import" href="${importHref(code, host)}">一键收进我的工具箱</a>
<p class="muted vd-import-note">装了 VoiceDrop 会直接打开导入页；还没装？<a href="${APP_STORE}">先下载</a>，回来再点一次。微信里点不动？点右上角 ⋯ 选「在 Safari 中打开」。</p>
<h2>怎么用</h2>
<ol>
<li>打开 VoiceDrop，进入任意一篇文章，<strong>长按屏幕按住说话</strong>，说：「用 ${esc(code)} 改这段」——AI 会按上面这条提示词干活。只管这一次，不会改动你自己的任何设置。</li>
<li>想长期用：打开 VoiceDrop 的 <strong>设置 → 提示词</strong>，选一个动作，把上面的提示词内容粘贴进「我的提示词」，以后长按菜单里随手可用。</li>
</ol>
</article>`;
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
    // Smart App Banner — Safari shows an「打开」ribbon that hands this SAME url to
    // the app. Universal links do NOT fire on same-domain taps inside the page, so
    // the banner is the only reliable web→app hop (e.g. after 微信 →「在 Safari 中打开」).
    `<meta name="apple-itunes-app" content="app-id=6781565141, app-argument=${u}"/>`,
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

function page(title, inner, og, extra = '') {
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
.vd-photo img{width:100%;height:auto;border-radius:12px;display:block}
.vd-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:2.4rem;font-weight:700;letter-spacing:.3em;text-align:center;margin:1.2rem 0 1.6rem;text-indent:.3em}
.vd-prompt{background:#f1efe9;border-radius:12px;padding:14px 16px;margin:0 0 1.05rem}
.vd-prompt p:last-child{margin-bottom:0}
.vd-import{display:block;text-align:center;background:#1d1d1f;color:#faf9f7;text-decoration:none;
  font-weight:650;border-radius:12px;padding:13px 16px;margin:0 0 .5rem}
.vd-import-note{text-align:center;font-size:.85rem;margin-bottom:1.4rem}
.muted{color:#86868b}
footer{margin-top:3rem;padding-top:1.2rem;border-top:1px solid #ececec;
  color:#a1a1a6;font-size:.82rem}
footer a{color:#86868b;text-decoration:none}
::selection{background:#ffe49b}
</style></head>
<body><div class="wrap">
${inner}
<footer>由 <a href="https://voicedrop.cn/">VoiceDrop</a> 口述生成${extra}</footer>
</div></body></html>`;
}

function html(body, status = 200, cache = false) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (cache) headers['Cache-Control'] = 'public, max-age=300';
  return new Response(body, { status, headers });
}
