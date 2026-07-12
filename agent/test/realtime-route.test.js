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
  it("是 session.update，含采访员 instructions 与 semantic_vad + create_response:true", () => {
    const u = buildSessionUpdate();
    expect(u.type).toBe("session.update");
    expect(typeof u.session.instructions).toBe("string");
    expect(u.session.audio.input.turn_detection.type).toBe("semantic_vad");
    expect(u.session.audio.input.turn_detection.create_response).toBe(true);
    // 默认 PCM24（旧包兼容）；新 app 在 WS URL 带 ?fmt=pcmu 换 G.711 μ-law
    //（跨境弱网下把持续上行从 ~600kbps 压到 ~85kbps）。
    expect(u.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
    expect(buildSessionUpdate({ type: "audio/pcmu" }).session.audio.input.format)
      .toEqual({ type: "audio/pcmu" });
    expect(u.session.audio.output.voice).toBe("cedar");
  });
  // 2026-07-10「采访者自顾自说个不停」修复：semantic_vad 自动触发的回应不走 app 的
  // response.create（那个 120 上限根本没人调用），没有 session 级上限就是无限长。
  it("session 级 max_output_tokens 存在且有界（auto 回应否则可无限独白）", () => {
    const m = buildSessionUpdate().session.max_output_tokens;
    expect(Number.isInteger(m)).toBe(true);
    expect(m).toBeGreaterThan(0);
    expect(m).toBeLessThanOrEqual(4096);
  });
  // 2026-07-12 按 OpenAI realtime prompting 指南重构：分节结构 + wait_for_user 工具。
  // 「何时开口」交给 semantic_vad + wait_for_user 决策，prompt 里不再有模型执行
  // 不了的计时指令（旧「停顿超过三秒」）；健谈系的填满冷场指令依然禁入。
  it("instructions 是分节克制版：含 wait_for_user 指引，无计时指令、无填满冷场类指令", () => {
    const ins = buildSessionUpdate().session.instructions;
    expect(ins).toMatch(/# 角色与目标/);
    expect(ins).toMatch(/# 何时不说话/);
    expect(ins).toMatch(/wait_for_user/);
    expect(ins).toMatch(/每次只问一个问题/);
    expect(ins).toMatch(/始终用中文/);
    expect(ins).not.toMatch(/停顿超过三秒/); // 模型测不了时长，那是 semantic_vad 的活
    expect(ins).not.toMatch(/不让对话冷场/);
    expect(ins).not.toMatch(/接住/);
  });
  // 2026-07-12 用户拍板：采访问宏观（为什么重要/背后逻辑/趋势/判断），不追细节。
  it("问题方向是宏观：问为什么和趋势，不把数字时间地点当追问目标", () => {
    const ins = buildSessionUpdate().session.instructions;
    expect(ins).toMatch(/宏观/);
    expect(ins).toMatch(/为什么/);
    expect(ins).toMatch(/不要追问细节/);
    expect(ins).not.toMatch(/例子、数字/); // 旧「往细处挖」措辞不再出现
  });
  it("session.tools 带 wait_for_user no-op 工具（prompt 提到的工具必须真的在工具表里）", () => {
    const tools = buildSessionUpdate().session.tools;
    expect(Array.isArray(tools)).toBe(true);
    const wait = tools.find((t) => t.name === "wait_for_user");
    expect(wait?.type).toBe("function");
    expect(wait?.parameters).toEqual({ type: "object", properties: {}, required: [] });
  });
});
