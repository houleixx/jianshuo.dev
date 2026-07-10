// Serve the VoiceDrop Android APK from R2.
//
// URL:  GET/HEAD https://jianshuo.dev/voicedrop/apk/VoiceDrop.apk
// R2:   bucket jianshuo-dev-files, key "apk/VoiceDrop.apk"
//
// APK 太大放不进 Pages 静态资源（单文件 25MiB 上限），走 R2 流式输出——
// 与 functions/setup/machine-setup.tar.gz.js 同一模式。发布新包零部署：
//   npx wrangler r2 object put jianshuo-dev-files/apk/VoiceDrop.apk --file=<path> --remote
// 下载页 /voicedrop/apk/ 用 HEAD 探测本路由决定显示下载按钮还是「打包中」。

const KEY = "apk/VoiceDrop.apk";

export async function onRequest({ request, env }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }

  const head = await env.FILES.head(KEY);
  if (!head) return new Response("APK not available yet", { status: 404 });

  const headers = new Headers({
    "content-type": "application/vnd.android.package-archive",
    "content-disposition": 'attachment; filename="VoiceDrop.apk"',
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "last-modified": head.uploaded.toUTCString(),
    etag: head.httpEtag,
    "x-robots-tag": "noindex",
  });

  if (request.method === "HEAD") {
    headers.set("content-length", String(head.size));
    return new Response(null, { headers });
  }

  // 单段 Range 支持：手机网络断点续传靠它
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
  if (m && (m[1] || m[2])) {
    let offset, length;
    if (m[1]) {
      offset = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), head.size - 1) : head.size - 1;
      if (offset >= head.size || offset > end) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${head.size}` } });
      }
      length = end - offset + 1;
    } else {
      // 后缀形式 bytes=-N：取末尾 N 字节
      length = Math.min(parseInt(m[2], 10), head.size);
      offset = head.size - length;
    }
    const obj = await env.FILES.get(KEY, { range: { offset, length } });
    if (!obj) return new Response("APK not available yet", { status: 404 });
    headers.set("content-length", String(length));
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${head.size}`);
    return new Response(obj.body, { status: 206, headers });
  }

  const obj = await env.FILES.get(KEY);
  if (!obj) return new Response("APK not available yet", { status: 404 });
  headers.set("content-length", String(head.size));
  return new Response(obj.body, { headers });
}
