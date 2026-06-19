// 实时反代 github.com 上的下载（release 资产 / 源码包 / raw 文件）。
// 给访问不了 github.com 的网络环境用：客户端只需要能连 jianshuo.dev，
// GitHub 由 Cloudflare 边缘代取，并自动跟随 302——release 资产会跳到
// objects.githubusercontent.com，fetch 默认 follow，对客户端透明。
// 边缘缓存 5 分钟，挡住重复请求；GitHub 偶发抖动时也有兜底。
//
// 用法：把任意 github.com 下载链接里的前缀 https://github.com/ 换成
//   https://jianshuo.dev/gh/
// 例：
//   https://github.com/jianshuo/bdpan-finder/releases/latest/download/BdpanFinder.dmg
//   → https://jianshuo.dev/gh/jianshuo/bdpan-finder/releases/latest/download/BdpanFinder.dmg
//   https://github.com/jianshuo/bdpan-finder/releases/download/v0.1.14/BdpanFinder-v0.1.14.dmg
//   → https://jianshuo.dev/gh/jianshuo/bdpan-finder/releases/download/v0.1.14/BdpanFinder-v0.1.14.dmg
// raw 文件也行：github.com/<o>/<r>/raw/<branch>/<path> 会自动跳到 raw.githubusercontent.com。
// 源码包也行：github.com/<o>/<r>/archive/refs/heads/main.tar.gz。
//
// 安全：host 永远写死成 github.com，路径里塞别的域名也只会被当成 github.com 下的路径，
// 不会变成开放代理（无 SSRF 面）。

const fail = (msg, status = 400) =>
  new Response(msg + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export async function onRequest({ params, request }) {
  const segs = Array.isArray(params.path) ? params.path : [params.path];
  const rest = segs.filter(Boolean).join('/');
  if (!rest) {
    return fail('usage: /gh/<owner>/<repo>/releases/download/<tag>/<asset>  （任意 github.com 下载链接，去掉 https://github.com/ 前缀即可）');
  }

  // host 写死 github.com；查询串透传。
  const target = new URL('https://github.com/' + rest);
  const inUrl = new URL(request.url);
  if (inUrl.search) target.search = inUrl.search;

  // 透传 Range / If-Range，让大文件（DMG 等）可断点续传。
  const fwd = { 'user-agent': 'jianshuo-dev-gh-proxy' };
  const range = request.headers.get('range');
  if (range) fwd['range'] = range;
  const ifRange = request.headers.get('if-range');
  if (ifRange) fwd['if-range'] = ifRange;

  const upstream = await fetch(target.toString(), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    redirect: 'follow',
    headers: fwd,
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  // 200（完整）和 206（部分内容，断点续传）都算成功。
  if (!upstream.ok && upstream.status !== 206) {
    return fail(`upstream ${upstream.status} for ${target}`, upstream.status === 404 ? 404 : 502);
  }

  // 复制有用的响应头；二进制下载缺 disposition 时补一个 attachment，浏览器直接存盘。
  const headers = new Headers();
  for (const k of ['content-type', 'content-length', 'content-disposition', 'content-range', 'last-modified', 'etag', 'accept-ranges']) {
    const v = upstream.headers.get(k);
    if (v) headers.set(k, v);
  }
  if (!headers.has('content-disposition')) {
    const name = decodeURIComponent(target.pathname.split('/').pop() || 'download');
    headers.set('content-disposition', `attachment; filename="${name}"`);
  }
  headers.set('cache-control', 'public, max-age=300');
  headers.set('access-control-allow-origin', '*');

  return new Response(upstream.body, { status: upstream.status, headers });
}
