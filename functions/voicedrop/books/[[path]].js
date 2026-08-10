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
// GET /books/        → 书架索引：一行一本书（= 一个 <slug>/ 文件夹），显示书名
//                      （取自 <slug>/index.html 的 <title>），不平铺夹内文件。
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
  const rows = books.map((b) =>
    `<li><a href="/books/${encodeURI(b.slug)}/index.html">${esc(b.title)}</a></li>`).join('\n');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Books</title>
<style>
  body{margin:0;background:#fff;color:#1a1a1a;font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  main{max-width:640px;margin:0 auto;padding:40px 20px}
  h1{font-size:22px;margin:0 0 20px}
  ul{list-style:none;margin:0;padding:0}
  li{padding:12px 0;border-bottom:1px solid #eee}
  a{color:#0a58ca;text-decoration:none;word-break:break-all}
  a:hover{text-decoration:underline}
  p.empty{color:#999}
</style></head>
<body><main><h1>📚 Books</h1>
${books.length ? `<ul>${rows}</ul>` : '<p class="empty">还没有书。</p>'}
</main></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
