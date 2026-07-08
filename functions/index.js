// voicedrop.cn 根路径 → VoiceDrop 落地页（/voicedrop/ 静态页）。
// 其它域名（jianshuo.dev）不受影响，放行到原静态首页。
export async function onRequest(context) {
  const host = context.request.headers?.get?.("x-forwarded-host") || new URL(context.request.url).hostname;
  if (host === "voicedrop.cn" || host === "www.voicedrop.cn") {
    return Response.redirect(`https://${host}/voicedrop/`, 302);
  }
  return context.next();
}
