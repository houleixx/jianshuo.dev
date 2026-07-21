// src/push.js — APNs 推送（HTTP/2 API 直连，ES256 JWT 用 WebCrypto 签）。
// 用途：①「文章挖好了」通知用户 ②运维报警（4xx/5xx 风暴）推给管理员。
// 设备 token 由 iOS 端存到 R2 `users/<sub>/push-token.json`（{token, env, updatedAt}）。
// secrets：APNS_KEY_P8（.p8 全文）/ APNS_KEY_ID / APNS_TEAM_ID；缺任一则静默降级为 no-op。
import { coreGetPushToken, coreDeletePushToken } from "../../functions/lib/core-db.js";

const APNS_TOPIC = "com.wangjianshuo.VoiceDrop";

// JWT 缓存（APNs 要求 20~60 分钟内复用，太频繁签发会被拒）。isolate 生命周期内有效。
let jwtCache = { token: null, exp: 0, keyId: null };

function pemToPkcs8(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function apnsJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  if (jwtCache.token && jwtCache.exp > now + 300 && jwtCache.keyId === env.APNS_KEY_ID) return jwtCache.token;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(env.APNS_KEY_P8), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID })));
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })));
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`));
  const token = `${header}.${payload}.${b64url(sig)}`;
  jwtCache = { token, exp: now + 2400, keyId: env.APNS_KEY_ID };   // 40 分钟后换新
  return token;
}

/// 给某个用户 scope（"users/<sub>/"）推一条通知。尽力而为：任何失败只 console.log,
/// 绝不向上抛（推送永远不该影响主流程）。410/BadDeviceToken 时清掉失效 token。
// 每条路径都要说话 —— 成功、每种静默早退、每种失败。
// 2026-07-13 被这个函数坑过一次：推送没到，但它成功时不打日志、几条早退也不打
// 日志，于是完全无法从日志区分「压根没发」和「发了但手机没显示」，只能靠猜。
// 一个投递路径不该是黑盒。
export async function sendPush(env, scope, { title, body, threadId, link }) {
  try {
    if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.FILES) {
      console.log("[push] skip: APNs 未配置（secrets 或 FILES 绑定缺失）", scope);
      return false;
    }
    // 存储迁移 P3：D1 push_tokens 优先，缺行/不可用落回 R2 push-token.json。
    let reg = await coreGetPushToken(env, scope);
    if (reg === null || reg === false) {
      const obj = await env.FILES.get(`${scope}push-token.json`);
      if (!obj) {
        console.log("[push] skip: 该用户没有 push token（D1/R2 均无）", scope);
        return false;
      }
      reg = JSON.parse(await obj.text());
    }
    if (!reg?.token) {
      console.log("[push] skip: push token 里没有 token 字段", scope);
      return false;
    }
    const host = reg.env === "dev" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    console.log(`[push] → ${host} env=${reg.env} title=${title}`, scope);
    const resp = await fetch(`https://${host}/3/device/${reg.token}`, {
      method: "POST",
      headers: {
        "authorization": `bearer ${await apnsJwt(env)}`,
        "apns-topic": APNS_TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
      // link = voicedrop:// 深链（如 voicedrop://article/<stem>），app 点按通知时路由过去。
      body: JSON.stringify({
        aps: { alert: { title, body }, sound: "default", "thread-id": threadId || "voicedrop" },
        ...(link ? { link } : {}),
      }),
    });
    if (resp.status === 410) {
      // 双删（R2 对象 + D1 行）。
      await env.FILES.delete(`${scope}push-token.json`).catch(() => {});
      await coreDeletePushToken(env, scope);
      console.log("[push] token gone (410), removed", scope);
      return false;
    }
    if (!resp.ok) {
      console.log("[push] apns 拒收", resp.status, (await resp.text()).slice(0, 200), scope);
      return false;
    }
    // APNs 收下了 ≠ 手机会显示（用户可能关了通知、开了专注模式）。这条日志只证明
    // 「服务端确实发出去了」，把「没发」和「发了没显示」彻底分开。
    console.log(`[push] apns 已受理 ${resp.status} apns-id=${resp.headers.get("apns-id") || "?"}`, scope);
    return true;
  } catch (e) {
    console.log("[push] error", String(e?.message || e).slice(0, 200));
    return false;
  }
}

/// 运维报警（节流版）：把一条「重要失败」推给管理员（env.ADMIN_SCOPE），但同一
/// ruleKey 在 windowMs 内只推一次——失败往往成串（如重连风暴），不节流会把管理员
/// 手机轰炸成灾。节流 marker 存 R2（ops/alerts/<ruleKey>.json，{at}），因为报警可能
/// 从一次性的中继 DO 里发出（DO storage 用完即弃，跨会话去重靠 R2 这个共享真源）。
/// 尽力而为：任何失败只 console.log，绝不向上抛。返回是否真的推了一条。
export async function alertAdminThrottled(env, ruleKey, windowMs, { title, body, link } = {}, push = sendPush) {
  try {
    if (!env.ADMIN_SCOPE) { console.log("[alert] skip: 无 ADMIN_SCOPE", ruleKey); return false; }
    const markKey = `ops/alerts/${ruleKey}.json`;
    if (env.FILES) {
      const prev = await env.FILES.get(markKey).catch(() => null);
      if (prev) {
        let at = 0;
        try { at = Number(JSON.parse(await prev.text())?.at) || 0; } catch (_) {}
        if (Date.now() - at < windowMs) { console.log(`[alert] throttled ${ruleKey} (${Math.round((Date.now() - at) / 1000)}s ago)`); return false; }
      }
      // 先落 marker 再推：并发关闭最坏多推一条，但绝不会漏记时间戳导致持续刷屏。
      await env.FILES.put(markKey, JSON.stringify({ at: Date.now() })).catch(() => {});
    }
    console.log(`[alert] → admin ${ruleKey}: ${title}`);
    return await push(env, env.ADMIN_SCOPE, { title, body, threadId: "ops-alert", link });
  } catch (e) {
    console.log("[alert] error", String(e?.message || e).slice(0, 200));
    return false;
  }
}
