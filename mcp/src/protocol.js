// MCP 协议层：JSON-RPC 2.0 + MCP 方法，与传输无关。
//
// 无状态实现——每个 POST 自成一体，不存 session。这是 streamable HTTP 的
// 推荐模式，也让我们能跑在 Pages Function（没有 Durable Object）上。
//
// 零依赖：这份代码会被 esbuild 跟着 functions/voicedrop/mcp.js 一起打进
// Pages 的 bundle，不能引任何 Node 内置模块。

export const PROTOCOL_VERSION = "2025-06-18";

// 我们能说的所有协议版本。客户端要其中任意一个都照给，否则退回我们自己的。
const SUPPORTED_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

// JSON-RPC 2.0 标准错误码。
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const PARSE_ERROR = -32700;

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * @param {object}   opts
 * @param {Array}    opts.tools       工具表：{name, description, inputSchema, handler(args, ctx)}
 * @param {object}   opts.serverInfo  {name, version}
 */
export function createServer({ tools, serverInfo }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  // 只暴露客户端该看的三个字段——handler 是我们的私事。
  const manifest = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

  async function callTool(id, params, ctx) {
    const tool = byName.get(params?.name);
    if (!tool) return err(id, INVALID_PARAMS, `未知工具：${params?.name}`);

    const args = params.arguments ?? {};
    const missing = (tool.inputSchema?.required ?? []).filter((k) => args[k] === undefined);
    if (missing.length) return err(id, INVALID_PARAMS, `缺少必填参数：${missing.join("、")}`);

    // 工具执行失败是「结果」不是「协议错误」——按 MCP 规范回 isError:true，
    // 模型才看得见错误内容、能自己改参数重试。
    try {
      const out = await tool.handler(args, ctx);
      return ok(id, { content: [toTextBlock(out)], isError: false });
    } catch (e) {
      return ok(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
    }
  }

  /**
   * 处理一条已解析的 JSON-RPC 消息。
   * @returns 响应对象；若是通知（无 id）则返回 null。
   */
  async function handle(msg, ctx) {
    const id = msg?.id;
    const isNotification = id === undefined || id === null;

    if (msg?.jsonrpc !== "2.0") {
      return isNotification ? null : err(id, INVALID_REQUEST, "jsonrpc 必须是 \"2.0\"");
    }

    try {
      switch (msg.method) {
        case "initialize": {
          const asked = msg.params?.protocolVersion;
          return ok(id, {
            protocolVersion: SUPPORTED_VERSIONS.has(asked) ? asked : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo,
          });
        }
        case "ping":
          return ok(id, {});
        case "tools/list":
          return ok(id, { tools: manifest });
        case "tools/call":
          return await callTool(id, msg.params, ctx);
        default:
          // 通知一律静默（包括 notifications/initialized 和任何我们不认的通知）。
          return isNotification ? null : err(id, METHOD_NOT_FOUND, `未知方法：${msg.method}`);
      }
    } catch (e) {
      return isNotification ? null : err(id, INTERNAL_ERROR, String(e?.message ?? e));
    }
  }

  return { handle, manifest };
}

function toTextBlock(out) {
  const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
  return { type: "text", text };
}
