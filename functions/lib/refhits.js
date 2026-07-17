// functions/lib/refhits.js — 落地页访问的 IP 指纹记录（邀请归因第 2 层）。
// 键 refhits/<ipHash>/<ts>，值 {owner, token, ts}。不存明文 IP（HMAC 后截断）。
// R2 lifecycle 对 refhits/ 前缀设 2 天过期（部署清单里用 wrangler 配，代码不管）。
// 查询语义「宁漏不错」：24h 窗口内该 IP 只见过一个 owner 才算命中，
// 多 owner（CGNAT/办公网）或零命中一律 null，由上层落到下一归因层。
import { hmacSign } from "./auth.js";

const DAY_MS = 86400000;

// ⚠️ 调试开关（2026-07-17 建硕拍板）：归因排查期间指纹直接用明文 IP，方便在
// R2 / PostHog 里肉眼对账「访问 IP vs claim IP」。确认 IP 层归因没问题后翻回
// false 恢复 HMAC 截断哈希（隐私红线）。翻回时明文旧记录靠 R2 2 天过期自清；
// 切换瞬间新旧 key 不互认，最多 24h 内的既有访问会归因不上，可接受。
export const DEBUG_PLAINTEXT_IP = true;

export async function ipHash(ip, secret) {
  if (DEBUG_PLAINTEXT_IP) return String(ip || "");
  return (await hmacSign(String(ip || ""), secret)).slice(0, 16);
}

export async function writeRefhit(env, ip, secret, owner, token, ts) {
  if (!ip || !secret || !owner) return;
  // 测试 owner 不写指纹——TESTOG 这类测试页会把真实访客的 IP 变成「多 owner」，
  // 反而屏蔽他们的 hello 归因（2026-07-17 实锤：自测手机因此被拦，靠剪贴板兜底）。
  if (String(owner).startsWith("users/test-")) return;
  const h = await ipHash(ip, secret);
  await env.FILES.put(`refhits/${h}/${ts}`, JSON.stringify({ owner, token, ts }));
}

// 24h 窗口内该 IP 访问过的分享页：owner 唯一 → {owner, token}；0 个或多个 → null。
export async function lookupRefhit(env, ip, secret, now) {
  if (!ip || !secret) return null;
  const h = await ipHash(ip, secret);
  const listed = await env.FILES.list({ prefix: `refhits/${h}/` });
  const owners = new Map(); // owner → latest {owner, token, ts}
  for (const o of listed.objects || []) {
    const ts = parseInt(o.key.slice(o.key.lastIndexOf("/") + 1), 10);
    if (!Number.isFinite(ts) || now - ts > DAY_MS || ts > now + 60000) continue;
    const obj = await env.FILES.get(o.key);
    if (!obj) continue;
    let rec; try { rec = JSON.parse(await obj.text()); } catch { continue; }
    if (!rec || !rec.owner) continue;
    const prev = owners.get(rec.owner);
    if (!prev || rec.ts > prev.ts) owners.set(rec.owner, rec);
  }
  if (owners.size !== 1) return null;
  const rec = owners.values().next().value;
  return { owner: rec.owner, token: rec.token || null };
}
