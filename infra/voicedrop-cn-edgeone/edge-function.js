// voicedrop.cn EdgeOne 边缘函数 —— 替代 infra/voicedrop-cn 的 Caddy 反代。
// 触发规则:voicedrop.cn / www.voicedrop.cn 全部路径(/*)。
//
// 与 Caddyfile 的逐条对应:
//   redir /voicedrop* 301              → 下方两个 301(去前缀,对外只暴露干净路径)
//   handle /files/* 透传               → path.startsWith('/files/'):不改路径
//   handle { rewrite /voicedrop{path} }→ 其余路径补 /voicedrop 前缀
//   header_up X-Forwarded-Host         → headers.set('X-Forwarded-Host', hostname)
//   header_up X-Real-IP                → 无需手工设置:EO 回源默认追加
//                                        EO-Connecting-IP 与 X-Forwarded-For
//                                        (腾讯云文档 product/1552/87654),
//                                        Pages 侧打点代码读 XFF 首段,语义一致。
//
// 刻意「不」照搬的一条:Caddyfile 把 /files/api/photo|asset 302 到 jianshuo.dev
// ——那是 VPS 回源 CF 只有 ~60KB/s 的权宜之计。EO 用国内边缘缓存直接替代它:
// 这两个前缀在 EO 缓存规则里配「缓存 + 遵循源站 Cache-Control」(源站对缺失
// 照片显式发 no-cache,见 functions/files/api/[[path]].js),图片字节走边缘节点。
// 若缓存出问题想临时退回旧行为,把 FALLBACK_REDIRECT_PHOTOS 改 true 重新部署。

const FALLBACK_REDIRECT_PHOTOS = false;

addEventListener('fetch', (event) => {
  event.respondWith(handle(event.request));
});

async function handle(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 旧形态 → 干净形态(301,URL 栏里不再出现 /voicedrop)。
  // 客户端会拿干净 URL 重新请求,第二轮走下面的路径映射。
  if (path === '/voicedrop' || path === '/voicedrop/') {
    return Response.redirect(url.origin + '/' + url.search, 301);
  }
  if (path.startsWith('/voicedrop/')) {
    return Response.redirect(url.origin + path.slice('/voicedrop'.length) + url.search, 301);
  }

  // 临时退回 Caddy 时代的 302 行为(见文件头注释)。
  if (
    FALLBACK_REDIRECT_PHOTOS &&
    (path.startsWith('/files/api/photo/') || path.startsWith('/files/api/asset/'))
  ) {
    return Response.redirect('https://jianshuo.dev' + path + url.search, 302);
  }

  // 路径映射:/files/* 原样透传;其余补 /voicedrop 前缀(/ → /voicedrop/)。
  // /favicon.ico、/.well-known/*、/<分享id> 都靠这条落到 Pages 的正确位置,
  // 与 Caddy 时代行为一致。
  const upstreamPath = path.startsWith('/files/') ? path : '/voicedrop' + path;

  // 同域名 fetch → 走 EO 缓存 + 回源流程(源站在 EO 控制台配成
  // jianshuo-dev.pages.dev,回源 HOST 同名)。EO 缓存键按客户端 URL 计算,
  // 此处改写路径不影响缓存键。
  const upstream = new URL(upstreamPath + url.search, url.origin);

  const headers = new Headers(request.headers);
  // Pages 侧 functions/[token].js / voicedrop/[token].js 靠这个头识别
  // voicedrop.cn(host 路由 / og 标签 / 根路径短链劫持)——全链路最关键的一行。
  headers.set('X-Forwarded-Host', url.hostname);

  const upstreamReq = new Request(upstream, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    // 源站 3xx(如 Pages 尾斜杠跳转)原样回给客户端,不在边缘跟随——
    // 与 Caddy 透传语义一致,也避免跨域 Location 被边缘抓回改变行为。
    redirect: 'manual',
  });

  return fetch(upstreamReq);
}
