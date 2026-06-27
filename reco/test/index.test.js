import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { fakeD1 } from "./fakes.js";
import { hmacSign } from "../src/auth.js";

const SECRET = "test-secret";
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function token(scope) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({ scope, apple: true, iat: now, exp: now + 3600 }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}
function env(seed = []) { return { ...fakeD1(seed), SESSION_SECRET: SECRET }; }
function req(path, { method = "POST", body, auth } = {}) {
  return new Request("https://jianshuo.dev" + path, {
    method,
    headers: { ...(auth ? { Authorization: "Bearer " + auth } : {}), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("reco worker", () => {
  it("无 token → 401", async () => {
    const r = await worker.fetch(req("/reco/rank", { body: { posts: [] } }), env());
    expect(r.status).toBe(401);
  });

  it("engage view 写入,rank 把高互动帖排前", async () => {
    const e = env();
    const t = await token("users/u1/");
    await worker.fetch(req("/reco/engage/y", { body: { action: "like", on: true }, auth: t }), e);
    const now = Date.now();
    const posts = [
      { shareId: "x", firstSharedAt: now, author: "A", replyCount: 0 },
      { shareId: "y", firstSharedAt: now, author: "B", replyCount: 0 },
    ];
    const r = await worker.fetch(req("/reco/rank", { body: { posts }, auth: t }), e);
    const j = await r.json();
    expect(j.order[0]).toBe("y");
  });

  it("rank 返回我赞过的 shareId", async () => {
    const e = env();
    const t = await token("users/u1/");
    await worker.fetch(req("/reco/engage/z", { body: { action: "like", on: true }, auth: t }), e);
    const now = Date.now();
    const r = await worker.fetch(req("/reco/rank", {
      body: { posts: [{ shareId: "z", firstSharedAt: now, author: "A", replyCount: 0 }] }, auth: t,
    }), e);
    const j = await r.json();
    expect(j.liked).toContain("z");
  });

  it("engage report 被接受并写入,rank 把被举报帖排到最后", async () => {
    const e = env();
    const t = await token("users/u1/");
    const ra = await worker.fetch(req("/reco/engage/bad", { body: { action: "report" }, auth: t }), e);
    expect(ra.status).toBe(200);
    const now = Date.now();
    const posts = [
      { shareId: "good", firstSharedAt: now, author: "A", replyCount: 0 },
      { shareId: "bad", firstSharedAt: now, author: "B", replyCount: 0 },
    ];
    const r = await worker.fetch(req("/reco/rank", { body: { posts }, auth: t }), e);
    const j = await r.json();
    expect(j.order[j.order.length - 1]).toBe("bad");
  });

  it("env.DB 缺失 → rank 不崩,按输入序返回", async () => {
    const t = await token("users/u1/");
    const now = Date.now();
    const r = await worker.fetch(req("/reco/rank", {
      body: { posts: [{ shareId: "a", firstSharedAt: now, author: "A", replyCount: 0 }] }, auth: t,
    }), { SESSION_SECRET: SECRET });   // 没有 DB
    const j = await r.json();
    expect(j.order).toEqual(["a"]);
  });
});
