import { describe, it, expect, beforeEach } from "vitest";
import { handleRealtimeSession, isOpenAIGeoBlock, probeOpenAI, _resetRealtimeGeoState } from "../src/realtime.js";
import { RealtimeRelay } from "../src/relay.js";

// WS 成功路径（WebSocketPair/双向转发）无法在 vitest/Node 跑，靠线上验证；这里测
// 的是 fallback 决策：直连 403 → 转发进 ENAM 中继 DO、非 geo 错误不转发、
// relay-first 记忆、无绑定时的退化。

// ── fakes ────────────────────────────────────────────────────────────────────
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url instanceof Request ? url.url : url));
    for (const [pattern, resp] of routes) {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes(pattern)) return typeof resp === "function" ? resp() : resp;
    }
    throw new Error(`unrouted fetch: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const resp = (status, body = "") => new Response(body, { status });

// RT_RELAY 命名空间 fake：记录 locationHint 与转发进 DO 的请求；result 可以是
// 假 WS 响应（{webSocket:{},status:101} 直接透传）、普通 Response 或 Error。
function fakeRtRelayEnv(result) {
  const state = { locationHint: null, forwarded: null, uniqueIds: 0 };
  const env = {
    OPENAI_API_KEY: "sk-test",
    RT_RELAY: {
      newUniqueId: () => `uid-${++state.uniqueIds}`,
      get: (_id, opts) => {
        state.locationHint = opts && opts.locationHint;
        return {
          fetch: async (req) => {
            state.forwarded = req;
            if (result instanceof Error) throw result;
            return result;
          },
        };
      },
    },
  };
  return { env, state };
}

const wsUpgradeRequest = () =>
  new Request("https://jianshuo.dev/agent/realtime/relay?fmt=pcmu", { headers: { Upgrade: "websocket" } });

const fakeWsResponse = () => ({ webSocket: {}, status: 101 });

beforeEach(() => _resetRealtimeGeoState());

// ── isOpenAIGeoBlock ─────────────────────────────────────────────────────────
describe("isOpenAIGeoBlock", () => {
  it("403 就是地区封锁信号（合法 key 的 upgrade 只会因此 403）", () => {
    expect(isOpenAIGeoBlock(403)).toBe(true);
    expect(isOpenAIGeoBlock(401)).toBe(false);
    expect(isOpenAIGeoBlock(502)).toBe(false);
    expect(isOpenAIGeoBlock(0)).toBe(false);
  });
});

// ── handleRealtimeSession ────────────────────────────────────────────────────
describe("handleRealtimeSession", () => {
  it("直连 403（HKG 被封）→ 同一请求转发进钉 enam 的中继 DO，scope 带在查询参数上", async () => {
    const { env, state } = fakeRtRelayEnv(fakeWsResponse());
    const fetchImpl = fakeFetch([
      ["api.openai.com", () => resp(403, "unsupported_country_region_territory")],
      ["cdn-cgi/trace", () => resp(200, "colo=HKG")],
    ]);
    const r = await handleRealtimeSession(wsUpgradeRequest(), env, "user:42", null, fetchImpl);
    expect(r.status).toBe(101);
    expect(state.locationHint).toBe("enam");
    const fwd = new URL(state.forwarded.url);
    expect(fwd.searchParams.get("scope")).toBe("user:42");
    expect(fwd.searchParams.get("fmt")).toBe("pcmu"); // 原查询参数保留
    expect(state.forwarded.headers.get("Upgrade")).toBe("websocket");
  });

  it("非 geo 失败（401/502）原样返回，不碰中继", async () => {
    const { env, state } = fakeRtRelayEnv(fakeWsResponse());
    const r = await handleRealtimeSession(wsUpgradeRequest(), env, "s", null,
      fakeFetch([["api.openai.com", () => resp(401, "bad key")]]));
    expect(r.status).toBe(401);
    expect(state.forwarded).toBe(null);
  });

  it("吃过一次 geo-403 后，本 isolate 下一条连接直接 relay-first（不再直连）", async () => {
    const { env, state } = fakeRtRelayEnv(fakeWsResponse());
    const fetchImpl = fakeFetch([
      ["api.openai.com", () => resp(403)],
      ["cdn-cgi/trace", () => resp(200, "colo=HKG")],
    ]);
    await handleRealtimeSession(wsUpgradeRequest(), env, "s", null, fetchImpl);
    const directCalls = fetchImpl.calls.filter((u) => u.includes("api.openai.com")).length;
    const r2 = await handleRealtimeSession(wsUpgradeRequest(), env, "s", null, fetchImpl);
    expect(r2.status).toBe(101);
    expect(state.uniqueIds).toBe(2); // 每条连接一个独立 DO 实例
    expect(fetchImpl.calls.filter((u) => u.includes("api.openai.com")).length).toBe(directCalls);
  });

  it("relay-first 模式下中继挂掉 → 退回直连兜底；直连也失败则返回中继的错误", async () => {
    // 先用好中继吃一个 403 进入 relay-first
    const good = fakeRtRelayEnv(fakeWsResponse());
    await handleRealtimeSession(wsUpgradeRequest(), good.env, "s", null,
      fakeFetch([["api.openai.com", () => resp(403)], ["cdn-cgi/trace", () => resp(200, "colo=HKG")]]));
    // 中继炸了、直连仍 403 → 拿到的是中继错误（502），且确实又试过直连
    const broken = fakeRtRelayEnv(new Error("relay down"));
    const fetchImpl = fakeFetch([["api.openai.com", () => resp(403)]]);
    const r = await handleRealtimeSession(wsUpgradeRequest(), broken.env, "s", null, fetchImpl);
    expect(r.status).toBe(502);
    expect(fetchImpl.calls.some((u) => u.includes("api.openai.com"))).toBe(true);
  });

  it("没有 RT_RELAY 绑定：geo-403 退化成原样错误（老行为）", async () => {
    const r = await handleRealtimeSession(wsUpgradeRequest(), { OPENAI_API_KEY: "sk" }, "s", null,
      fakeFetch([["api.openai.com", () => resp(403, "blocked")]]));
    expect(r.status).toBe(403);
  });

  it("没配 OPENAI_API_KEY → 503，不转中继", async () => {
    const { env, state } = fakeRtRelayEnv(fakeWsResponse());
    delete env.OPENAI_API_KEY;
    const r = await handleRealtimeSession(wsUpgradeRequest(), env, "s", null, fakeFetch([]));
    expect(r.status).toBe(503);
    expect(state.forwarded).toBe(null);
  });
});

// ── probeOpenAI ──────────────────────────────────────────────────────────────
describe("probeOpenAI", () => {
  it("带 key 打 /v1/models，回 {ok,status}", async () => {
    const fetchImpl = fakeFetch([["api.openai.com/v1/models", () => resp(200, "{}")]]);
    expect(await probeOpenAI({ OPENAI_API_KEY: "sk" }, fetchImpl)).toEqual({ ok: true, status: 200, errorText: undefined });
  });
  it("被封时把 403 和 body 带出来", async () => {
    const fetchImpl = fakeFetch([["api.openai.com/v1/models", () => resp(403, "unsupported_country")]]);
    const r = await probeOpenAI({ OPENAI_API_KEY: "sk" }, fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.errorText).toMatch(/unsupported/);
  });
  it("无 key 不出网", async () => {
    expect((await probeOpenAI({}, fakeFetch([]))).ok).toBe(false);
  });
});

// ── RealtimeRelay DO ─────────────────────────────────────────────────────────
describe("RealtimeRelay", () => {
  it("非 WS、非已知路径 → 404；缺 scope 的 WS 转发 → 400", async () => {
    const relay = new RealtimeRelay({}, {});
    expect((await relay.fetch(new Request("https://relay/nope"))).status).toBe(404);
    const noScope = new Request("https://relay/agent/realtime/relay", { headers: { Upgrade: "websocket" } });
    expect((await relay.fetch(noScope)).status).toBe(400);
  });
});
