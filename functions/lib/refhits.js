// functions/lib/refhits.js — 落地页访问的 IP 指纹记录（邀请归因第 2 层）。
// 键 refhits/<ipHash>/<ts>，值 {owner, token, ts}。不存明文 IP（HMAC 后截断）。
// R2 lifecycle 对 refhits/ 前缀设 2 天过期（部署清单里用 wrangler 配，代码不管）。
// 查询语义「宁漏不错」：24h 窗口内该 IP 只见过一个 owner 才算命中，
// 多 owner（CGNAT/办公网）或零命中一律 null，由上层落到下一归因层。
import { hmacSign } from "./auth.js";

const DAY_MS = 86400000;

export async function ipHash(ip, secret) {
  return (await hmacSign(String(ip || ""), secret)).slice(0, 16);
}

export async function writeRefhit(env, ip, secret, owner, token, ts) {
  if (!ip || !secret || !owner) return;
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
