// Anthropic Messages caller with a geo-block fallback.
//
// api.anthropic.com rejects requests whose egress IP sits in an unsupported
// region with 403 {"error":{"type":"forbidden","message":"Request not allowed"}}
// in a few milliseconds. Durable Objects egress from whatever Cloudflare colo
// they were placed in — users connecting from mainland China often get their
// per-article DO placed in HKG, which Anthropic blocks, so EVERY LLM call from
// that DO fails while the same code in NRT/US colos works (llmlogs
// 2026-06-27…07-03 show 100+ such 403s across 7+ anon users).
//
// Fix: detect that exact rejection and replay the request through the
// AnthropicRelay Durable Object (relay.js), pinned via locationHint to ENAM
// (US East), where Anthropic allows traffic. Direct stays the primary path so
// healthy colos pay zero extra latency; once an isolate sees a geo-403 it goes
// relay-first for later calls — the block is per-colo and isolates never move.

const GEO_BLOCK_RE = /request not allowed/i;
export const RELAY_INSTANCE = "enam-v1"; // bump to force the relay DO to re-place
export const RELAY_LOCATION_HINT = "enam";

let preferRelay = false; // per-isolate: a geo-403 means THIS colo is blocked

export function isGeoBlock(status, bodyText) {
  return status === 403 && GEO_BLOCK_RE.test(bodyText || "");
}

// The bare HTTP call, shared by the direct path here and by the relay DO.
// Returns {ok, status, json, errorText} and never throws.
export async function anthropicFetch(apiKey, reqBody, fetchImpl = fetch) {
  try {
    const resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
      return { ok: false, status: resp.status, json: null, errorText: (await resp.text()).slice(0, 2000) };
    }
    return { ok: true, status: resp.status, json: await resp.json(), errorText: "" };
  } catch (e) {
    return { ok: false, status: 0, json: null, errorText: String((e && e.message) || e) };
  }
}

async function relayCall(env, apiKey, reqBody) {
  try {
    const stub = env.RELAY.get(env.RELAY.idFromName(RELAY_INSTANCE), { locationHint: RELAY_LOCATION_HINT });
    const resp = await stub.fetch("https://relay/messages", {
      method: "POST",
      body: JSON.stringify({ apiKey, reqBody }),
    });
    const r = await resp.json();
    return { ...r, via: "relay" };
  } catch (e) {
    return { ok: false, status: 0, json: null, errorText: `relay: ${String((e && e.message) || e)}`, via: "relay" };
  }
}

// Which colo is this isolate in? cdn-cgi/trace answers from the local colo.
// Failure-path only, so healthy calls never pay for it.
async function currentColo(fetchImpl) {
  try {
    const t = await (await fetchImpl("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(2000) })).text();
    return (t.match(/^colo=(\w+)/m) || [])[1] || "";
  } catch {
    return "";
  }
}

// Drop-in replacement for the scattered raw fetches: returns
// {ok, status, json, errorText, via, colo?} and never throws.
export async function callAnthropic(env, reqBody, { apiKey, fetchImpl = fetch } = {}) {
  const key = apiKey || env.CLAUDE_API_KEY;

  if (preferRelay && env.RELAY) {
    // This isolate already hit the geo block — skip the doomed direct attempt.
    // If the relay itself breaks, direct is a harmless backup (worst case
    // another instant 403); a direct success flips us back to direct-first.
    const relayed = await relayCall(env, key, reqBody);
    if (relayed.ok) return relayed;
    const direct = await anthropicFetch(key, reqBody, fetchImpl);
    if (direct.ok) {
      preferRelay = false;
      return { ...direct, via: "direct" };
    }
    return relayed;
  }

  const direct = await anthropicFetch(key, reqBody, fetchImpl);
  if (!(env.RELAY && isGeoBlock(direct.status, direct.errorText))) {
    return { ...direct, via: "direct" };
  }
  preferRelay = true;
  const colo = await currentColo(fetchImpl); // hard evidence for llmlogs
  const relayed = await relayCall(env, key, reqBody);
  return { ...relayed, colo };
}

// Test hook: geo state is per-isolate module state.
export function _resetGeoState() {
  preferRelay = false;
}
