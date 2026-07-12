// AnthropicRelay: a Durable Object whose only job is to fetch
// api.anthropic.com from a colo Anthropic accepts. Created with
// locationHint "enam" (see anthropic.js), so its egress IP is US-based even
// when the caller's DO sits in a blocked colo (HKG etc.). Stateless — one
// well-known instance shared by all users; bump RELAY_INSTANCE to re-place it.
// Plain class + fetch interface (same idiom as StatusHub/LinkBroker) so this
// module stays importable outside workerd (vitest).
import { anthropicRequest } from "./anthropic.js";

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
