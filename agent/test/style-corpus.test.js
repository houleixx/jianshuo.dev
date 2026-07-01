import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";
import { sha256hex } from "../../functions/lib/auth.js";

// 与 style-api.test.js 同一套写法（同一个 action==='style' 路由块）——匿名能力
// token 走用户 scope，admin token 走 /style/<sub>/... 的管理员路径。
const TOKEN = "anon_" + "s".repeat(28);
async function anonScope(token) {
  return `users/anon-${(await sha256hex(token)).slice(0, 32)}/`;
}

function reqCtx(method, segments, { token = TOKEN, body } = {}) {
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { request, env, params: { path: segments } };
}

describe("POST /style/collect", () => {
  it("writes a corpus sample keyed by id and returns {ok, id}", async () => {
    const ctx = reqCtx("POST", ["style", "collect"], {
      body: { type: "web", title: "远程团队一致性", text: "正文……", source: "sspai.com" },
    });
    const scope = await anonScope(TOKEN);
    const res = await onRequest(ctx);
    expect(res.status).toBe(200);
    const { ok, id } = await res.json();
    expect(ok).toBe(true);
    expect(id).toBeTruthy();

    const stored = JSON.parse(ctx.env.FILES._store.get(`${scope}style/${id}.json`));
    expect(stored).toMatchObject({
      id, type: "web", title: "远程团队一致性", source: "sspai.com", text: "正文……",
    });
    expect(stored.chars).toBe([..."正文……"].length);
    expect(typeof stored.collectedAt).toBe("string");
  });

  it("rejects empty/blank text with 400", async () => {
    const res1 = await onRequest(reqCtx("POST", ["style", "collect"], { body: { text: "" } }));
    expect(res1.status).toBe(400);
    const res2 = await onRequest(reqCtx("POST", ["style", "collect"], { body: { text: "   " } }));
    expect(res2.status).toBe(400);
    const res3 = await onRequest(reqCtx("POST", ["style", "collect"], { body: {} }));
    expect(res3.status).toBe(400);
  });
});

describe("GET /style/dataset", () => {
  it("lists sample metadata newest-first, without the full text", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    const scope = await anonScope(TOKEN);
    // Seed two "new-shape" samples out of order.
    env.FILES._store.set(`${scope}style/a1.json`, JSON.stringify({
      id: "a1", type: "web", title: "旧一点", chars: 4, source: "s1", text: "文本1", collectedAt: "2026-01-01T00:00:00.000Z",
    }));
    env.FILES._store.set(`${scope}style/a2.json`, JSON.stringify({
      id: "a2", type: "text", title: "新一点", chars: 4, source: "s2", text: "文本2", collectedAt: "2026-02-01T00:00:00.000Z",
    }));
    const res = await onRequest({
      request: new Request("https://jianshuo.dev/files/api/style/dataset", { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } }),
      env, params: { path: ["style", "dataset"] },
    });
    expect(res.status).toBe(200);
    const ds = await res.json();
    expect(ds.count).toBe(2);
    expect(ds.items.map((i) => i.id)).toEqual(["a2", "a1"]); // newest-first
    expect(ds.items[0]).toMatchObject({ id: "a2", type: "text", title: "新一点", source: "s2" });
    expect(ds.items[0].chars).toBeGreaterThan(0);
    expect(ds.items[0].text).toBeUndefined();
    expect(ds.totalChars).toBe(8);
  });

  it("tolerates legacy miner-written samples lacking id/chars/title", async () => {
    // Shape written by collectStyle() in agent/src/miner.js: {stem,sourceFile,type,needsExtraction,collectedAt,text}
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    const scope = await anonScope(TOKEN);
    env.FILES._store.set(`${scope}style/VoiceDrop-legacy-stem.json`, JSON.stringify({
      stem: "VoiceDrop-legacy-stem", sourceFile: "notes.md", type: "md", needsExtraction: false,
      collectedAt: "2026-03-01T00:00:00.000Z", text: "老样本正文",
    }));
    const res = await onRequest({
      request: new Request("https://jianshuo.dev/files/api/style/dataset", { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } }),
      env, params: { path: ["style", "dataset"] },
    });
    const ds = await res.json();
    expect(ds.count).toBe(1);
    expect(ds.items[0].id).toBe("VoiceDrop-legacy-stem"); // derived from the object key basename
    expect(ds.items[0].title).toBe("notes.md");           // falls back to sourceFile
    expect(ds.items[0].chars).toBe([..."老样本正文"].length); // derived from text length
    expect(ds.items[0].text).toBeUndefined();
  });

  it("returns an empty dataset when no samples exist yet", async () => {
    const res = await onRequest(reqCtx("GET", ["style", "dataset"]));
    expect(res.status).toBe(200);
    const ds = await res.json();
    expect(ds).toMatchObject({ items: [], count: 0, totalChars: 0 });
  });
});

describe("DELETE /style/dataset", () => {
  it("clears all corpus samples for the caller's scope and reports how many", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    const scope = await anonScope(TOKEN);
    env.FILES._store.set(`${scope}style/a1.json`, JSON.stringify({ id: "a1", type: "text", title: "t1", chars: 1, source: "", text: "x", collectedAt: "2026-01-01" }));
    env.FILES._store.set(`${scope}style/a2.json`, JSON.stringify({ id: "a2", type: "text", title: "t2", chars: 1, source: "", text: "y", collectedAt: "2026-01-02" }));

    const del = await onRequest({
      request: new Request("https://jianshuo.dev/files/api/style/dataset", { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } }),
      env, params: { path: ["style", "dataset"] },
    });
    expect(del.status).toBe(200);
    const delBody = await del.json();
    expect(delBody.ok).toBe(true);
    expect(delBody.deleted).toBe(2);
    expect(env.FILES._store.has(`${scope}style/a1.json`)).toBe(false);
    expect(env.FILES._store.has(`${scope}style/a2.json`)).toBe(false);

    const after = await onRequest({
      request: new Request("https://jianshuo.dev/files/api/style/dataset", { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } }),
      env, params: { path: ["style", "dataset"] },
    });
    expect((await after.json()).count).toBe(0);
  });

  it("does not touch CLAUDE.json (the 文风 doc itself)", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    const scope = await anonScope(TOKEN);
    env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 1, createdAt: 1, updatedAt: 1,
      versions: [{ v: 1, savedAt: 1, source: "app", style: "我的文风" }],
    }));
    env.FILES._store.set(`${scope}style/a1.json`, JSON.stringify({ id: "a1", type: "text", title: "t1", chars: 1, source: "", text: "x", collectedAt: "2026-01-01" }));

    await onRequest({
      request: new Request("https://jianshuo.dev/files/api/style/dataset", { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } }),
      env, params: { path: ["style", "dataset"] },
    });
    expect(env.FILES._store.has(`${scope}CLAUDE.json`)).toBe(true);
  });
});

describe("admin path /style/<sub>/collect + /style/<sub>/dataset", () => {
  it("targets the given user's scope, mirroring /style/<sub> for history/head", async () => {
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    const collectReq = new Request("https://jianshuo.dev/files/api/style/someuser/collect", {
      method: "POST", headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
      body: JSON.stringify({ text: "admin 写入的样本" }),
    });
    const c = await onRequest({ request: collectReq, env, params: { path: ["style", "someuser", "collect"] } });
    expect(c.status).toBe(200);
    const { id } = await c.json();
    expect(env.FILES._store.has(`users/someuser/style/${id}.json`)).toBe(true);

    const dsReq = new Request("https://jianshuo.dev/files/api/style/someuser/dataset", {
      method: "GET", headers: { Authorization: "Bearer admin" },
    });
    const d = await onRequest({ request: dsReq, env, params: { path: ["style", "someuser", "dataset"] } });
    const ds = await d.json();
    expect(ds.count).toBe(1);
  });
});
