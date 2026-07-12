// AnthropicRelay: a Durable Object whose only job is to fetch
// api.anthropic.com from a colo Anthropic accepts. Created with
// locationHint "enam" (see anthropic.js), so its egress IP is US-based even
// when the caller's DO sits in a blocked colo (HKG etc.). Stateless — one
// well-known instance shared by all users; bump RELAY_INSTANCE to re-place it.
// Plain class + fetch interface (same idiom as StatusHub/LinkBroker) so this
// module stays importable outside workerd (vitest).
import { anthropicRequest } from "./anthropic.js";
import { proxyRealtimeWebSocket, probeOpenAI } from "./realtime.js";

export class AnthropicRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /messages {apiKey, reqBody} → same {ok,status,json,errorText} shape
    // as the direct path. The key never leaves Cloudflare (DO-to-DO call).
    if (url.pathname === "/messages") {
      const { apiKey, reqBody } = await request.json().catch(() => ({}));
      if (!apiKey || !reqBody) return Response.json({ ok: false, status: 0, json: null, errorText: "relay: bad request" });
      // SSE 原样透传：聚合放回调用方做,这样实时预览的增量在中转路径也活着
      // (Phase 3)。HTTP 错误保持老 JSON 形状;网络异常也是(status 0)。
      try {
        const resp = await anthropicRequest(apiKey, reqBody);
        if (!resp.ok) {
          return Response.json({ ok: false, status: resp.status, json: null, errorText: (await resp.text()).slice(0, 2000) });
        }
        return new Response(resp.body, {
          status: 200,
          headers: { "content-type": resp.headers.get("content-type") || "text/event-stream" },
        });
      } catch (e) {
        return Response.json({ ok: false, status: 0, json: null, errorText: `relay: ${String((e && e.message) || e)}` });
      }
    }

    // GET /colo → where did this relay actually land? (locationHint is
    // best-effort; /agent/llm-health surfaces this for ops.)
    if (url.pathname === "/colo") {
      try {
        const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
        return Response.json({ colo: (t.match(/^colo=(\w+)/m) || [])[1] || "" });
      } catch {
        return Response.json({ colo: "" });
      }
    }

    return new Response("not found", { status: 404 });
  }
}

// RealtimeRelay: the same idea for the Realtime 采访员 —— api.openai.com also
// geo-blocks by egress IP (HKG etc.), which kills the interview WS entirely
// when the worker isolate sits in a blocked colo. handleRealtimeSession
// (realtime.js) forwards the client's WS upgrade here; each session gets its
// own instance (newUniqueId + locationHint "enam") so audio frames from
// concurrent interviews never funnel through one event loop. Stateless.

export class RealtimeRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // 转发来的 WS upgrade：认证已在 worker 做完，scope 由查询参数带入（这条
    // fetch 只能来自 worker 的 DO stub，外网打不进 DO）。计费逻辑原样在 DO 里
    // 跑；DO 的 waitUntil 语义与 worker ctx 不同（对象存活到 promise 落定），
    // 用一个 shim 兜住即可。
    if (request.headers.get("Upgrade") === "websocket") {
      const scope = url.searchParams.get("scope") || "";
      if (!scope) return new Response("relay: missing scope", { status: 400 });
      const ctx = { waitUntil: (p) => { try { this.state.waitUntil(p); } catch (_) { Promise.resolve(p).catch(() => {}); } } };
      return proxyRealtimeWebSocket(request, this.env, scope, ctx);
    }

    // GET /probe → 本 DO 所在 colo 能不能到 api.openai.com（/agent/llm-health 用）。
    if (url.pathname === "/probe") {
      return Response.json(await probeOpenAI(this.env));
    }

    // GET /colo → locationHint 是 best-effort，实际落点在这查。
    if (url.pathname === "/colo") {
      try {
        const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
        return Response.json({ colo: (t.match(/^colo=(\w+)/m) || [])[1] || "" });
      } catch {
        return Response.json({ colo: "" });
      }
    }

    return new Response("not found", { status: 404 });
  }
}
