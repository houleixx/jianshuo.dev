import { describe, it, expect, beforeEach } from "vitest";
import { callAnthropic, isGeoBlock, _resetGeoState } from "../src/anthropic.js";

// ── fakes ────────────────────────────────────────────────────────────────────
const GEO_BODY = JSON.stringify({ error: { type: "forbidden", message: "Request not allowed" } });
const OK_JSON = { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } };

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [pattern, resp] of routes) {
      if (String(url).includes(pattern)) return typeof resp === "function" ? resp() : resp;
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const resp = (status, body) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function fakeRelayEnv(result) {
  const state = { got: null, locationHint: null, instance: null };
  const env = {
    CLAUDE_API_KEY: "sk-env",
    RELAY: {
      idFromName: (n) => { state.instance = n; return `id:${n}`; },
      get: (_id, opts) => {
        state.locationHint = opts && opts.locationHint;
        return {
          fetch: async (url, init) => {
            const { apiKey, reqBody } = JSON.parse(init.body);
            state.got = { apiKey, reqBody, url: String(url) };
            if (result instanceof Error) throw result;
            return new Response(JSON.stringify(result), { status: 200 });
          },
        };
      },
    },
  };
  return { env, state };
}

beforeEach(() => _resetGeoState());

// ── isGeoBlock ───────────────────────────────────────────────────────────────
describe("isGeoBlock", () => {
  it("matches Anthropic's edge geo rejection only", () => {
    expect(isGeoBlock(403, GEO_BODY)).toBe(true);
    expect(isGeoBlock(403, "some other forbidden")).toBe(false);
    expect(isGeoBlock(429, GEO_BODY)).toBe(false);
    expect(isGeoBlock(0, "")).toBe(false);
  });
});

// ── callAnthropic ────────────────────────────────────────────────────────────
describe("callAnthropic", () => {
  it("direct success: returns json, never touches the relay", async () => {
    const { env, state } = fakeRelayEnv({ ok: true, status: 200, json: OK_JSON, errorText: "" });
    const fetchImpl = fakeFetch([["api.anthropic.com", () => resp(200, OK_JSON)]]);
    const r = await callAnthropic(env, { model: "m" }, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.via).toBe("direct");
    expect(r.json.content[0].text).toBe("hi");
    expect(state.got).toBe(null);
  });

  it("non-geo failure (500): returns the error, no relay retry", async () => {
    const { env, state } = fakeRelayEnv({ ok: true, status: 200, json: OK_JSON, errorText: "" });
    const fetchImpl = fakeFetch([["api.anthropic.com", () => resp(500, "boom")]]);
    const r = await callAnthropic(env, { model: "m" }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(state.got).toBe(null);
  });

  it("geo-403: replays the same request through the relay pinned to enam", async () => {
    const { env, state } = fakeRelayEnv({ ok: true, status: 200, json: OK_JSON, errorText: "" });
    const fetchImpl = fakeFetch([
      ["api.anthropic.com", () => resp(403, GEO_BODY)],
      ["cdn-cgi/trace", () => resp(200, "fl=1\ncolo=HKG\nip=1.2.3.4")],
    ]);
    const body = { model: "m", messages: [] };
    const r = await callAnthropic(env, body, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.via).toBe("relay");
    expect(r.colo).toBe("HKG");
    expect(state.got.reqBody).toEqual(body);
    expect(state.got.apiKey).toBe("sk-env");
    expect(state.locationHint).toBe("enam");
  });

  it("after a geo-403, the next call in this isolate goes relay-first", async () => {
    const { env } = fakeRelayEnv({ ok: true, status: 200, json: OK_JSON, errorText: "" });
    const fetchImpl = fakeFetch([
      ["api.anthropic.com", () => resp(403, GEO_BODY)],
      ["cdn-cgi/trace", () => resp(200, "colo=HKG")],
    ]);
    await callAnthropic(env, { model: "m" }, { fetchImpl });
    const directCalls = fetchImpl.calls.filter((c) => c.url.includes("api.anthropic.com")).length;
    const r2 = await callAnthropic(env, { model: "m" }, { fetchImpl });
    expect(r2.via).toBe("relay");
    // no additional direct attempt was made
    expect(fetchImpl.calls.filter((c) => c.url.includes("api.anthropic.com")).length).toBe(directCalls);
  });

  it("relay-first mode falls back to direct if the relay breaks", async () => {
    const { env } = fakeRelayEnv(new Error("relay down"));
    const fetchImpl = fakeFetch([
      ["api.anthropic.com", () => resp(200, OK_JSON)],
      ["cdn-cgi/trace", () => resp(200, "colo=HKG")],
    ]);
    // force relay-first mode via a geo-403 with a working relay first? Simpler:
    // first call hits geo-403 then relay throws → error result returned…
    const r1 = await callAnthropic(env, { model: "m" }, {
      fetchImpl: fakeFetch([
        ["api.anthropic.com", () => resp(403, GEO_BODY)],
        ["cdn-cgi/trace", () => resp(200, "colo=HKG")],
      ]),
    });
    expect(r1.ok).toBe(false);
    // …now in relay-first mode: relay throws, direct works → recovers
    const r2 = await callAnthropic(env, { model: "m" }, { fetchImpl });
    expect(r2.ok).toBe(true);
    expect(r2.via).toBe("direct");
  });

  it("geo-403 without a RELAY binding degrades to the plain error", async () => {
    const fetchImpl = fakeFetch([["api.anthropic.com", () => resp(403, GEO_BODY)]]);
    const r = await callAnthropic({ CLAUDE_API_KEY: "k" }, { model: "m" }, { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.via).toBe("direct");
  });

  it("uses an explicit apiKey over env.CLAUDE_API_KEY", async () => {
    const { env, state } = fakeRelayEnv({ ok: true, status: 200, json: OK_JSON, errorText: "" });
    const fetchImpl = fakeFetch([
      ["api.anthropic.com", () => resp(403, GEO_BODY)],
      ["cdn-cgi/trace", () => resp(200, "colo=HKG")],
    ]);
    await callAnthropic(env, { model: "m" }, { fetchImpl, apiKey: "sk-explicit" });
    expect(state.got.apiKey).toBe("sk-explicit");
  });
});
