import { describe, it, expect } from "vitest";
import { buildUpstreamRequest, accumulateUsage, newUsageAcc, buildSessionUpdate } from "../src/realtime.js";
import { realtimeCostUY } from "../src/usage.js";

// WS 中转本体（WebSocketPair/双向转发）无法在 vitest/Node 跑，靠线上验证。
// 这里测可测的纯函数：出站请求构造、usage 累加、注入的 session.update 形状。

describe("buildUpstreamRequest", () => {
  it("https:// + Upgrade + Authorization Bearer key + 正确 model", () => {
    const req = buildUpstreamRequest({ OPENAI_API_KEY: "sk-test" });
    expect(req.url).toBe("https://api.openai.com/v1/realtime?model=gpt-realtime-2.1");
    expect(req.headers.get("Upgrade")).toBe("websocket");
    expect(req.headers.get("Authorization")).toBe("Bearer sk-test");
  });
});

describe("accumulateUsage", () => {
  it("从 response.done 拆出 6 档（cached 从总量里扣出来）", () => {
    const acc = newUsageAcc();
    accumulateUsage(acc, { type: "response.done", response: { usage: {
      input_token_details:  { audio_tokens: 1000, text_tokens: 200, cached_tokens_details: { audio_tokens: 400, text_tokens: 50 } },
      output_token_details: { audio_tokens: 300, text_tokens: 20 },
    } } });
    expect(acc.audio_in).toBe(600);          // 1000 - 400 cached
    expect(acc.audio_in_cached).toBe(400);
    expect(acc.text_in).toBe(150);           // 200 - 50 cached
    expect(acc.text_in_cached).toBe(50);
    expect(acc.audio_out).toBe(300);
    expect(acc.text_out).toBe(20);
  });
  it("多条 response.done 累加", () => {
    const acc = newUsageAcc();
    const ev = { type: "response.done", response: { usage: { input_token_details: { audio_tokens: 100 }, output_token_details: { audio_tokens: 50 } } } };
    accumulateUsage(acc, ev); accumulateUsage(acc, ev);
    expect(acc.audio_in).toBe(200);
    expect(acc.audio_out).toBe(100);
  });
  it("缺 usage / 坏结构不抛、不改", () => {
    const acc = newUsageAcc();
    accumulateUsage(acc, { type: "response.done" });
    accumulateUsage(acc, {});
    expect(acc.audio_in).toBe(0);
  });
  it("累加结果能喂给 realtimeCostUY 折算", () => {
    const acc = newUsageAcc();
    accumulateUsage(acc, { type: "response.done", response: { usage: { output_token_details: { audio_tokens: 1_000_000 } } } });
    expect(realtimeCostUY(acc)).toBe(Math.ceil(64 * 7.3 * 1e6)); // 1M audio_out = $64
  });
});

describe("buildSessionUpdate", () => {
  it("是 session.update，含采访员 instructions 与 create_response:false", () => {
    const u = buildSessionUpdate();
    expect(u.type).toBe("session.update");
    expect(typeof u.session.instructions).toBe("string");
    expect(u.session.audio.input.turn_detection.create_response).toBe(false);
    expect(u.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
  });
});
