import { describe, it, expect } from "vitest";
import { handleRequest } from "../src/http.js";

// 浏览器直接点开 voicedrop.cn/mcp，本来只会看到一句冷冰冰的 JSON 405。给它一个
// 介绍页——但**不能碰坏 MCP 协议**。
//
// 规范（Streamable HTTP → Listening for Messages from the Server）说得很死：
//   2. The client MUST include an `Accept` header, listing `text/event-stream`
//      as a supported content type.
//   3. The server MUST either return `Content-Type: text/event-stream` in response
//      to this HTTP GET, or else return HTTP 405 Method Not Allowed.
//
// 第 3 条约束的是「带 text/event-stream 的 GET」——那是 MCP 客户端。浏览器不带它。
// 所以按 Accept 分流是合规的：
//
//   Accept 里明确有 text/html  → 浏览器 → 介绍页
//   其余一切（含没有 Accept）  → 一律 405，行为一个字不变
//
// 判据故意取保守方向：**只有明确要 text/html 才给页面**。万一有客户端不守规范、
// 漏发了 Accept，它拿到的仍是 405，而不是一坨 HTML。

const get = (accept) =>
  handleRequest(
    new Request("https://voicedrop.cn/mcp", {
      method: "GET",
      ...(accept ? { headers: { Accept: accept } } : {}),
    }),
    { fetch: async () => new Response("{}") },
  );

describe("浏览器来的 GET → 介绍页", () => {
  it("Accept: text/html → 200 HTML", async () => {
    const res = await get("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("页面里得有人真正需要的东西：端点、接入命令、登录说明", async () => {
    const html = await (await get("text/html")).text();

    expect(html).toContain("https://voicedrop.cn/mcp");
    expect(html).toContain("claude mcp add");
    expect(html).toMatch(/login|登录/);
  });

  it("是一个完整的 HTML 文档，不是一段碎片", async () => {
    const html = await (await get("text/html")).text();

    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("</html>");
  });
});

describe("MCP 客户端来的 GET → 照旧 405，规范不能破", () => {
  it("Accept: text/event-stream（规范要求客户端必带）→ 405", async () => {
    const res = await get("text/event-stream");

    expect(res.status).toBe(405);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("Accept 同时列了 json 和 event-stream（客户端的标准写法）→ 405", async () => {
    const res = await get("application/json, text/event-stream");

    expect(res.status).toBe(405);
  });

  it("完全没有 Accept 头 → 405（保守：不确定就别喂 HTML）", async () => {
    const res = await get(null);

    expect(res.status).toBe(405);
  });

  it("Accept: */* → 405（不是明确要 HTML，就不给 HTML）", async () => {
    const res = await get("*/*");

    expect(res.status).toBe(405);
  });

  it("Accept: application/json → 405", async () => {
    const res = await get("application/json");

    expect(res.status).toBe(405);
  });
});

describe("POST 一点没变", () => {
  it("浏览器式的 Accept 头也不影响 POST 走 JSON-RPC", async () => {
    const res = await handleRequest(
      new Request("https://voicedrop.cn/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/html" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      { fetch: async () => new Response("{}") },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.tools.length).toBeGreaterThan(20);
  });
});
