import { describe, it, expect } from "vitest";
import { parseAssistant, runAgentLoop } from "../src/loop.js";
import { fakeEnv } from "./fakes.js";

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
  it("chains list -> read -> read -> write to merge, then stops", async () => {
    const env = fakeEnv({
      "users/u/articles/cur.json": JSON.stringify({ schema: 2, transcript: "T", articles: [{ title: "Cur", body: "c" }] }),
      "users/u/articles/old.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "", articles: [{ title: "Old", body: "o" }] }),
    });
    // Scripted Claude: one tool per turn, then a final text turn (no tools).
    const script = [
      asst(toolUse("list_articles", {})),
      asst(toolUse("read_article", { stem: "old" })),
      asst(toolUse("write_article", { articles: [{ title: "Merged", body: "c\n\no" }] })),
      asst(text("合并好了")),
    ];
    let i = 0;
    const callClaude = async () => script[i++];
    const r = await runAgentLoop({ callClaude, ctx: ctx(env), system: "S", userText: "把 old 合并进来" });
    expect(r.calledTools).toEqual(["list_articles", "read_article", "write_article"]);
    expect(r.finalText).toBe("合并好了");
    const doc = JSON.parse(env.FILES._store.get("users/u/articles/cur.json"));
    expect(doc.articles[0].title).toBe("Merged");
  });

  it("handles an action-only turn (publish) with no write", async () => {
    const env = fakeEnv({ "users/u/articles/cur.json": JSON.stringify({ articles: [{ title: "C", body: "c" }] }) });
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, created: 1 }) }));
    const script = [asst(toolUse("publish_wechat", {})), asst(text("已发草稿"))];
    let i = 0;
    const r = await runAgentLoop({ callClaude: async () => script[i++], ctx: ctx(env), system: "S", userText: "发公众号" });
    expect(r.calledTools).toEqual(["publish_wechat"]);
    expect(r.finalText).toBe("已发草稿");
    delete globalThis.fetch;
  });

  it("stops at maxSteps even if Claude never yields", async () => {
    const env = fakeEnv({ "users/u/articles/cur.json": JSON.stringify({ articles: [{ title: "C", body: "c" }] }) });
    const callClaude = async () => asst(toolUse("read_article", { stem: "cur" }));
    const r = await runAgentLoop({ callClaude, ctx: ctx(env), system: "S", userText: "loop", maxSteps: 3 });
    expect(r.steps).toBe(3);
  });
});
