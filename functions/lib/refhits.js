// functions/lib/refhits.js — 落地页访问的 IP 指纹记录（邀请归因第 2 层）。
// 存 D1 refhits 表（voicedrop-core），worker cron 2 天过期清理（coreCleanupRefhits）。
// 不存明文 IP（HMAC 后截断）。
// 查询语义「宁漏不错」：24h 窗口内该 IP 只见过一个 owner 才算命中，
// 多 owner（CGNAT/办公网）或零命中一律 null，由上层落到下一归因层。
import { hmacSign } from "./auth.js";
import { coreWriteRefhit, coreRefhitRows } from "./core-db.js";

const DAY_MS = 86400000;

// ⚠️ 调试开关（2026-07-17 建硕拍板）：归因排查期间指纹直接用明文 IP，方便肉眼
// 对账「访问 IP vs claim IP」。确认 IP 层归因没问题后翻回 false 恢复 HMAC 截断
// 哈希（隐私红线）。翻回时明文旧记录靠 2 天过期清理自清；切换瞬间新旧 key 不
// 互认，最多 24h 内的既有访问会归因不上，可接受。
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
  await coreWriteRefhit(env, h, ts, owner, token);
}

// 24h 窗口内该 IP 访问过的分享页：owner 唯一 → {owner, token}；0 个或多个 → null。
// D1 一条 SELECT；不可用（null）按零命中处理——宁漏不错，落到下一归因层。
export async function lookupRefhit(env, ip, secret, now) {
  if (!ip || !secret) return null;
  const h = await ipHash(ip, secret);
  const rows = await coreRefhitRows(env, h, now - DAY_MS);
  if (!rows || !rows.length) return null;
  const owners = new Map();
  for (const rec of rows) {
    if (!rec.owner || rec.ts > now + 60000) continue;
    const prev = owners.get(rec.owner);
    if (!prev || rec.ts > prev.ts) owners.set(rec.owner, rec);
  }
  if (owners.size !== 1) return null;
  const rec = owners.values().next().value;
  return { owner: rec.owner, token: rec.token || null };
}
