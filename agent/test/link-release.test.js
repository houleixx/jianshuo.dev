import { describe, it, expect } from "vitest";
import { StatusHub } from "../src/status-hub.js";

// 上一轮只给 link_request 加了补送，link_release 没加 —— 洞还在，而且致命：
//
//   用户在手机上读到 4 位码 → 切到电脑上把码打给新设备 → 手机 App 进后台
//   → status socket 断开 → 服务端推的 link_release 没人接 → 永久丢失
//   → 手机永远不会封装 token、永远不 POST /complete → 新设备干等 25 秒超时。
//
// 这正是 2026-07-13 真机上第二次失败（码 2798）的原因：码看到了，登录还是没成。
//
// 修法：link_release 也要存住。socket 一连上来，先补 link_request（让 iOS 的
// present() 建好 pending），紧接着补 link_release（触发 release()）。顺序不能反。
// 这是纯服务端修复 —— iOS 的 handle() 本来就认这两种消息，老版本 App 也能直接受益。

const REQ = { type: "link_request", pairingId: "a".repeat(32), code: "7391", pubkey: "PUB" };
const REL = { type: "link_release", pairingId: "a".repeat(32) };

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

globalThis.WebSocketPair = globalThis.WebSocketPair ?? function () {
  return { 0: { __client: true }, 1: fakeWs() };
};

const post = (path, body) =>
  new Request(`https://status-hub${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

// WS 分支要回 101，Node 的 Response 不允许（Workers 才允许）。send() 发生在那之前。
async function connectWs(hub) {
  try {
    await hub.fetch(new Request("https://status-hub/", { headers: { Upgrade: "websocket" } }));
  } catch (e) {
    if (!/status/.test(String(e))) throw e;
  }
}

describe("link_release 也要存住", () => {
  it("广播 link_release → 在待处理记录上打「已放行」标记", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ }));

    await hub.fetch(post("/broadcast", { payload: REL }));

    expect((await state.storage.get("pendingLink")).released).toBe(true);
  });

  it("pairingId 对不上的 link_release 不打标记（别放行错的配对）", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ }));

    await hub.fetch(post("/broadcast", { payload: { type: "link_release", pairingId: "b".repeat(32) } }));

    expect((await state.storage.get("pendingLink")).released).toBeUndefined();
  });

  it("没有待处理配对时收到 link_release → 不炸、不凭空造记录", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});

    await hub.fetch(post("/broadcast", { payload: REL }));

    expect(await state.storage.get("pendingLink")).toBeUndefined();
  });
});

describe("手机回到前台重连：补送顺序不能反", () => {
  it("已放行 → 先补 link_request 再补 link_release", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ }));
    await hub.fetch(post("/broadcast", { payload: REL }));   // 此时没人连着，两条都会丢

    await connectWs(hub);

    const sent = state.sockets.at(-1).sent;
    // 顺序是死的：iOS 先靠 link_request 在 present() 里建好 pending（含 pubkey），
    // 才有东西给 release() 用。反过来 release() 会拿到 nil。
    expect(sent.map((m) => m.type)).toEqual(["link_request", "link_release"]);
    expect(sent[0]).toMatchObject({ code: "7391", pubkey: "PUB" });
    expect(sent[1].pairingId).toBe(REQ.pairingId);
  });

  it("补送的 link_request 里不带内部字段（released / exp 不外泄）", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ }));
    await hub.fetch(post("/broadcast", { payload: REL }));

    await connectWs(hub);

    const req = state.sockets.at(-1).sent[0];
    expect(req).toEqual(REQ);
  });

  it("还没放行 → 只补 link_request", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ }));

    await connectWs(hub);

    expect(state.sockets.at(-1).sent.map((m) => m.type)).toEqual(["link_request"]);
  });
});

describe("GET /pending 要说明「已放行」", () => {
  it("已放行 → released:true（iOS 一回前台就能直接完成，不必等 WS）", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ }));
    await hub.fetch(post("/broadcast", { payload: REL }));

    const out = await (await hub.fetch(new Request("https://status-hub/pending"))).json();

    expect(out).toMatchObject({ pairingId: REQ.pairingId, code: "7391", pubkey: "PUB", released: true });
  });

  it("未放行 → 不带 released", async () => {
    const state = fakeState();
    const hub = new StatusHub(state, {});
    await hub.fetch(post("/broadcast", { payload: REQ }));

    const out = await (await hub.fetch(new Request("https://status-hub/pending"))).json();

    expect(out.released).toBeUndefined();
  });
});
