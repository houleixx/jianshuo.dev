import { describe, it, expect } from "vitest";
import { pendingRecord, livePending, CODE_TTL_MS } from "../src/devicelink.js";
import { StatusHub } from "../src/status-hub.js";

// 背景（2026-07-13 真机上暴露出来的）：
// StatusHub 的 broadcast 是纯扇出、零缓冲——没人连着的时候消息直接丢掉、永不重放。
// 手机一进后台就 disconnect()，于是 link_request 永久丢失：用户就算 5 秒后打开
// App，那个 4 位码也再不会出现，配对只能干等过期。
//
// 更糟的是 link_release：iOS 侧的 release() 里 `guard let p = pending` —— 配对
// 状态只在内存里，App 重启/后台错过 link_request/用户划走弹窗，pending 就是 nil，
// link_release 被静默丢弃（不 POST、不报错、不提示）。服务端干等超时。
//
// 修法：StatusHub 把待处理的 link_request 存住（与配对同寿），
//   ① 任何 socket 连上来就补送 → 手机不会再错过
//   ② 另开 GET /agent/link/pending，手机随时能主动捞回来 → 不必客户端持久化

const NOW = 1_800_000_000_000;
const REQ = { type: "link_request", pairingId: "a".repeat(32), code: "7391", pubkey: "PUB" };

describe("pendingRecord —— 只存 link_request，且带过期时间", () => {
  it("从 link_request 造出待存记录，过期时间 = 配对的 TTL", () => {
    expect(pendingRecord(REQ, NOW)).toEqual({
      pairingId: REQ.pairingId, code: "7391", pubkey: "PUB", exp: NOW + CODE_TTL_MS,
    });
  });

  it("别的消息类型一律不存（挖矿状态推送不该被当成配对）", () => {
    expect(pendingRecord({ type: "status_update", stem: "s1" }, NOW)).toBeNull();
    expect(pendingRecord({ type: "link_release", pairingId: "x" }, NOW)).toBeNull();
    expect(pendingRecord(null, NOW)).toBeNull();
  });
});

describe("livePending —— 过期的不再交出去", () => {
  it("没过期 → 还原成一条完整的 link_request（exp 不外泄）", () => {
    const rec = pendingRecord(REQ, NOW);

    expect(livePending(rec, NOW + 1000)).toEqual(REQ);
  });

  it("刚好到点 → 视为过期", () => {
    const rec = pendingRecord(REQ, NOW);

    expect(livePending(rec, NOW + CODE_TTL_MS)).toBeNull();
  });

  it("过期了 → null（别让手机拿着死配对的码去试）", () => {
    const rec = pendingRecord(REQ, NOW);

    expect(livePending(rec, NOW + CODE_TTL_MS + 1)).toBeNull();
  });

  it("没有记录 → null", () => {
    expect(livePending(null, NOW)).toBeNull();
    expect(livePending(undefined, NOW)).toBeNull();
  });
});

// ── StatusHub 的行为（用一个最小的假 DO state）──

function fakeState() {
  const store = new Map();
  const sockets = [];
  return {
    sockets,
    storage: {
      async get(k) { return store.get(k); },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
    },
    acceptWebSocket(ws) { sockets.push(ws); },
    getWebSockets() { return sockets; },
  };
}

const fakeWs = () => { const sent = []; return { sent, send: (m) => sent.push(JSON.parse(m)), close() {} }; };

// WebSocketPair 在 vitest 里没有，最小补一个。
globalThis.WebSocketPair = globalThis.WebSocketPair ?? function () {
  const server = fakeWs();
  return { 0: { __client: true }, 1: server };
};

const post = (path, body) =>
  new Request(`https://status-hub${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

// WS 分支要回 101，但 Node 的 Response 只允许 200–599（Workers 才允许 101）。
// 补送的 send() 发生在构造那个 Response 之前，所以吞掉这个纯环境差异，
// 照常断言 socket 收到了什么。
async function connectWs(hub) {
  try {
    await hub.fetch(new Request("https://status-hub/", { headers: { Upgrade: "websocket" } }));
  } catch (e) {
    if (!/status/.test(String(e))) throw e; // 别把真错误也吞了
  }
}

describe("StatusHub：待处理的 link_request 要存住", () => {
  it("broadcast 一条 link_request → 存下来", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});

    await hub.fetch(post("/broadcast", { payload: REQ }));

    const rec = await state.storage.get("pendingLink");
    expect(rec.pairingId).toBe(REQ.pairingId);
    expect(rec.code).toBe("7391");
    expect(rec.pubkey).toBe("PUB"); // pubkey 必须存 —— 手机放行时要用它封 token
  });

  it("broadcast 挖矿状态 → 不动 pendingLink（别把无关消息当配对）", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});

    await hub.fetch(post("/broadcast", { stem: "s1", status: "ready" }));

    expect(await state.storage.get("pendingLink")).toBeUndefined();
  });

  it("broadcast 照常扇出给已连接的 socket（原有行为不能坏）", async () => {
    const state = fakeState();
    const ws = fakeWs();
    state.sockets.push(ws);
    const hub = new StatusHub(state, {});

    await hub.fetch(post("/broadcast", { payload: REQ }));

    expect(ws.sent[0]).toMatchObject({ type: "link_request", code: "7391" });
  });
});

describe("StatusHub：新 socket 连上来，补送错过的 link_request", () => {
  it("手机重连 → 立刻收到还活着的 link_request（这就是后台丢消息的解药）", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ })); // 此时没人连着，消息本会丢掉

    await connectWs(hub);

    expect(state.sockets.at(-1).sent[0]).toMatchObject({ type: "link_request", code: "7391", pubkey: "PUB" });
  });

  it("没有待处理配对 → 连上来什么都不推", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});

    await connectWs(hub);

    expect(state.sockets.at(-1).sent).toHaveLength(0);
  });

  it("配对已过期 → 连上来不推，且把死记录清掉", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await state.storage.put("pendingLink", { ...REQ, exp: Date.now() - 1 });

    await connectWs(hub);

    expect(state.sockets.at(-1).sent).toHaveLength(0);
    expect(await state.storage.get("pendingLink")).toBeUndefined();
  });
});

describe("StatusHub：GET /pending —— 手机主动捞", () => {
  it("有活的配对 → 连 pubkey 一起给（手机靠它封 token，不必自己持久化）", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ }));

    const resp = await hub.fetch(new Request("https://status-hub/pending"));

    expect(await resp.json()).toMatchObject({ pairingId: REQ.pairingId, code: "7391", pubkey: "PUB" });
  });

  it("没有配对 → 空对象，不是 404", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});

    const resp = await hub.fetch(new Request("https://status-hub/pending"));

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({});
  });
});
