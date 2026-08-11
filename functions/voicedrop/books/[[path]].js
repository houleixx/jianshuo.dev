// 公开书架：voicedrop.cn/books/<name> → R2 (bucket jianshuo-dev-files)。
//
// EdgeOne 边缘函数把非 /files|/agent|/reco 路径补 /voicedrop 前缀送到 Pages
// （infra/voicedrop-cn-edgeone/edge-function.js），所以这个函数同时服务：
//   https://voicedrop.cn/books/<name>            （干净路径，对外分享用这个）
//   https://jianshuo.dev/voicedrop/books/<name>  （同一函数的原始路径）
//
// 唯一数据源是写书 cloud agent 的 scope（users/<PUBLISHER>/books/）：agent 用
// 自己的用户 token 走 PUT /files/api/upload/books/<slug>/<file>，upload 路由把
// key 锁进调用者 scope，agent 拿不到也不该拿 FILES_TOKEN，所以公开路由迁就写端。
// key 钉死在该 scope 的 books/ 尾段下，桶里其他东西（articles/、WECHAT.json…）
// 够不着，所以不需要 photo 那样的文件类型白名单。
//
// GET /books/        → 书架索引：一本书一个「书封」（竖排题签 + 副题 + 印章，
//                      封面色按 slug 哈希稳定分配），书名取自 <slug>/index.html
//                      的 <title>，不平铺夹内文件。
// GET /books/<name>  → 文件本体，inline 展示；html/md/txt 只缓存 5 分钟（书会
//                      反复重发迭代），其余（pdf/图片等大文件）缓存一天。

const PUBLISHER = 'users/anon-ae209ac53499d51d513425503bd134b0/books/';

const TYPES = {
  pdf: 'application/pdf', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', zip: 'application/zip', cbz: 'application/vnd.comicbook+zip',
};
const SHORT_CACHE = new Set(['html', 'htm', 'md', 'txt']);

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }
  const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  let rel = decodeURIComponent(segments.join('/'));
  if (rel.includes('..') || rel.startsWith('/')) return notFound();

  // 索引页：/books 或 /books/
  if (!rel) return index(env);

  const fetchKey = (key) => (request.method === 'HEAD' ? env.FILES.head(key) : env.FILES.get(key));
  let obj = await fetchKey(PUBLISHER + rel);
  // 目录路径（/books/<slug> 或 /books/<slug>/，[[path]] 不保留尾斜杠）→ 补 index.html
  if (!obj && !rel.split('/').pop().includes('.')) {
    rel = rel.replace(/\/$/, '') + '/index.html';
    obj = await fetchKey(PUBLISHER + rel);
  }
  if (!obj) return notFound();

  const ext = (rel.split('.').pop() || '').toLowerCase();
  const leaf = rel.split('/').pop();
  return new Response(request.method === 'HEAD' ? null : obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || TYPES[ext] || 'application/octet-stream',
      'Content-Length': String(obj.size),
      // inline：PDF/图片/HTML 浏览器里直接打开；filename* 让「另存为」得到原名（含中文）。
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(leaf)}`,
      'Cache-Control': SHORT_CACHE.has(ext) ? 'public, max-age=300' : 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function notFound() {
  return new Response(JSON.stringify({ error: 'not found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function index(env) {
  // 一个 delimiter listing 拿书的文件夹（delimitedPrefixes）。必须 cursor 翻页：
  // R2 的 delimited list 按「扫过的 key 数」截断，不是按返回的前缀数
  // （admin/llm 页曾因此冻在 2026-07-13，同一个坑）。
  const slugs = [];
  let cursor;
  do {
    const listed = await env.FILES.list({ prefix: PUBLISHER, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : {}) });
    slugs.push(...(listed.delimitedPrefixes || []).map((p) => p.slice(PUBLISHER.length).replace(/\/$/, '')).filter(Boolean));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // 书名 = <slug>/index.html 的 <title>；没有 index.html 或没有 <title> 就退回 slug。
  const books = await Promise.all(slugs.map(async (slug) => {
    let title = slug;
    try {
      const obj = await env.FILES.get(`${PUBLISHER}${slug}/index.html`);
      if (obj) {
        const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(await obj.text());
        if (m && m[1].trim()) title = m[1].trim();
      }
    } catch {}
    return { slug, title };
  }));
  books.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 书封样式：竖排题签（主标题）+ 竖排小字副题 + 「建硕」印章，
  // 封面色从传统矿物色里按 slug 哈希稳定分配（同一本书永远同一个颜色）。
  const PALETTE = [
    ['#33506B', '#263D54'], ['#A04A38', '#7E3626'], ['#3D6B57', '#2C5342'],
    ['#5A4157', '#463043'], ['#40403C', '#2F2F2C'], ['#A67F42', '#8A6730'],
    ['#2E4159', '#223146'], ['#7A4A2E', '#603921'], ['#8A3A4A', '#6E2C39'],
    ['#5A6B3D', '#47552E'], ['#35597E', '#284664'],
  ];
  const colorOf = (slug) => {
    let h = 0;
    for (const ch of slug) h = (h * 31 + ch.codePointAt(0)) % 997;
    return PALETTE[h % PALETTE.length];
  };
  // 主副题拆分：在 ——／：／· 处断开，题签只放主题，副题竖排在封面右侧。
  const splitTitle = (t) => {
    for (const sep of ['——', '—', '：', ':', ' · ', '·']) {
      const i = t.indexOf(sep);
      if (i > 1) return [t.slice(0, i).trim(), t.slice(i + sep.length).trim()];
    }
    return [t.trim(), ''];
  };
  // 题签单列不换行，字号按主题长度分级，保证再长也不折列。
  const sizeClass = (n) => (n <= 5 ? 's5' : n <= 7 ? 's7' : n <= 9 ? 's9' : n <= 12 ? 's12' : 's99');

  const covers = books.map((b) => {
    const [main, sub] = splitTitle(b.title);
    const [c, c2] = colorOf(b.slug);
    return `<a class="book" href="/books/${encodeURI(b.slug)}/" style="--c:${c};--c2:${c2}" title="${esc(b.title)}">` +
      `<span class="slip"><span class="t ${sizeClass([...main].length)}">${esc(main)}</span></span>` +
      (sub ? `<span class="sub">${esc(sub)}</span>` : '') +
      `<span class="seal">建硕</span></a>`;
  }).join('\n');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>书架 · VoiceDrop</title>
<style>
  :root{--paper:#F6F1E6;--ink:#26221B;--muted:#8A8072;--slip:#F4EDDD;--slip-ink:#2A2520;--seal:#A63A2B}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);
    font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
    background-image:radial-gradient(rgba(38,34,27,.028) 1px,transparent 1px);background-size:22px 22px}
  main{max-width:960px;margin:0 auto;padding:44px 20px 72px}
  header{text-align:center;margin-bottom:40px}
  h1{font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",STSong,serif;
    font-size:34px;font-weight:900;letter-spacing:.55em;text-indent:.55em;margin:0}
  .count{color:var(--muted);font-size:12.5px;letter-spacing:.18em;margin-top:10px}
  .count::before,.count::after{content:"·";margin:0 .8em;opacity:.5}
  .shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:26px 20px}
  @media (min-width:700px){.shelf{grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:34px 26px}}
  .book{position:relative;display:block;aspect-ratio:105/148;
    background:linear-gradient(150deg,var(--c) 0%,var(--c2) 100%);
    border-radius:2px 7px 7px 2px;text-decoration:none;
    box-shadow:0 1px 2px rgba(38,34,27,.18),0 6px 16px rgba(38,34,27,.16);
    transition:transform .18s ease,box-shadow .18s ease;-webkit-tap-highlight-color:transparent}
  .book:hover{transform:translateY(-5px);
    box-shadow:0 2px 4px rgba(38,34,27,.16),0 14px 28px rgba(38,34,27,.22)}
  .book:focus-visible{outline:3px solid var(--seal);outline-offset:3px}
  @media (prefers-reduced-motion:reduce){.book{transition:none}.book:hover{transform:none}}
  .book::before{content:"";position:absolute;inset:0 auto 0 0;width:11px;border-radius:2px 0 0 2px;
    background:linear-gradient(90deg,rgba(0,0,0,.30),rgba(0,0,0,.10) 55%,rgba(255,255,255,.14) 88%,rgba(0,0,0,.12));
    pointer-events:none}
  .book::after{content:"";position:absolute;inset:0;border-radius:inherit;
    background:repeating-linear-gradient(0deg,rgba(255,255,255,.035) 0 1px,transparent 1px 3px),
               repeating-linear-gradient(90deg,rgba(0,0,0,.03) 0 1px,transparent 1px 3px);
    pointer-events:none}
  .slip{position:absolute;top:9px;left:17px;z-index:1;background:var(--slip);
    padding:12px 6px 14px;writing-mode:vertical-rl;max-height:76%;
    border-radius:1px;box-shadow:0 1px 2px rgba(0,0,0,.28)}
  .slip::after{content:"";position:absolute;inset:3px;border:1px solid rgba(42,37,32,.22)}
  .t{font-family:"Songti SC","Noto Serif SC","Source Han Serif SC",STSong,serif;
    font-weight:900;line-height:1;color:var(--slip-ink);display:block;
    white-space:nowrap;max-height:100%;overflow:hidden}
  .s5{font-size:20px;letter-spacing:.14em}
  .s7{font-size:16.5px;letter-spacing:.12em}
  .s9{font-size:14px;letter-spacing:.10em}
  .s12{font-size:12px;letter-spacing:.06em}
  .s99{font-size:10.5px;letter-spacing:.04em;white-space:normal}
  .sub{position:absolute;top:14px;right:9px;z-index:1;writing-mode:vertical-rl;
    max-height:62%;overflow:hidden;font-size:10.5px;line-height:1.35;
    letter-spacing:.12em;color:rgba(255,255,255,.72)}
  .seal{position:absolute;right:11px;bottom:11px;z-index:1;width:27px;height:27px;
    background:var(--seal);border-radius:3.5px;display:flex;align-items:center;justify-content:center;
    writing-mode:vertical-rl;font-family:"Songti SC","Noto Serif SC",STSong,serif;
    font-size:10.5px;line-height:1.15;letter-spacing:.05em;color:#F6F1E6;
    box-shadow:0 1px 2px rgba(0,0,0,.25);opacity:.95}
  .empty{color:var(--muted);text-align:center;margin-top:60px}
</style></head>
<body><main>
<header><h1>书架</h1><p class="count">VoiceDrop&nbsp;&nbsp;共 ${books.length} 册</p></header>
${books.length ? `<div class="shelf">${covers}</div>` : '<p class="empty">还没有书。</p>'}
</main></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
