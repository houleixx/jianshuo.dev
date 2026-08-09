// 公开书架：voicedrop.cn/books/<name> → R2 (bucket jianshuo-dev-files) 的 books/ 前缀。
//
// EdgeOne 边缘函数把非 /files|/agent|/reco 路径补 /voicedrop 前缀送到 Pages
// （infra/voicedrop-cn-edgeone/edge-function.js），所以这个函数同时服务：
//   https://voicedrop.cn/books/<name>            （干净路径，对外分享用这个）
//   https://jianshuo.dev/voicedrop/books/<name>  （同一函数的原始路径）
// 与 /files/api/photo/ 同款「公开只读直出 R2」，但 key 被钉死在 books/ 前缀下，
// 桶里其他任何东西（users/、shares/、WECHAT.json…）都够不着，所以不需要
// photo 那样的文件类型白名单。写入只有 admin 能做：
//   PUT /files/api/upload/books/<name>   （Bearer FILES_TOKEN，name 仅限 ASCII）
//   npx wrangler r2 object put jianshuo-dev-files/books/<name> --file <本地文件> --remote
//
// GET /books/        → 简单的 HTML 索引页（列出全部文件，可直接点开）
// GET /books/<name>  → 文件本体，inline 展示（PDF 浏览器直接打开），边缘/浏览器可缓存

const TYPES = {
  pdf: 'application/pdf', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', zip: 'application/zip', cbz: 'application/vnd.comicbook+zip',
};

export async function onRequest({ request, env, params }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }
  const segments = Array.isArray(params.path) ? params.path : (params.path ? [params.path] : []);
  const rel = decodeURIComponent(segments.join('/'));
  if (rel.includes('..') || rel.startsWith('/')) return notFound();

  // 索引页：/books 或 /books/
  if (!rel) return index(env);

  const key = 'books/' + rel;
  const obj = request.method === 'HEAD' ? await env.FILES.head(key) : await env.FILES.get(key);
  if (!obj) return notFound();

  const ext = (rel.split('.').pop() || '').toLowerCase();
  const leaf = rel.split('/').pop();
  return new Response(request.method === 'HEAD' ? null : obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || TYPES[ext] || 'application/octet-stream',
      'Content-Length': String(obj.size),
      // inline：PDF/图片浏览器里直接打开；filename* 让「另存为」得到原名（含中文）。
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(leaf)}`,
      // 书会被覆盖式更新（同名重传），所以只缓存一天，不像照片那样 immutable 一年。
      'Cache-Control': 'public, max-age=86400',
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
  const files = [];
  let cursor;
  do {
    const listed = await env.FILES.list({ prefix: 'books/', limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of listed.objects) {
      const name = o.key.slice('books/'.length);
      if (name && !name.endsWith('/')) files.push({ name, size: o.size, uploaded: o.uploaded });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));

  const fmtSize = (n) => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = files.map((f) =>
    `<li><a href="/books/${encodeURI(f.name)}">${esc(f.name)}</a><span>${fmtSize(f.size)}</span></li>`).join('\n');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Books</title>
<style>
  body{margin:0;background:#fff;color:#1a1a1a;font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  main{max-width:640px;margin:0 auto;padding:40px 20px}
  h1{font-size:22px;margin:0 0 20px}
  ul{list-style:none;margin:0;padding:0}
  li{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid #eee}
  a{color:#0a58ca;text-decoration:none;word-break:break-all}
  a:hover{text-decoration:underline}
  span{color:#999;font-size:13px;white-space:nowrap}
  p.empty{color:#999}
</style></head>
<body><main><h1>📚 Books</h1>
${files.length ? `<ul>${rows}</ul>` : '<p class="empty">还没有文件。</p>'}
</main></body></html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}
