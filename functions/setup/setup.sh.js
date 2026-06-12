// 实时反代 GitHub 上 machine-setup 的 setup.sh（main 分支 HEAD）。
// 给访问不了 github.com 的网络环境用：客户端只需要能连 jianshuo.dev，
// GitHub 由 Cloudflare 边缘代取。push 到 GitHub 即生效，无需任何同步步骤。
// 边缘缓存 5 分钟，挡住重复请求，GitHub 偶发抖动时也有兜底。

const UPSTREAM = 'https://raw.githubusercontent.com/jianshuo/machine-setup/main/setup.sh';

export async function onRequest() {
  const res = await fetch(UPSTREAM, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) {
    return new Response(`upstream error: ${res.status}\n`, { status: 502 });
  }
  return new Response(res.body, {
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
}
