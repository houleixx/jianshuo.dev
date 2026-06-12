// 实时反代 GitHub 上 machine-setup 仓库的 main 分支 tar 包（不含 git 历史）。
// setup.sh 单文件自举时从这里拉全套安装文件，见 machine-setup 仓库 README。
// 注意：GitHub tar 包顶层目录是 machine-setup-main/，
// 消费端要用 tar --strip-components=1（setup.sh 已处理）。

const UPSTREAM = 'https://codeload.github.com/jianshuo/machine-setup/tar.gz/refs/heads/main';

export async function onRequest() {
  const res = await fetch(UPSTREAM, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) {
    return new Response(`upstream error: ${res.status}\n`, { status: 502 });
  }
  return new Response(res.body, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': 'attachment; filename="machine-setup.tar.gz"',
      'cache-control': 'public, max-age=300',
    },
  });
}
