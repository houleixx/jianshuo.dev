// test/xhs-pack-route.test.js
// Route-level coverage for POST /agent/xhs-pack (agent/src/index.js + src/xhs.js):
// auth, stem validation, article read, direct-vs-rewrite routing (XHS_DIRECT_MAX),
// the Anthropic calls, JSON parsing (incl. code-fence tolerance), tag
// normalization, and photoKeys extraction. Same vi.mock("agents") pattern as
// style-extract-route.test.js.
import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import worker from "../src/index.js";
import { fakeEnv } from "./fakes.js";
import { extractPhotoKeys, stripPhotoMarkers, XHS_DIRECT_MAX } from "../src/xhs.js";

const TOKEN = "anon_" + "s".repeat(28);

async function scopeFor(token) {
  const { anonScopeFromToken } = await import("../../functions/lib/auth.js");
  return anonScopeFromToken(token);
}

function req(body, { token = TOKEN } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return new Request("https://jianshuo.dev/agent/xhs-pack", {
    method: "POST", headers, body: JSON.stringify(body ?? {}),
  });
}

const PACK = { title: "在东京修好了一台图片服务", body: "今天把 401 修了。\n\n原因是 token 轮换。", tags: ["#Claude", "独立开发"] };

function mockClaudeFetch(text, { ok = true, status = 200 } = {}) {
  return vi.fn(async () => ({
    ok, status,
    json: async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } }),
    text: async () => "",
  }));
}

const SHORT_BODY = "第一段。\n\n[[photo:photos/2026/a.jpg]]\n\n第二段。\n\n[[photo:photos/2026/b.png]]";

async function seededEnv(body = SHORT_BODY, title = "原标题") {
  const scope = await scopeFor(TOKEN);
  const env = { ...fakeEnv(), CLAUDE_API_KEY: "k" };
  env.FILES._store.set(`${scope}articles/rec1.json`, JSON.stringify({
    schema: 2, articles: [{ title, body }],
  }));
  return env;
}

describe("POST /agent/xhs-pack", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("401s with no token", async () => {
    const res = await worker.fetch(req({ stem: "rec1" }, { token: "" }), { ...fakeEnv(), CLAUDE_API_KEY: "k" });
    expect(res.status).toBe(401);
  });

  it("400s on a path-traversal stem", async () => {
    const res = await worker.fetch(req({ stem: "a/../b" }), await seededEnv());
    expect(res.status).toBe(400);
  });

  it("404s on unknown stem", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch("{}"));
    const res = await worker.fetch(req({ stem: "nope" }), await seededEnv());
    expect(res.status).toBe(404);
  });

  it("direct 模式：短文原文照发（photo 标记已剥），只出标签", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch(JSON.stringify({ tags: ["#东京", "独立开发"] })));
    const res = await worker.fetch(req({ stem: "rec1" }), await seededEnv());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.mode).toBe("direct");
    expect(j.title).toBe("原标题");
    expect(j.body).toBe("第一段。\n\n第二段。");
    expect(j.tags).toEqual(["东京", "独立开发"]);
    expect(j.photoKeys).toEqual(["photos/2026/a.jpg", "photos/2026/b.png"]);
  });

  it("direct 模式：标题超 20 字裁到 20", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch(JSON.stringify({ tags: [] })));
    const long = "这是一个特别特别特别特别特别长的标题超过二十个字";
    const res = await worker.fetch(req({ stem: "rec1" }), await seededEnv(SHORT_BODY, long));
    const j = await res.json();
    expect([...j.title].length).toBe(20);
  });

  it("direct 模式：标签调用失败不拦路，tags 为空数组", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch("", { ok: false, status: 500 }));
    const res = await worker.fetch(req({ stem: "rec1" }), await seededEnv());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.mode).toBe("direct");
    expect(j.tags).toEqual([]);
    expect(j.body).toBe("第一段。\n\n第二段。");
  });

  it("rewrite 模式：超长文走 sonnet 改写（容忍 ```json 围栏）", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch("```json\n" + JSON.stringify(PACK) + "\n```"));
    const long = "长".repeat(XHS_DIRECT_MAX + 1);
    const res = await worker.fetch(req({ stem: "rec1" }), await seededEnv(long));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.mode).toBe("rewrite");
    expect(j.title).toBe(PACK.title);
    expect(j.tags).toEqual(["Claude", "独立开发"]);
  });

  it("rewrite 模式：非 JSON 输出 422", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch("我写不出来。"));
    const long = "长".repeat(XHS_DIRECT_MAX + 1);
    const res = await worker.fetch(req({ stem: "rec1" }), await seededEnv(long));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("bad_llm_output");
  });
});

describe("xhs helpers", () => {
  it("extractPhotoKeys pulls keys in order and returns [] when none", () => {
    expect(extractPhotoKeys("a [[photo:x/1.jpg]] b [[photo:y/2.png]]")).toEqual(["x/1.jpg", "y/2.png"]);
    expect(extractPhotoKeys("no markers")).toEqual([]);
    expect(extractPhotoKeys("")).toEqual([]);
  });

  it("stripPhotoMarkers removes markers and collapses blank lines", () => {
    expect(stripPhotoMarkers("a\n\n[[photo:x/1.jpg]]\n\nb")).toBe("a\n\nb");
    expect(stripPhotoMarkers("[[photo:x/1.jpg]]")).toBe("");
    expect(stripPhotoMarkers("纯文本")).toBe("纯文本");
  });
});
