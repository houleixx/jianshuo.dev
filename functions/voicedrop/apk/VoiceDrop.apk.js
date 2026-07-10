// VoiceDrop 安卓 APK 下载：解析 GitHub 最新 Release 后 302 到同域 /gh/ 代理。
//
// URL:  GET/HEAD https://jianshuo.dev/voicedrop/apk/VoiceDrop.apk
//   → 302 /gh/houleixx/voicedrop-android/releases/download/<tag>/<asset>
//   → functions/gh/[[path]].js 从 github.com 实时代取（流式 + Range 续传）
//
// 不走 R2、不用上传：houleixx/voicedrop-android 发新 Release 后本端点自动指向新版。
// 用户全程只见 jianshuo.dev 域名（302 是同域相对路径），国内不需要能连 github.com。
// GitHub API 解析结果边缘缓存 10 分钟（unauth 限流 60/h/IP，必须缓存）；
// API 失败时回退到写死的 FALLBACK 版本，保证下载永远可用。

const OWNER_REPO = "houleixx/voicedrop-android";
const FALLBACK = "/gh/houleixx/voicedrop-android/releases/download/v0.6.0/voicedrop-0.6.0.apk";
const CACHE_KEY = "https://jianshuo.dev/__internal/vd-apk-latest";
const CACHE_SECS = 600;

async function resolveLatestPath() {
  const cache = caches.default;
  const cached = await cache.match(CACHE_KEY);
  if (cached) return (await cached.text()) || FALLBACK;

  let path = FALLBACK;
  try {
    const r = await fetch(`https://api.github.com/repos/${OWNER_REPO}/releases/latest`, {
      headers: { "user-agent": "jianshuo-dev-apk-resolver", accept: "application/vnd.github+json" },
    });
    if (r.ok) {
      const rel = await r.json();
      const apk = (rel.assets || []).find((a) => a.name && a.name.endsWith(".apk"));
      if (apk && rel.tag_name) {
        path = `/gh/${OWNER_REPO}/releases/download/${encodeURIComponent(rel.tag_name)}/${encodeURIComponent(apk.name)}`;
      }
    }
  } catch (_) {
    // API 不可达 → 用 FALLBACK，且不写缓存，下次再试
    return path;
  }
  await cache.put(
    CACHE_KEY,
    new Response(path, { headers: { "cache-control": `public, max-age=${CACHE_SECS}` } })
  );
  return path;
}

export async function onRequest({ request }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const path = await resolveLatestPath();
  return new Response(null, {
    status: 302,
    headers: {
      location: path,
      "cache-control": "no-cache",
      "x-robots-tag": "noindex",
    },
  });
}
