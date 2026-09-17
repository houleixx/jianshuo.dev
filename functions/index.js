// voicedrop.cn 根路径 → VoiceDrop 落地页（/voicedrop/ 静态页）。
// Pages may register an additional VoiceDrop host through VOICEDROP_PUBLIC_HOST.
// Other domains (jianshuo.dev) retain their original static homepage.
export async function onRequest(context) {
  const host = context.request.headers?.get?.("x-forwarded-host") || new URL(context.request.url).hostname;
  if (host === "voicedrop.cn" || host === "www.voicedrop.cn" || host === context.env?.VOICEDROP_PUBLIC_HOST) {
    const query = new URL(context.request.url).search;
    return Response.redirect(`https://${host}/voicedrop/${query}`, 302);
  }
  return context.next();
}
