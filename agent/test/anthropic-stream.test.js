// 流式聚合：非流式 POST 会被 Anthropic 门口的 Cloudflare ~100s 掐断(HTTP 524)——
// 2h 录音的挖矿生成超 2 分钟必死(2026-07-09 事故)。改 stream:true 后在
// anthropicFetch 内部把 SSE 聚合回原响应形状,调用方零改动。
import { describe, it, expect, beforeEach } from "vitest";
import { callAnthropic, _resetGeoState } from "../src/anthropic.js";

beforeEach(() => _resetGeoState());

const ENV = { CLAUDE_API_KEY: "k" };

function sseBody(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}
function sseResponse(events) {
  return new Response(sseBody(events), { status: 200, headers: { "content-type": "text/event-stream" } });
}
function chunkedSseResponse(events, chunkSize) {
  const whole = sseBody(events);
  const enc = new TextEncoder().encode(whole);
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (i >= enc.length) return c.close();
      c.enqueue(enc.slice(i, i + chunkSize));
      i += chunkSize;
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const TEXT_EVENTS = [
  { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } } },
  { type: "ping" },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "，世界" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];

describe("anthropicFetch streaming", () => {
  it("请求带 stream:true,SSE 聚合回 Messages JSON(text/usage/stop_reason 齐全)", async () => {
    let sentBody;
    const f = async (_url, init) => { sentBody = JSON.parse(init.body); return sseResponse(TEXT_EVENTS); };
    const r = await callAnthropic(ENV, { model: "m", max_tokens: 10 }, { fetchImpl: f });
    expect(sentBody.stream).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.json.content).toEqual([{ type: "text", text: "你好，世界" }]);
    expect(r.json.stop_reason).toBe("end_turn");
    expect(r.json.usage.input_tokens).toBe(11);
    expect(r.json.usage.output_tokens).toBe(42);
    expect(r.json.usage.cache_read_input_tokens).toBe(5);
    expect(r.json.usage.cache_creation_input_tokens).toBe(3);
    expect(r.json.model).toBe("claude-x");
  });

  it("SSE 按任意字节边界分块也能正确聚合(跨 chunk 的多字节中文)", async () => {
    const f = async () => chunkedSseResponse(TEXT_EVENTS, 7); // 7 字节必然切碎中文
    const r = await callAnthropic(ENV, { model: "m" }, { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(r.json.content[0].text).toBe("你好，世界");
  });

  it("tool_use 的 input_json_delta 攒完解析成对象", async () => {
    const events = [
      { type: "message_start", message: { id: "m2", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "edit", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"li' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ne":3}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ];
    const r = await callAnthropic(ENV, { model: "m" }, { fetchImpl: async () => sseResponse(events) });
    expect(r.ok).toBe(true);
    expect(r.json.content[0]).toMatchObject({ type: "tool_use", id: "t1", name: "edit", input: { line: 3 } });
    expect(r.json.stop_reason).toBe("tool_use");
  });

  it("流中途 error 事件 → ok:false status:0(transient,调用方按网络错误重试)", async () => {
    const events = [
      { type: "message_start", message: { id: "m3", type: "message", role: "assistant", model: "claude-x", content: [], stop_reason: null, usage: { input_tokens: 1 } } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    ];
    const r = await callAnthropic(ENV, { model: "m" }, { fetchImpl: async () => sseResponse(events) });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.errorText).toContain("overloaded");
  });

  it("非 SSE 的 JSON 响应原样解析(测试 fake/代理兜底)", async () => {
    const body = { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 1, output_tokens: 1 } };
    const r = await callAnthropic(ENV, { model: "m" }, { fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }) });
    expect(r.ok).toBe(true);
    expect(r.json.content[0].text).toBe("hi");
  });

  it("HTTP 非 200 仍按原样返回错误文本", async () => {
    const r = await callAnthropic(ENV, { model: "m" }, { fetchImpl: async () => new Response('{"error":{"message":"bad"}}', { status: 400 }) });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.errorText).toContain("bad");
  });
});
