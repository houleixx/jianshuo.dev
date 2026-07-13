import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { classifyAppliesTo } from "../src/prompt-classify.js";
import worker from "../src/index.js";
import { fakeEnv } from "./fakes.js";

const claudeSaying = (s) => async () => s;

function mockAnthropicUnauthorized() {
  return vi.fn(async () => ({
    ok: false,
    status: 401,
    text: async () => "Unauthorized",
  }));
}

describe("classifyAppliesTo — 纯逻辑（注入 claude）", () => {
  it("模型说 text → {appliesTo:[text], reason}", async () => {
    const r = await classifyAppliesTo("把这段改得更简洁", claudeSaying('{"appliesTo":["text"],"reason":"这条像是改文字的"}'));
    expect(r.appliesTo).toEqual(["text"]);
    expect(r.reason).toBe("这条像是改文字的");
  });

  it("模型说 image → {appliesTo:[image]}", async () => {
    const r = await classifyAppliesTo("把这张图重画成水彩", claudeSaying('{"appliesTo":["image"],"reason":"改图的"}'));
    expect(r.appliesTo).toEqual(["image"]);
  });

  it("模型说都行 → 两个都要", async () => {
    const r = await classifyAppliesTo("解释一下", claudeSaying('{"appliesTo":["text","image"],"reason":"都行"}'));
    expect(new Set(r.appliesTo)).toEqual(new Set(["text", "image"]));
  });

  it("模型套了 ``` 围栏 → 照样解析", async () => {
    const r = await classifyAppliesTo("x", claudeSaying('```json\n{"appliesTo":["text"],"reason":"r"}\n```'));
    expect(r.appliesTo).toEqual(["text"]);
  });

  it("★ claude 抛异常 → 回退都行 + 空 reason（绝不挡住新建）", async () => {
    const r = await classifyAppliesTo("x", async () => { throw new Error("no credit"); });
    expect(new Set(r.appliesTo)).toEqual(new Set(["text", "image"]));
    expect(r.reason).toBe("");
  });

  it("★ 模型返回垃圾 / 空 / 非法值 → 回退都行 + 空 reason", async () => {
    for (const junk of ["", "我不知道", "{}", '{"appliesTo":[]}', '{"appliesTo":["video"]}', '{"appliesTo":"text"}']) {
      const r = await classifyAppliesTo("x", claudeSaying(junk));
      expect(new Set(r.appliesTo)).toEqual(new Set(["text", "image"]));
      expect(r.reason).toBe("");
    }
  });

  it("模型混入非法值 → 只留合法的", async () => {
    const r = await classifyAppliesTo("x", claudeSaying('{"appliesTo":["text","video"],"reason":"r"}'));
    expect(r.appliesTo).toEqual(["text"]);
  });

  it("reason 超长 → 截断（琥珀条放不下）", async () => {
    const r = await classifyAppliesTo("x", claudeSaying(JSON.stringify({ appliesTo: ["text"], reason: "长".repeat(200) })));
    expect(r.reason.length).toBeLessThanOrEqual(60);
  });
});

describe("classifyAppliesTo — 额外对抗性探针", () => {
  it("模型吐了多段 JSON 碎片（第一段是垃圾）→ 整体不是合法 JSON，安全回退（不误取前一段的碎片）", async () => {
    const r = await classifyAppliesTo("x", claudeSaying('{"a":1} garbage {"appliesTo":["text"],"reason":"r"}'));
    expect(new Set(r.appliesTo)).toEqual(new Set(["text", "image"]));
    expect(r.reason).toBe("");
  });

  it("appliesTo 合法但重复 → 去重，不是 [text,text]", async () => {
    const r = await classifyAppliesTo("x", claudeSaying('{"appliesTo":["text","text"],"reason":"r"}'));
    expect(r.appliesTo).toEqual(["text"]);
  });

  it("reason 是数字/对象（非字符串）→ 回退空字符串，不崩", async () => {
    const r1 = await classifyAppliesTo("x", claudeSaying('{"appliesTo":["text"],"reason":42}'));
    expect(r1.reason).toBe("");
    const r2 = await classifyAppliesTo("x", claudeSaying('{"appliesTo":["text"],"reason":{"nested":true}}'));
    expect(r2.reason).toBe("");
  });

  it("claude 是【同步】抛异常的函数（非 async，不是 rejected Promise）→ 仍被兜住", async () => {
    const syncThrowingClaude = () => { throw new Error("boom, synchronously"); };
    const r = await classifyAppliesTo("x", syncThrowingClaude);
    expect(new Set(r.appliesTo)).toEqual(new Set(["text", "image"]));
    expect(r.reason).toBe("");
  });

  it("claude 返回 undefined → 回退都行", async () => {
    const r = await classifyAppliesTo("x", async () => undefined);
    expect(new Set(r.appliesTo)).toEqual(new Set(["text", "image"]));
    expect(r.reason).toBe("");
  });
});

describe("POST /agent/prompt-classify route", () => {
  const TOKEN = "Bearer anon_testtoken1234567890";
  afterEach(() => { vi.unstubAllGlobals(); });

  it("无 token → 401", async () => {
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-classify", { method: "POST" }), fakeEnv());
    expect(res.status).toBe(401);
  });

  it("GET → 405", async () => {
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-classify", { headers: { Authorization: TOKEN } }), fakeEnv());
    expect(res.status).toBe(405);
  });

  it("缺 prompt → 400", async () => {
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-classify", {
      method: "POST", headers: { Authorization: TOKEN, "content-type": "application/json" }, body: JSON.stringify({}),
    }), fakeEnv());
    expect(res.status).toBe(400);
  });

  it("body 根本不是 JSON → 400，不 500", async () => {
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-classify", {
      method: "POST", headers: { Authorization: TOKEN, "content-type": "application/json" },
      body: "this is not json {{{",
    }), fakeEnv());
    expect(res.status).toBe(400);
  });

  it("★ 没有 CLAUDE_API_KEY（调用必挂）→ 仍 200 + 回退都行，绝不 500", async () => {
    const env = { ...fakeEnv() };
    vi.stubGlobal("fetch", mockAnthropicUnauthorized());
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompt-classify", {
      method: "POST", headers: { Authorization: TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "把这段改简洁" }),
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new Set(body.appliesTo)).toEqual(new Set(["text", "image"]));
    expect(body.reason).toBe("");
  });
});
