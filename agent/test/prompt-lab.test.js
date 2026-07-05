import { vi, describe, it, expect, afterEach } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { handlePromptLab } from "../src/prompt-lab.js";
import { fakeEnv } from "./fakes.js";

const ADMIN = "admin-token";
const call = (env, path, { method = "GET", token = ADMIN, body } = {}) => {
  const url = new URL(`https://jianshuo.dev${path}`);
  const request = new Request(url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return handlePromptLab(request, env, url);
};

const articleDoc = (title, body) => JSON.stringify({
  head: 1, versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{ title, body }] }],
});

const envWith = (seed = {}) => ({ ...fakeEnv(seed), FILES_TOKEN: ADMIN });

afterEach(() => vi.unstubAllGlobals());

describe("handlePromptLab — 管理 token 门禁", () => {
  it("无 token / 错 token → 401", async () => {
    const env = envWith();
    expect((await call(env, "/agent/prompt-lab/articles", { token: null })).status).toBe(401);
    expect((await call(env, "/agent/prompt-lab/articles", { token: "wrong" })).status).toBe(401);
  });
});

describe("GET /agent/prompt-lab/articles — 真实文章列表", () => {
  it("列出 users/*/articles/*.json，带标题/摘要/图数，坏文档跳过", async () => {
    const env = envWith({
      "users/u1/articles/a.json": articleDoc("第一篇", "正文开头 [[photo:photos/x.jpg]] 后续"),
      "users/u1/articles/b.json": "{oops",
      "users/u1/photos/x.jpg": "binary",
    });
    const res = await call(env, "/agent/prompt-lab/articles");
    expect(res.status).toBe(200);
    const { articles } = await res.json();
    expect(articles.length).toBe(1);
    expect(articles[0].title).toBe("第一篇");
    expect(articles[0].photos).toBe(1);
    expect(articles[0].snippet).not.toContain("[[photo:");
  });
});

describe("paint 代理 — token 不下发，透传任务", () => {
  it("POST 转发 /api/jobs 带 Bearer PAINT_API_TOKEN，回 job_id", async () => {
    const seen = [];
    vi.stubGlobal("fetch", async (u, init) => {
      seen.push({ u: String(u), auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return { status: 202, json: async () => ({ job_id: "j-1" }) };
    });
    const env = { ...envWith(), PAINT_API_TOKEN: "paint-secret" };
    const res = await call(env, "/agent/prompt-lab/paint", { method: "POST", body: { prompt: "画一张题图" } });
    expect(res.status).toBe(200);
    expect((await res.json()).job_id).toBe("j-1");
    expect(seen[0].u).toBe("https://paint.jianshuo.dev/api/jobs");
    expect(seen[0].auth).toBe("Bearer paint-secret");
    expect(seen[0].body.size).toBe("1536x1024");
  });

  it("POST 缺 prompt → 400；paint 挂了 → 502", async () => {
    const env = envWith();
    expect((await call(env, "/agent/prompt-lab/paint", { method: "POST", body: {} })).status).toBe(400);
    vi.stubGlobal("fetch", async () => { throw new Error("down"); });
    expect((await call(env, "/agent/prompt-lab/paint", { method: "POST", body: { prompt: "x" } })).status).toBe(502);
  });

  it("GET /paint/<id> 透传状态", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 200, json: async () => ({ status: "done", result_url: "https://paint.jianshuo.dev/results/j-1.jpg" }) }));
    const res = await call(envWith(), "/agent/prompt-lab/paint/j-1");
    expect((await res.json()).result_url).toContain("/results/j-1.jpg");
  });
});
