// functions/lib/posthog.js — 服务端直发 PostHog 事件（漏斗打点）。
//
// - key = iOS 同一 project 的 phc_ 客户端写入 key（可公开设计），env.POSTHOG_API_KEY
//   缺失 = 整体不打点（与 iOS Analytics 同纪律：不配置不启用，主路径零影响）。
// - 隐私红线（与 iOS 埋点同一条）：只送元数据，绝不送用户内容；IP 只以
//   refhits 同款 HMAC 截断哈希（ipHash）出现，不存明文。
// - best-effort：失败只 console，绝不 throw。调用方自己决定 waitUntil 还是 await。
export function phCapture(env, event, distinctId, properties = {}) {
  const key = env && env.POSTHOG_API_KEY;
  if (!key || !event || !distinctId) return Promise.resolve();
  return fetch("https://us.i.posthog.com/capture/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key, event, distinct_id: String(distinctId),
      properties: { ...properties, $lib: "voicedrop-server" },
      timestamp: new Date().toISOString(),
    }),
  }).then((r) => { if (!r.ok) console.log("[posthog] capture", event, r.status); })
    .catch((e) => console.log("[posthog] capture failed", String(e?.message || e)));
}
