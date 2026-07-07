// vi.mock is hoisted by vitest before static imports, so this prevents the real
// `agents` package (which imports cloudflare:email / cloudflare:workers) from
// ever being loaded — the same pattern used for any CF-only module in this suite.
import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import { handleRealtimeRoute } from "../src/realtime.js";
import { fakeFetch, fakeD1, usageSql } from "./fakes.js";
import { grantBucket } from "../src/usage_store.js";

// resolveScope("anon_unittesttoken_abcdefghijklmnop", {SESSION_SECRET:""}) 的真值
// （SESSION_SECRET 为空字符串时走 anonScopeFromToken：sha256hex(token).slice(0,32)）。
const ANON_SCOPE = "users/anon-bde826325758914dad844b24c3950a01/";

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
  it("OpenAI 200 但缺 client_secret → 502（不返回 200-with-nulls）", async () => {
    globalThis.fetch = fakeFetch({
      "POST https://api.openai.com/v1/realtime/client_secrets": () => ({ ok: true, status: 200, body: {} }),
    });
    const r = await handleRealtimeRoute(U("/agent/realtime/session"), req("/agent/realtime/session"), { SESSION_SECRET: "", OPENAI_API_KEY: "sk-test" });
    expect(r.status).toBe(502);
  });
  it("OpenAI 200 但 json() 解析失败 → 502", async () => {
    globalThis.fetch = fakeFetch({
      // body 用 getter 抛错：json() 惰性访问 r.body 时才触发，模拟解析失败
      "POST https://api.openai.com/v1/realtime/client_secrets": () => ({ ok: true, status: 200, get body() { throw new Error("bad json"); } }),
    });
    const r = await handleRealtimeRoute(U("/agent/realtime/session"), req("/agent/realtime/session"), { SESSION_SECRET: "", OPENAI_API_KEY: "sk-test" });
    expect(r.status).toBe(502);
  });
});

describe("POST /agent/realtime/usage", () => {
  it("按费率扣费：1M text_in = $4 → 扣 ceil(4*7.3*1e6) UY，余额下降", async () => {
    const db = fakeD1(usageSql());
    await grantBucket(db, ANON_SCOPE, 1_000_000_000, "test", null, Date.now());
    const env = { SESSION_SECRET: "", USAGE: db };
    const r = await handleRealtimeRoute(U("/agent/realtime/usage"),
      req("/agent/realtime/usage", { body: { session_id: "sess_abc", usage: { text_in: 1_000_000 } } }), env);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.charged_suanli).toBeGreaterThan(0);
  });
  it("余额不足也扣（允许为负）", async () => {
    const env = { SESSION_SECRET: "", USAGE: fakeD1(usageSql()) }; // 空账户
    const r = await handleRealtimeRoute(U("/agent/realtime/usage"),
      req("/agent/realtime/usage", { body: { usage: { audio_out: 2_000_000 } } }), env);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.balance_suanli).toBeLessThan(0); // 透支为负
  });
  it("坏 body → 400", async () => {
    const env = { SESSION_SECRET: "", USAGE: fakeD1(usageSql()) };
    const r = await handleRealtimeRoute(U("/agent/realtime/usage"), req("/agent/realtime/usage", { body: { nope: 1 } }), env);
    expect(r.status).toBe(400);
  });
  it("body.usage 是数组 → 400", async () => {
    const env = { SESSION_SECRET: "", USAGE: fakeD1(usageSql()) };
    const r = await handleRealtimeRoute(U("/agent/realtime/usage"), req("/agent/realtime/usage", { body: { usage: [] } }), env);
    expect(r.status).toBe(400);
  });
  it("无 USAGE 绑定 → 降级 200", async () => {
    const r = await handleRealtimeRoute(U("/agent/realtime/usage"), req("/agent/realtime/usage", { body: { usage: { text_in: 1 } } }), { SESSION_SECRET: "" });
    expect(r.status).toBe(200);
  });
});
