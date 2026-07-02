// test/style-extract-route.test.js
// Route-level coverage for POST /agent/style/extract (agent/src/index.js), the
// dispatch block that wraps the pure `distillStyle` (see style-extract.test.js)
// with auth, the R2 corpus read, the Anthropic call, writeStyleDoc, and the
// optional clearAfter cleanup. vi.mock is hoisted before static imports, so this
// keeps the real `agents` package (cloudflare:workers/cloudflare:email) out of
// the test — same pattern as usage_edit.test.js / usage_routes.test.js.
import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import worker from "../src/index.js";
import { fakeEnv } from "./fakes.js";

const TOKEN = "anon_" + "s".repeat(28);

async function scopeFor(token) {
  const { anonScopeFromToken } = await import("../../functions/lib/auth.js");
  return anonScopeFromToken(token);
}

function req(body, { token = TOKEN } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return new Request("https://jianshuo.dev/agent/style/extract", {
    method: "POST", headers, body: JSON.stringify(body ?? {}),
  });
}

function mockClaudeFetch(text = "偏口语、短句。") {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } }),
    text: async () => "",
  }));
}

describe("POST /agent/style/extract", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("401s with no/invalid token", async () => {
    const env = { ...fakeEnv(), CLAUDE_API_KEY: "k" };
    const res = await worker.fetch(req({}, { token: "" }), env);
    expect(res.status).toBe(401);
  });

  it("400 empty-dataset when the caller's style/ corpus is empty", async () => {
    const env = { ...fakeEnv(), CLAUDE_API_KEY: "k" };
    vi.stubGlobal("fetch", mockClaudeFetch());
    const res = await worker.fetch(req({}), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty-dataset" });
  });

  it("400 insufficient-corpus when the corpus is only title-level fragments (anon-15 回归：书名蒸不出风格)", async () => {
    const scope = await scopeFor(TOKEN);
    const env = { ...fakeEnv(), CLAUDE_API_KEY: "k" };
    env.FILES._store.set(`${scope}style/a1.json`, JSON.stringify({ id: "a1", title: "送你一颗子弹", text: "《送你一颗子弹》" }));
    const spy = mockClaudeFetch();
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(req({}), env);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("insufficient-corpus");
    expect(body.min).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();                                  // 没打 Claude
    expect(env.FILES._store.has(`${scope}CLAUDE.json`)).toBe(false);     // 没写风格版本
    expect(env.FILES._store.has(`${scope}style/a1.json`)).toBe(true);    // 语料保留
  });

  it("happy path (sync fallback endpoint): distills the corpus + writes a new CLAUDE.json version", async () => {
    const scope = await scopeFor(TOKEN);
    const env = { ...fakeEnv(), CLAUDE_API_KEY: "k" };
    env.FILES._store.set(`${scope}style/a1.json`, JSON.stringify({ id: "a1", title: "样本一", text: "我写东西偏口语。".repeat(40) }));   // ≥ MIN_CORPUS_CHARS
    vi.stubGlobal("fetch", mockClaudeFetch("偏口语、短句、少形容词。"));

    const res = await worker.fetch(req({}), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    const doc = JSON.parse(env.FILES._store.get(`${scope}CLAUDE.json`));
    expect(doc.head).toBe(1);
    // style now = "<name>\n<Style Card>" (a dedicated naming call prepends a ≤5-char name)
    expect(doc.versions[0].style).toContain("偏口语、短句、少形容词。");
    expect(doc.versions[0].style.split("\n").length).toBeGreaterThan(1);   // name line + card
    expect(doc.versions[0].source).toBe("share-extract");
  });

  it("clearAfter:true deletes the corpus after the write; clearAfter:false retains it", async () => {
    const scope = await scopeFor(TOKEN);

    // clearAfter: true
    {
      const env = { ...fakeEnv(), CLAUDE_API_KEY: "k" };
      env.FILES._store.set(`${scope}style/a1.json`, JSON.stringify({ id: "a1", title: "t", text: "样本文本，凑够充足性硬闸的字数。".repeat(25) }));
      vi.stubGlobal("fetch", mockClaudeFetch());
      const res = await worker.fetch(req({ clearAfter: true }), env);
      expect(res.status).toBe(200);
      expect(env.FILES._store.has(`${scope}style/a1.json`)).toBe(false);
      expect(env.FILES._store.has(`${scope}CLAUDE.json`)).toBe(true); // write survives the clear
    }

    // clearAfter: false (default) — corpus retained
    {
      const env = { ...fakeEnv(), CLAUDE_API_KEY: "k" };
      env.FILES._store.set(`${scope}style/a1.json`, JSON.stringify({ id: "a1", title: "t", text: "样本文本，凑够充足性硬闸的字数。".repeat(25) }));
      vi.stubGlobal("fetch", mockClaudeFetch());
      const res = await worker.fetch(req({ clearAfter: false }), env);
      expect(res.status).toBe(200);
      expect(env.FILES._store.has(`${scope}style/a1.json`)).toBe(true);
    }
  });
});
