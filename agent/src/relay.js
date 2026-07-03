// AnthropicRelay: a Durable Object whose only job is to fetch
// api.anthropic.com from a colo Anthropic accepts. Created with
// locationHint "enam" (see anthropic.js), so its egress IP is US-based even
// when the caller's DO sits in a blocked colo (HKG etc.). Stateless — one
// well-known instance shared by all users; bump RELAY_INSTANCE to re-place it.
// Plain class + fetch interface (same idiom as StatusHub/LinkBroker) so this
// module stays importable outside workerd (vitest).
import { anthropicFetch } from "./anthropic.js";

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
      return Response.json(await anthropicFetch(apiKey, reqBody));
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
