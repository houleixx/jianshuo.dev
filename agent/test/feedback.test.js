// test/feedback.test.js — POST /agent/feedback（设置→帮助与反馈）：
// 鉴权、空文本 400、R2 存档（feedback/<日期>/*.json 带 scope 身份）、
// 管理员 APNs 直推 + 同一 scope 60s 节流（存档不受节流影响）。
import { vi, describe, it, expect, beforeEach } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
vi.mock("../src/push.js", () => ({ sendPush: vi.fn(async () => true) }));
import { sendPush } from "../src/push.js";
import worker from "../src/index.js";
import { fakeEnv } from "./fakes.js";

const TOKEN = "anon_" + "f".repeat(28);
const ADMIN = "users/anon-admin/";

// 收集 waitUntil 的 promise，测试里 drain 等它落定（推送/节流 marker 都在里面）。
let pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const drain = async () => { await Promise.all(pending); pending = []; };

function req(body, { token = TOKEN } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return new Request("https://jianshuo.dev/agent/feedback", {
    method: "POST", headers, body: JSON.stringify(body ?? {}),
  });
}

let env;
beforeEach(() => {
  vi.clearAllMocks();
  pending = [];
  env = { ...fakeEnv(), ADMIN_SCOPE: ADMIN };
});

function feedbackKeys() {
  return [...env.FILES._store.keys()].filter((k) => k.startsWith("feedback/") && k.endsWith(".json"));
}

describe("POST /agent/feedback", () => {
  it("401s with no token", async () => {
    const res = await worker.fetch(req({ text: "hi" }, { token: "" }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("400s on empty / whitespace text", async () => {
    expect((await worker.fetch(req({}), env, ctx)).status).toBe(400);
    expect((await worker.fetch(req({ text: "   " }), env, ctx)).status).toBe(400);
  });

  it("archives to feedback/<day>/ with the server-resolved scope and pushes the admin", async () => {
    const res = await worker.fetch(req({ text: "建议加个夜间模式", name: "建硕", version: "1.0 (200)" }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    const keys = feedbackKeys();
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^feedback\/\d{4}-\d{2}-\d{2}\//);
    const saved = JSON.parse(await (await env.FILES.get(keys[0])).text());
    expect(saved.text).toBe("建议加个夜间模式");
    expect(saved.name).toBe("建硕");
    expect(saved.version).toBe("1.0 (200)");
    expect(saved.scope).toMatch(/^users\/anon-[0-9a-f]+\/$/);   // 身份来自 token，非客户端声称
    expect(sendPush).toHaveBeenCalledTimes(1);
    const [, scope, payload] = sendPush.mock.calls[0];
    expect(scope).toBe(ADMIN);
    expect(payload.title).toContain("建硕");
    expect(payload.body).toContain("夜间模式");
  });

  it("throttles the admin push per scope (60s) but still archives every feedback", async () => {
    await worker.fetch(req({ text: "第一条" }), env, ctx);
    await drain();
    await worker.fetch(req({ text: "第二条" }), env, ctx);
    await drain();
    expect(feedbackKeys().length).toBe(2);
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it("caps text at 2000 chars and skips push without ADMIN_SCOPE", async () => {
    delete env.ADMIN_SCOPE;
    const res = await worker.fetch(req({ text: "长".repeat(3000) }), env, ctx);
    await drain();
    expect(res.status).toBe(200);
    const saved = JSON.parse(await (await env.FILES.get(feedbackKeys()[0])).text());
    expect(saved.text.length).toBe(2000);
    expect(sendPush).not.toHaveBeenCalled();
  });
});
