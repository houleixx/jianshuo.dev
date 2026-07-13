import { describe, it, expect } from "vitest";
import { handleRequest } from "../src/http.js";

const post = (body, headers = {}) =>
  new Request("https://voicedrop.cn/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer anon_test", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

// 不让测试真的打网络。
const fetchImpl = async () => new Response(JSON.stringify({ scope: "users/anon-1/" }), { status: 200 });
const call = (req) => handleRequest(req, { fetch: fetchImpl });

describe("CORS 与方法", () => {
  it("OPTIONS 预检 → 204，放行 Authorization 和 MCP 的自定义头", async () => {
    const res = await call(new Request("https://voicedrop.cn/mcp", { method: "OPTIONS" }));

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const allowed = res.headers.get("Access-Control-Allow-Headers").toLowerCase();
    expect(allowed).toContain("authorization");
    expect(allowed).toContain("mcp-protocol-version");
  });

  it("GET → 405：无状态模式不开服务端推流", async () => {
    const res = await call(new Request("https://voicedrop.cn/mcp", { method: "GET" }));

    expect(res.status).toBe(405);
  });

  it("每个响应都带 CORS 头", async () => {
    const res = await call(post({ jsonrpc: "2.0", id: 1, method: "ping" }));

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("认证", () => {
  it("没 token 就调工具 → 401，并带 WWW-Authenticate（给以后上 OAuth 留的口子）", async () => {
    const res = await handleRequest(
      new Request("https://voicedrop.cn/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami" } }),
      }),
      { fetch: fetchImpl },
    );

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    const body = await res.json();
    expect(body.error.message).toMatch(/token|令牌/);
  });

  it("没 token 也能 initialize + tools/list —— 客户端要先看得见有什么工具", async () => {
    const noAuth = (m) =>
      handleRequest(
        new Request("https://voicedrop.cn/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m }),
        }),
        { fetch: fetchImpl },
      );

    expect((await noAuth("tools/list")).status).toBe(200);
  });

  it("initialize 不需要 token —— 客户端要先握手才谈得上认证", async () => {
    const res = await handleRequest(
      new Request("https://voicedrop.cn/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      { fetch: fetchImpl },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).result.serverInfo.name).toBe("voicedrop");
  });
});

describe("JSON-RPC over HTTP", () => {
  it("正常请求 → 200 + JSON-RPC 响应", async () => {
    const res = await call(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.json();
    expect(body.id).toBe(1);
    expect(body.result.tools.length).toBeGreaterThan(20);
  });

  it("通知（无 id）→ 202，空 body", async () => {
    const res = await call(post({ jsonrpc: "2.0", method: "notifications/initialized" }));

    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("body 不是合法 JSON → -32700", async () => {
    const res = await call(post("{ 这不是 json"));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("批量请求：数组进，数组出（老协议版本还会发批量）", async () => {
    const res = await call(post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]));

    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body.map((r) => r.id)).toEqual([1, 2]);
  });

  it("整批都是通知 → 202，空 body", async () => {
    const res = await call(post([{ jsonrpc: "2.0", method: "notifications/initialized" }]));

    expect(res.status).toBe(202);
  });
});

describe("工具真的接上了 VoiceDrop", () => {
  it("tools/call whoami 会带着调用方的 token 打到 files API", async () => {
    let seen;
    const res = await handleRequest(post({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }), {
      fetch: async (url, init) => {
        seen = { url: String(url), auth: init.headers.Authorization };
        return new Response(JSON.stringify({ scope: "users/anon-1/" }), { status: 200 });
      },
    });

    expect(seen.url).toBe("https://jianshuo.dev/files/api/whoami");
    expect(seen.auth).toBe("Bearer anon_test"); // 原样透传，服务端不存凭证
    const body = await res.json();
    expect(JSON.parse(body.result.content[0].text)).toEqual({ scope: "users/anon-1/" });
  });
});
