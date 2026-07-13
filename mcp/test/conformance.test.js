// 一致性测试：用官方 @modelcontextprotocol/sdk 的真客户端，走真的 streamable
// HTTP 传输，去连我们手写的 server。
//
// 前面那些测试都是我们自己跟自己对话——协议写错了也测不出来。这一关是外部裁判：
// 真客户端能握手、能列工具、能调工具，才算真的说了 MCP。

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleRequest } from "../src/http.js";

// 上游 VoiceDrop 的假实现：按 URL 给回值。
function upstream(routes) {
  return async (url) => {
    const path = new URL(String(url)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// 把客户端的 HTTP 请求直接喂进我们的 handler——不用真起服务器。
async function connect(routes = {}) {
  const client = new Client({ name: "conformance-test", version: "1.0.0" });

  const transport = new StreamableHTTPClientTransport(new URL("https://voicedrop.cn/mcp"), {
    requestInit: { headers: { Authorization: "Bearer anon_conformance_test_token" } },
    fetch: (url, init) => handleRequest(new Request(url, init), { fetch: upstream(routes) }),
  });

  await client.connect(transport);
  return client;
}

describe("官方 MCP 客户端能连上", () => {
  it("握手成功，并报出我们的 serverInfo", async () => {
    const client = await connect();

    expect(client.getServerVersion()).toMatchObject({ name: "voicedrop" });
    await client.close();
  });

  it("宣告了 tools capability", async () => {
    const client = await connect();

    expect(client.getServerCapabilities().tools).toBeDefined();
    await client.close();
  });
});

describe("官方客户端能用我们的工具", () => {
  it("listTools() 拿到全部工具，每个都有合法的 inputSchema", async () => {
    const client = await connect();

    const { tools } = await client.listTools();

    expect(tools.length).toBeGreaterThanOrEqual(28);
    expect(tools.map((t) => t.name)).toContain("community_feed");
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
    }
    await client.close();
  });

  it("callTool() 真的打到 VoiceDrop 并把结果带回来", async () => {
    const client = await connect({
      "/files/api/articles": { articles: [{ stem: "s1", title: "第一篇", head: 1, count: 1 }] },
    });

    const res = await client.callTool({ name: "list_articles", arguments: {} });

    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content[0].text).articles[0].title).toBe("第一篇");
    await client.close();
  });

  it("上游报错时，客户端拿到 isError:true 和一句人话（而不是协议炸掉）", async () => {
    const client = await connect({}); // 什么路由都没有 → 上游一律 404

    const res = await client.callTool({ name: "read_article", arguments: { stem: "不存在的" } });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/不存在|没找到/);
    await client.close();
  });

  it("必填参数缺失，客户端会收到协议级报错", async () => {
    const client = await connect();

    await expect(client.callTool({ name: "read_article", arguments: {} })).rejects.toThrow(/stem/);

    await client.close();
  });
});
