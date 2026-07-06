// test/xhs-pack-route.test.js
// Route-level coverage for POST /agent/xhs-pack (agent/src/index.js + src/xhs.js):
// auth, stem validation, article read, the Anthropic call, JSON parsing (incl.
// code-fence tolerance), tag normalization, and photoKeys extraction. Same
// vi.mock("agents") pattern as style-extract-route.test.js.
import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({
  Agent: class Agent {},
  getAgentByName: async () => ({}),
}));
import worker from "../src/index.js";
import { fakeEnv } from "./fakes.js";
import { extractPhotoKeys } from "../src/xhs.js";

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

function mockClaudeFetch(text = JSON.stringify(PACK)) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } }),
    text: async () => "",
  }));
}

async function seededEnv(body = "第一段。\n\n[[photo:photos/2026/a.jpg]]\n\n第二段。\n\n[[photo:photos/2026/b.png]]") {
  const scope = await scopeFor(TOKEN);
  const env = { ...fakeEnv(), CLAUDE_API_KEY: "k" };
  env.FILES._store.set(`${scope}articles/rec1.json`, JSON.stringify({
    schema: 2, articles: [{ title: "原标题", body }],
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
    vi.stubGlobal("fetch", mockClaudeFetch());
    const res = await worker.fetch(req({ stem: "nope" }), await seededEnv());
    expect(res.status).toBe(404);
  });

  it("returns the pack: title/body/tags (# stripped) + photoKeys in order", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch());
    const res = await worker.fetch(req({ stem: "rec1" }), await seededEnv());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.title).toBe(PACK.title);
    expect(j.body).toBe(PACK.body);
    expect(j.tags).toEqual(["Claude", "独立开发"]);
    expect(j.photoKeys).toEqual(["photos/2026/a.jpg", "photos/2026/b.png"]);
  });

  it("tolerates a ```json code fence around the model output", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch("```json\n" + JSON.stringify(PACK) + "\n```"));
    const res = await worker.fetch(req({ stem: "rec1" }), await seededEnv());
    expect(res.status).toBe(200);
    expect((await res.json()).title).toBe(PACK.title);
  });

  it("422s on non-JSON model output", async () => {
    vi.stubGlobal("fetch", mockClaudeFetch("我写不出来。"));
    const res = await worker.fetch(req({ stem: "rec1" }), await seededEnv());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("bad_llm_output");
  });
});

describe("extractPhotoKeys", () => {
  it("pulls keys in order and returns [] when none", () => {
    expect(extractPhotoKeys("a [[photo:x/1.jpg]] b [[photo:y/2.png]]")).toEqual(["x/1.jpg", "y/2.png"]);
    expect(extractPhotoKeys("no markers")).toEqual([]);
    expect(extractPhotoKeys("")).toEqual([]);
  });
});
