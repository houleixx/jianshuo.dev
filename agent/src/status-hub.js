// StatusHub — 每个用户一个 Durable Object（idFromName("status:" + scope)）。
// 挖矿状态、设备配对的推送都从这里扇出到该用户所有已连接的 app socket。
// 用 WebSocket Hibernation，闲置时不花钱。
//
// 从 index.js 抽出来，是为了能被测到：index.js 引了 `agents` 包，它又引
// `cloudflare:workers`，vitest 里加载不了。
//
// ── 待处理配对（pendingLink）──
// broadcast 原本是**纯扇出、零缓冲**：没人连着的时候消息直接丢掉、永不重放。
// 而 iOS 一进后台就 disconnect()，于是 6+4 登录的 link_request 会**永久丢失**——
// 用户就算 5 秒后打开 App，那个 4 位码也再不会出现，配对只能干等过期。
// 更糟的是 link_release：iOS 的 release() 里 `guard let p = pending`，配对状态
// 只在内存里，App 重启 / 后台错过 link_request / 用户划走弹窗，pending 就是 nil，
// link_release 被静默丢弃——服务端只能干等超时。（2026-07-13 真机上暴露。）
//
// 所以把 link_request 存住（与配对同寿，2 分钟），并且：
//   ① 任何 socket 连上来就补送 —— 手机不会再错过
//   ② GET /pending 让手机随时主动捞 —— 不必客户端持久化 pubkey

import { buildBroadcastMessage, pendingRecord, livePending } from "./devicelink.js";

const PENDING_KEY = "pendingLink";

export class StatusHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);

      // 补送：手机刚才可能在后台，错过了推送。
      const pending = await this.pending();
      if (pending) {
        try { server.send(JSON.stringify(pending)); } catch (_) {}
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname.endsWith("/broadcast")) {
      const body = await request.json();
      const msg = buildBroadcastMessage(body);

      // 配对请求要存住；挖矿状态之类不存。
      const rec = pendingRecord(msg, Date.now());
      if (rec) await this.state.storage.put(PENDING_KEY, rec);

      const wire = JSON.stringify(msg);
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(wire); } catch (_) {}
      }
      return new Response("ok");
    }

    if (url.pathname.endsWith("/pending")) {
      return Response.json((await this.pending()) ?? {});
    }

    // 配对完成/取消后清掉，别让手机再捞到一个死配对。
    if (request.method === "POST" && url.pathname.endsWith("/clear-pending")) {
      await this.state.storage.delete(PENDING_KEY);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  // 还活着的待处理配对（含 pubkey——手机放行时要用它封 token），过期的顺手删掉。
  async pending() {
    const rec = await this.state.storage.get(PENDING_KEY);
    const live = livePending(rec, Date.now());
    if (rec && !live) await this.state.storage.delete(PENDING_KEY);
    return live;
  }

  webSocketMessage(_ws, _msg) {}
  webSocketClose(_ws) {}
  webSocketError(_ws) {}
}
