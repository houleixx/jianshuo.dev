import { describe, it, expect, afterEach } from "vitest";
import { parseAssistant, runAgentLoop } from "../src/loop.js";
import { fakeEnv, fakeFetch } from "./fakes.js";

afterEach(() => { delete globalThis.fetch; });

// Build a fake Anthropic response.
const asst = (...blocks) => ({ role: "assistant", content: blocks, stop_reason: blocks.some(b => b.type === "tool_use") ? "tool_use" : "end_turn" });
const toolUse = (name, input, id = name + "-1") => ({ type: "tool_use", id, name, input });
const text = (t) => ({ type: "text", text: t });

const ctx = (env) => ({ env, scope: "users/u/", articleKey: "users/u/articles/cur.json", token: "t", origin: "https://x" });

describe("parseAssistant", () => {
  it("splits text and tool_use blocks", () => {
    const r = parseAssistant(asst(text("hi"), toolUse("read_article", { stem: "a" })));
    expect(r.text).toBe("hi");
    expect(r.toolUses).toEqual([{ id: "read_article-1", name: "read_article", input: { stem: "a" } }]);
  });
});

describe("runAgentLoop", () => {
  it("chains list -> read -> write to merge, then stops", async () => {
    const env = fakeEnv({
      "users/u/articles/cur.json": JSON.stringify({ schema: 2, transcript: "T", articles: [{ title: "Cur", body: "c" }] }),
      "users/u/articles/old.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "", articles: [{ title: "Old", body: "o" }] }),
    });
    globalThis.fetch = fakeFetch({
      "PUT https://x/files/api/articles/cur": () => ({ ok: true, body: { ok: true, version: 2 } }),
    });
    // The write step carries the model's own explanation; the short-circuit uses
    // it as finalText and never makes the 4th call.
    const script = [
      asst(toolUse("list_articles", {})),
      asst(toolUse("read_article", { stem: "old" })),
      asst(text("合并好了"), toolUse("write_article", { articles: [{ title: "Merged", body: "c\n\no" }] })),
      asst(text("不应该走到这一步")),
    ];
    let i = 0;
    const callClaude = async () => script[i++];
    const r = await runAgentLoop({ callClaude, ctx: ctx(env), system: "S", userText: "把 old 合并进来" });
    expect(r.calledTools).toEqual(["list_articles", "read_article", "write_article"]);
    expect(r.finalText).toBe("合并好了");
    expect(i).toBe(3); // short-circuited after write_article — no extra confirmation round-trip
    // write_article now calls the HTTP API; verify the PUT was made with the merged content.
    const call = globalThis.fetch.calls[0];
    expect(JSON.parse(call.body).articles[0].title).toBe("Merged");
  });

  it("short-circuits an action-only turn (publish) without a confirmation call", async () => {
    const env = fakeEnv({ "users/u/articles/cur.json": JSON.stringify({ articles: [{ title: "C", body: "c" }] }) });
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, created: 1 }) }));
    const script = [asst(text("已发草稿"), toolUse("publish_wechat", {})), asst(text("不应该走到这一步"))];
    let i = 0;
    const r = await runAgentLoop({ callClaude: async () => script[i++], ctx: ctx(env), system: "S", userText: "发公众号" });
    expect(r.calledTools).toEqual(["publish_wechat"]);
    expect(r.finalText).toBe("已发草稿");
    expect(i).toBe(1); // short-circuited after publish_wechat
    delete globalThis.fetch;
  });

  it("prepends prior-turn history before the current user message", async () => {
    const env = fakeEnv({ "users/u/articles/cur.json": JSON.stringify({ articles: [{ title: "C", body: "c" }] }) });
    let seen;
    const callClaude = async ({ messages }) => { seen = messages; return asst(text("ok")); };
    const history = [
      { role: "user", content: "把第3行改简洁" },
      { role: "assistant", content: "改好了" },
    ];
    await runAgentLoop({ callClaude, ctx: ctx(env), system: "S", userContent: "再简洁点", history });
    expect(seen.slice(0, 2)).toEqual(history);
    expect(seen[2]).toEqual({ role: "user", content: "再简洁点" });
  });

  it("captures toolRuns (input AND result) even on the terminal short-circuit", async () => {
    // The fast path ends the turn after a successful terminal tool WITHOUT another
    // Claude call, so the tool's result lands in no logged request — toolRuns is the
    // only capture. This guards the admin's "what did this instruction do" view.
    const env = fakeEnv({ "users/u/articles/cur.json": JSON.stringify({ articles: [{ title: "C", body: "c" }] }) });
    globalThis.fetch = fakeFetch({
      "PUT https://x/files/api/articles/cur": () => ({ ok: true, body: { ok: true, version: 2 } }),
    });
    const script = [asst(text("改好了"), toolUse("write_article", { articles: [{ title: "C2", body: "c2" }] }))];
    let i = 0;
    const r = await runAgentLoop({ callClaude: async () => script[i++], ctx: ctx(env), system: "S", userText: "go" });
    expect(i).toBe(1); // terminal short-circuit — no second Claude call
    expect(r.toolRuns).toEqual([
      { step: 0, name: "write_article", input: { articles: [{ title: "C2", body: "c2" }] }, result: { ok: true, count: 1 }, ok: true },
    ]);
  });

  it("stops at maxSteps even if Claude never yields", async () => {
    const env = fakeEnv({ "users/u/articles/cur.json": JSON.stringify({ articles: [{ title: "C", body: "c" }] }) });
    const callClaude = async () => asst(toolUse("read_article", { stem: "cur" }));
    const r = await runAgentLoop({ callClaude, ctx: ctx(env), system: "S", userText: "loop", maxSteps: 3 });
    expect(r.steps).toBe(3);
  });
});

describe("runAgentLoop hadError", () => {
  it("flags hadError when a tool returns an error", async () => {
    const env = fakeEnv({ "users/u/articles/cur.json": JSON.stringify({ articles: [{ title: "C", body: "c" }] }) });
    // read_article with a bad stem returns {error:"bad_stem"}; then Claude wraps up.
    const script = [asst(toolUse("read_article", { stem: "../x" })), asst(text("读不了"))];
    let i = 0;
    const r = await runAgentLoop({ callClaude: async () => script[i++], ctx: ctx(env), system: "S", userText: "go" });
    expect(r.hadError).toBe(true);
  });

  it("hadError is false for an all-success chain", async () => {
    const env = fakeEnv({ "users/u/articles/cur.json": JSON.stringify({ articles: [{ title: "C", body: "c" }] }) });
    globalThis.fetch = fakeFetch({
      "PUT https://x/files/api/articles/cur": () => ({ ok: true, body: { ok: true, version: 2 } }),
    });
    const script = [asst(toolUse("write_article", { articles: [{ title: "C2", body: "c2" }] })), asst(text("改好了"))];
    let i = 0;
    const r = await runAgentLoop({ callClaude: async () => script[i++], ctx: ctx(env), system: "S", userText: "go" });
    expect(r.hadError).toBe(false);
  });
});
