// vi.mock is hoisted by vitest before static imports, so this prevents the real
// `agents` package (which imports cloudflare:email / cloudflare:workers) from
// ever being loaded — the same pattern used for any CF-only module in this suite.
import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { handleRealtimeRoute } from "../src/realtime.js";
import { fakeFetch } from "./fakes.js";

const TOK = "anon_unittesttoken_abcdefghijklmnop";
const req = (path, { method = "POST", token = TOK, body } = {}) =>
  new Request("https://jianshuo.dev" + path, {
    method,
    headers: { ...(token ? { Authorization: "Bearer " + token } : {}), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
const U = (p) => new URL("https://jianshuo.dev" + p);
const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe("POST /agent/realtime/session", () => {
  it("mint：用 OPENAI_API_KEY 调 client_secrets 并透传凭证", async () => {
    globalThis.fetch = fakeFetch({
      "POST https://api.openai.com/v1/realtime/client_secrets": () =>
        ({ ok: true, status: 200, body: { id: "sess_abc", client_secret: { value: "ek_xyz", expires_at: 1234 }, expires_at: 1234 } }),
    });
    const env = { SESSION_SECRET: "", OPENAI_API_KEY: "sk-test" };
    const r = await handleRealtimeRoute(U("/agent/realtime/session"), req("/agent/realtime/session"), env);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.session_id).toBe("sess_abc");
    expect(j.client_secret).toBeTruthy();
    // 断言确实带了 Bearer OPENAI_API_KEY
    const call = globalThis.fetch.calls.find((c) => c.url.includes("/realtime/client_secrets"));
    expect(call.headers.Authorization).toBe("Bearer sk-test");
  });
  it("无 token → 401", async () => {
    const r = await handleRealtimeRoute(U("/agent/realtime/session"), req("/agent/realtime/session", { token: null }), { SESSION_SECRET: "" });
    expect(r.status).toBe(401);
  });
  it("没配 OPENAI_API_KEY → 503", async () => {
    const r = await handleRealtimeRoute(U("/agent/realtime/session"), req("/agent/realtime/session"), { SESSION_SECRET: "" });
    expect(r.status).toBe(503);
  });
  it("OpenAI 失败 → 502", async () => {
    globalThis.fetch = fakeFetch({ "POST https://api.openai.com/v1/realtime/client_secrets": () => ({ ok: false, status: 500, body: {} }) });
    const r = await handleRealtimeRoute(U("/agent/realtime/session"), req("/agent/realtime/session"), { SESSION_SECRET: "", OPENAI_API_KEY: "sk-test" });
    expect(r.status).toBe(502);
  });
  it("非 realtime 前缀 → null", async () => {
    expect(await handleRealtimeRoute(U("/agent/other"), req("/agent/other"), {})).toBeNull();
  });
});
