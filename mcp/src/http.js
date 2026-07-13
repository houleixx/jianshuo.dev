// MCP 的 HTTP 传输层（streamable HTTP，无状态模式）。
//
// 无状态 = 每个 POST 自成一体，不存 session、不开 SSE 推流。这样才跑得进
// Pages Function（那里没有 Durable Object 可用），也免掉了会话过期这类破事。
// 客户端能拿到的仍是完整的 MCP：initialize / tools/list / tools/call。

import { createServer, PARSE_ERROR } from "./protocol.js";
import { TOOLS } from "./tools.js";
import { createClient } from "./vd-client.js";

const SERVER_INFO = { name: "voicedrop", version: "1.0.0" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // MCP 客户端会发 Mcp-Session-Id / MCP-Protocol-Version，浏览器里跑的客户端
  // 拿不到放行就直接挂在预检上。
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

const rpcError = (id, code, message, status) => json({ jsonrpc: "2.0", id, error: { code, message } }, status);

// 握手和「看看有什么工具」都不需要 token——客户端常在认证前先 initialize + 列表。
// 真正碰用户数据的只有 tools/call，token 在那一步才必需。
const NEEDS_NO_TOKEN = new Set(["initialize", "ping", "tools/list", "notifications/initialized"]);

// login 是唯一免 token 的工具——它就是用来拿 token 的。要 token 才能登录、
// 要登录才能拿 token，那是死锁。
const NO_TOKEN_TOOLS = new Set(["login"]);

const needsToken = (m) =>
  !NEEDS_NO_TOKEN.has(m?.method) &&
  !(m?.method === "tools/call" && NO_TOKEN_TOOLS.has(m?.params?.name));

export async function handleRequest(request, { fetch = globalThis.fetch, connect = connectWebSocket } = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (request.method !== "POST") {
    // 无状态模式不提供服务端主动推流，所以 GET（SSE）明确回 405。
    return rpcError(null, -32000, "本 MCP 是无状态的，只接受 POST。", 405);
  }

  let msg;
  try {
    msg = JSON.parse(await request.text());
  } catch {
    return rpcError(null, PARSE_ERROR, "请求体不是合法 JSON。", 400);
  }

  const batch = Array.isArray(msg);
  const messages = batch ? msg : [msg];

  const token = bearer(request);
  if (!token && messages.some(needsToken)) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: messages.find((m) => m?.id !== undefined)?.id ?? null,
        error: {
          code: -32001,
          message:
            "缺少访问令牌。请在 VoiceDrop App 的设置里复制访问令牌，" +
            "在 MCP 客户端里配成 Authorization: Bearer <token>。",
        },
      }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "WWW-Authenticate": 'Bearer realm="voicedrop"',
          ...CORS,
        },
      },
    );
  }

  const server = createServer({ tools: TOOLS, serverInfo: SERVER_INFO });
  const ctx = { client: createClient({ token, fetch }), fetch, connect };

  const results = (await Promise.all(messages.map((m) => server.handle(m, ctx)))).filter((r) => r !== null);

  // 整批都是通知 → 没什么可回的。
  if (results.length === 0) return new Response(null, { status: 202, headers: CORS });

  return json(batch ? results : results[0]);
}

function bearer(request) {
  const raw = request.headers.get("Authorization") ?? "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// 出站 WebSocket，给 6+4 配对接手机送来的加密 blob 用。
// Workers 运行时里 `new WebSocket()` 不能用，必须走 fetch + Upgrade 头，
// 从响应上取 .webSocket（已实测：101 + webSocket 对象 + accept() 都正常）。
//
// 消息按到达顺序排队——verify 成功后手机推 blob，我们要不丢地接住第一条。
async function connectWebSocket(url) {
  const resp = await fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`连不上配对通道（HTTP ${resp.status}）。`);
  ws.accept();

  const queue = [];
  const waiters = [];
  const push = (v) => (waiters.length ? waiters.shift()(v) : queue.push(v));

  ws.addEventListener("message", (ev) => {
    try { push(JSON.parse(ev.data)); } catch { /* 不是 JSON 就丢掉 */ }
  });
  // 对端先挂了：别让 next() 永久悬着。
  ws.addEventListener("close", () => push(null));
  ws.addEventListener("error", () => push(null));

  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    close: () => { try { ws.close(); } catch { /* 已经关了 */ } },
  };
}
