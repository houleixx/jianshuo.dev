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
