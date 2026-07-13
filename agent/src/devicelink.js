// Device-link pairing — pure logic (no Durable Object, no I/O except injected env.FILES).
// The LinkBroker DO and /agent/link/* routes in index.js are thin shells over these.
import { timingSafeEqual } from "../../functions/lib/auth.js";

export const CODE_TTL_MS = 120000; // 2 min
export const MAX_ATTEMPTS = 5;
export const MAX_MATCH = 10;

function defaultRandInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

// n distinct 4-digit zero-padded codes. randInt injectable for deterministic tests.
export function genDistinctCodes(n, randInt = defaultRandInt) {
  if (n > 10000) throw new Error("cannot make more than 10000 distinct 4-digit codes");
  const set = new Set();
  while (set.size < n) set.add(String(randInt(10000)).padStart(4, "0"));
  return [...set];
}

// StatusHub broadcast payload: explicit payload wins; else legacy status_update shape.
export function buildBroadcastMessage(body) {
  return body.payload ?? { type: "status_update", stem: body.stem, status: body.status };
}

// ── 待处理配对：StatusHub 存一份，让错过推送的手机还能捞回来 ──
// broadcast 是纯扇出、零缓冲；而 iOS 一进后台就断开 socket。两者相加，
// link_request 会永久丢失。存住它，连上来就补送、也能主动 GET。
// pubkey 必须一起存：手机放行时要用它把 token 封给新设备。

export function pendingRecord(msg, now, ttlMs = CODE_TTL_MS) {
  if (!msg || msg.type !== "link_request") return null;
  return { pairingId: msg.pairingId, code: msg.code, pubkey: msg.pubkey, exp: now + ttlMs };
}

// 还活着的待处理配对。payload 里可能带 released:true —— 表示新设备已经验过码、
// 服务端已经放行，只是当时手机不在线没接到 link_release。
export function livePending(rec, now) {
  if (!rec || !rec.exp || rec.exp <= now) return null;
  const { exp: _exp, ...payload } = rec;
  return { type: "link_request", ...payload };
}

// List objects under users/anon-<6hex> and dedup the distinct users/anon-<32hex>/ scopes.
// (Derived from object keys — works with both real R2 and the Map-backed test fake,
// and avoids depending on R2 list delimiter support.)
export async function resolveMatchingScopes(env, prefix, max = MAX_MATCH) {
  if (!/^[0-9a-fA-F]{6}$/.test(prefix || "")) return [];
  const p = prefix.toLowerCase();
  const { objects } = await env.FILES.list({ prefix: "users/anon-" + p });
  const scopes = new Set();
  for (const o of objects) {
    const m = o.key.match(/^(users\/anon-[0-9a-f]{32}\/)/);
    if (m) scopes.add(m[1]);
    if (scopes.size >= max) break;
  }
  return [...scopes];
}

export function createPairing({ pubkey, entries, now, ttlMs = CODE_TTL_MS }) {
  return { createdAt: now, ttlMs, attempts: 0, status: "pending", pubkey, entries, releasingScope: null, blob: null };
}

export function isExpired(s, now) {
  return now - s.createdAt > s.ttlMs;
}

export function verifyPairing(s, code, now) {
  if (isExpired(s, now)) return { state: { ...s, status: "expired" }, result: { ok: false, expired: true } };
  if (s.status !== "pending") return { state: s, result: { ok: false, dead: true } };
  const attempts = s.attempts + 1;
  const entry = s.entries.find((e) => timingSafeEqual(e.code, String(code)));
  if (!entry) {
    const dead = attempts >= MAX_ATTEMPTS;
    return {
      state: { ...s, attempts, status: dead ? "dead" : "pending" },
      result: { ok: false, remaining: Math.max(0, MAX_ATTEMPTS - attempts), dead },
    };
  }
  return {
    state: { ...s, attempts, status: "verified", releasingScope: entry.scope },
    result: { ok: true, scope: entry.scope },
  };
}

export function completePairing(s, callerScope, blob, now) {
  if (isExpired(s, now)) return { state: { ...s, status: "expired" }, result: { ok: false, expired: true } };
  if (s.status !== "verified") return { state: s, result: { ok: false, error: "not_verified" } };
  if (callerScope !== s.releasingScope) return { state: s, result: { ok: false, error: "forbidden" } };
  return { state: { ...s, status: "done", blob }, result: { ok: true } };
}
