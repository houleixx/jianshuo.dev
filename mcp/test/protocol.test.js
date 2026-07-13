import { describe, it, expect } from "vitest";
import { createServer, PROTOCOL_VERSION } from "../src/protocol.js";

// 一个最小工具集，让协议测试不依赖真实的 VoiceDrop 工具表。
const tools = [
  {
    name: "echo",
    description: "回声，测试用",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回声的文本" } },
      required: ["text"],
    },
    async handler({ text }) {
      return `echo: ${text}`;
    },
  },
  {
    name: "boom",
    description: "永远抛错，测试用",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      throw new Error("炸了");
    },
  },
];

const server = () => createServer({ tools, serverInfo: { name: "test", version: "0.0.0" } });
const ctx = { token: "anon_test" };

describe("initialize", () => {
  it("宣告协议版本、tools capability 和 serverInfo", async () => {
    const res = await server().handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, ctx);

    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "test", version: "0.0.0" },
      },
    });
  });

  it("回显客户端请求的协议版本（只要我们支持）", async () => {
    const res = await server().handle(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      ctx,
    );

    expect(res.result.protocolVersion).toBe("2025-03-26");
  });

  it("客户端要一个我们不认识的版本时，退回到我们自己的版本", async () => {
    const res = await server().handle(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      ctx,
    );

    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe("notifications", () => {
  it("notifications/initialized 不产生任何响应", async () => {
    const res = await server().handle({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx);

    expect(res).toBeNull();
  });

  it("任何无 id 的消息（通知）都不产生响应，哪怕方法不存在", async () => {
    const res = await server().handle({ jsonrpc: "2.0", method: "notifications/whatever" }, ctx);

    expect(res).toBeNull();
  });
});

describe("ping", () => {
  it("回空结果", async () => {
    const res = await server().handle({ jsonrpc: "2.0", id: 7, method: "ping" }, ctx);

    expect(res).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
});

describe("tools/list", () => {
  it("列出每个工具的 name/description/inputSchema，且不泄露 handler", async () => {
    const res = await server().handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, ctx);

    expect(res.result.tools).toHaveLength(2);
    expect(res.result.tools[0]).toEqual({
      name: "echo",
      description: "回声，测试用",
      inputSchema: tools[0].inputSchema,
    });
    expect(res.result.tools[0]).not.toHaveProperty("handler");
  });
});

describe("tools/call", () => {
  it("调用工具并把返回值包成 text content block", async () => {
    const res = await server().handle(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "你好" } } },
      ctx,
    );

    expect(res.result).toEqual({ content: [{ type: "text", text: "echo: 你好" }], isError: false });
  });

  it("非字符串返回值序列化成 JSON", async () => {
    const jsonTools = [
      { name: "echo", description: "d", inputSchema: { type: "object", properties: {} }, async handler() { return { a: 1 }; } },
    ];
    const res = await createServer({ tools: jsonTools, serverInfo: { name: "t", version: "0" } }).handle(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: {} } },
      ctx,
    );

    expect(res.result.content[0].text).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("工具抛错 → isError:true 的正常结果，而不是 JSON-RPC 错误", async () => {
    const res = await server().handle(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom", arguments: {} } },
      ctx,
    );

    // MCP 规范：工具执行失败是「结果」，让模型看得见、能自己纠错；
    // 只有协议层面的失败才用 JSON-RPC error。
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("炸了");
    expect(res.error).toBeUndefined();
  });

  it("工具不存在 → JSON-RPC 错误 -32602", async () => {
    const res = await server().handle(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } },
      ctx,
    );

    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("nope");
  });

  it("缺必填参数 → JSON-RPC 错误 -32602，且指出缺了谁", async () => {
    const res = await server().handle(
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "echo", arguments: {} } },
      ctx,
    );

    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain("text");
  });
});

describe("协议错误", () => {
  it("未知方法 → -32601", async () => {
    const res = await server().handle({ jsonrpc: "2.0", id: 9, method: "resources/list" }, ctx);

    expect(res.error.code).toBe(-32601);
  });

  it("不是 jsonrpc 2.0 → -32600", async () => {
    const res = await server().handle({ id: 9, method: "ping" }, ctx);

    expect(res.error.code).toBe(-32600);
  });
});
