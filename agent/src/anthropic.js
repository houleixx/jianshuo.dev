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
//
// 永远 stream:true：非流式时 Anthropic 门口的 Cloudflare 约 100 秒等不到响应
// 字节就掐线（HTTP 524）——超长录音挖矿生成超 2 分钟必死（2026-07-09 事故：
// 2h12m 录音 156 个 pass 全灭）。流式后首 token 几秒即达、字节持续流动，连接
// 不会被掐。SSE 在这里聚合回非流式的响应形状，所有调用方零改动。
// 裸请求（永远 stream:true），直连路径与 relay DO 共用。
export function anthropicRequest(apiKey, reqBody, fetchImpl = fetch) {
  return fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...reqBody, stream: true }),
  });
}

export async function anthropicFetch(apiKey, reqBody, fetchImpl = fetch, onEvent = null) {
  try {
    const resp = await anthropicRequest(apiKey, reqBody, fetchImpl);
    if (!resp.ok) {
      return { ok: false, status: resp.status, json: null, errorText: (await resp.text()).slice(0, 2000) };
    }
    const ct = (resp.headers && resp.headers.get && resp.headers.get("content-type")) || "";
    // 非 SSE（测试 fake / 中间代理剥流）或无 body 流 → 按老路径直接解析 JSON。
    const json = ct.includes("event-stream") && resp.body ? await aggregateSse(resp, onEvent) : await resp.json();
    return { ok: true, status: resp.status, json, errorText: "" };
  } catch (e) {
    return { ok: false, status: 0, json: null, errorText: String((e && e.message) || e) };
  }
}

// 把 Messages API 的 SSE 事件流聚合回非流式响应对象。流中途的 error 事件
// throw —— 外层 catch 转成 {ok:false,status:0}，调用方按网络错误重试。
export async function aggregateSse(resp, onEvent = null) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let base = null;                 // message_start 的 message 骨架
  const blocks = [];               // index → content block
  const partialJson = new Map();   // index → tool_use 未拼完的 input JSON 串

  const handle = (ev) => {
    switch (ev.type) {
      case "message_start":
        base = ev.message || {};
        break;
      case "content_block_start":
        blocks[ev.index] = { ...(ev.content_block || {}) };
        break;
      case "content_block_delta": {
        const b = blocks[ev.index] || (blocks[ev.index] = {});
        const d = ev.delta || {};
        if (d.type === "text_delta") b.text = (b.text || "") + (d.text || "");
        else if (d.type === "input_json_delta") partialJson.set(ev.index, (partialJson.get(ev.index) || "") + (d.partial_json || ""));
        else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + (d.thinking || "");
        else if (d.type === "signature_delta") b.signature = (b.signature || "") + (d.signature || "");
        break;
      }
      case "content_block_stop": {
        const j = partialJson.get(ev.index);
        if (j !== undefined) {
          try { blocks[ev.index].input = JSON.parse(j || "{}"); } catch { /* 留 content_block_start 里的 input */ }
          partialJson.delete(ev.index);
        }
        break;
      }
      case "message_delta":
        if (base) {
          Object.assign(base, ev.delta || {});
          base.usage = { ...(base.usage || {}), ...(ev.usage || {}) };
        }
        break;
      case "error":
        throw new Error(`Anthropic stream ${ev.error?.type || "error"}: ${ev.error?.message || ""}`);
      default: // ping / message_stop / 未来新事件：跳过
        break;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        handle(ev);
        // 实时预览钩子：best-effort，回调炸了不影响聚合。
        if (onEvent) { try { onEvent(ev); } catch (_) {} }
      }
    }
  }
  if (!base) throw new Error("Anthropic stream ended without message_start");
  base.content = blocks.filter(Boolean);
  return base;
}

async function relayCall(env, apiKey, reqBody, onEvent = null) {
  try {
    const stub = env.RELAY.get(env.RELAY.idFromName(RELAY_INSTANCE), { locationHint: RELAY_LOCATION_HINT });
    const resp = await stub.fetch("https://relay/messages", {
      method: "POST",
      body: JSON.stringify({ apiKey, reqBody }),
    });
    // 新 relay 把 Anthropic 的 SSE 原样管回来 → 在这里聚合（实时预览的增量也在这
    // 一路拿到）；HTTP 错误/旧版 relay 仍是 JSON 形状,照旧解析。
    const ct = (resp.headers && resp.headers.get && resp.headers.get("content-type")) || "";
    if (ct.includes("event-stream") && resp.body) {
      const json = await aggregateSse(resp, onEvent);
      return { ok: true, status: 200, json, errorText: "", via: "relay" };
    }
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
export async function callAnthropic(env, reqBody, { apiKey, fetchImpl = fetch, onEvent = null } = {}) {
  const key = apiKey || env.CLAUDE_API_KEY;

  if (preferRelay && env.RELAY) {
    // This isolate already hit the geo block — skip the doomed direct attempt.
    // If the relay itself breaks, direct is a harmless backup (worst case
    // another instant 403); a direct success flips us back to direct-first.
    const relayed = await relayCall(env, key, reqBody, onEvent);
    if (relayed.ok) return relayed;
    const direct = await anthropicFetch(key, reqBody, fetchImpl, onEvent);
    if (direct.ok) {
      preferRelay = false;
      return { ...direct, via: "direct" };
    }
    return relayed;
  }

  const direct = await anthropicFetch(key, reqBody, fetchImpl, onEvent);
  if (!(env.RELAY && isGeoBlock(direct.status, direct.errorText))) {
    return { ...direct, via: "direct" };
  }
  preferRelay = true;
  const colo = await currentColo(fetchImpl); // hard evidence for llmlogs
  const relayed = await relayCall(env, key, reqBody, onEvent);
  return { ...relayed, colo };
}

// Test hook: geo state is per-isolate module state.
export function _resetGeoState() {
  preferRelay = false;
}
