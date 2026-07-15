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
function env(seed = [], posts = []) { return { ...fakeD1(seed, posts), SESSION_SECRET: SECRET }; }
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

  // 瀑布流卡片红心数（2026-07-13）：rank 顺路下发每帖被赞总数，0 赞不占键。
  it("rank 返回每帖被赞数 likes（跨用户合计，0 不下发）", async () => {
    const e = env();
    const t1 = await token("users/u1/"), t2 = await token("users/u2/");
    await worker.fetch(req("/reco/engage/hot", { body: { action: "like", on: true }, auth: t1 }), e);
    await worker.fetch(req("/reco/engage/hot", { body: { action: "like", on: true }, auth: t2 }), e);
    const now = Date.now();
    const posts = [
      { shareId: "hot", firstSharedAt: now, author: "A", replyCount: 0 },
      { shareId: "cold", firstSharedAt: now, author: "B", replyCount: 0 },
    ];
    const r = await worker.fetch(req("/reco/rank", { body: { posts }, auth: t1 }), e);
    const j = await r.json();
    expect(j.likes.hot).toBe(2);
    expect(j.likes.cold).toBeUndefined();
  });

  // ── GET /reco/feed（2026-07-14 D1 展示索引合一端点）────────────────────────
  it("feed 返回可见帖（时间倒序）+ 推荐序 + 红心/回应数/我赞过/mine", async () => {
    const now = Date.now();
    const posts = [
      { share_id: "a", owner: "users/u1/", author: "我", title: "甲", preview: "预览甲",
        cover_photo_key: "users/u1/photos/1.jpg", has_photo: 1, article_count: 1,
        first_shared_at: now - 1000, updated_at: now - 1000, reply_to: null, hidden: 0 },
      { share_id: "b", owner: "users/u2/", author: "别人", title: "乙", preview: null,
        cover_photo_key: null, has_photo: 0, article_count: 2,
        first_shared_at: now, updated_at: now, reply_to: "a", hidden: 0 },
      { share_id: "c", owner: "users/u3/", author: "路人", title: "被举报", preview: null,
        cover_photo_key: null, has_photo: 0, article_count: 1,
        first_shared_at: now, updated_at: now, reply_to: null, hidden: 1 },
    ];
    const e = env([], posts);
    const t = await token("users/u1/");
    await worker.fetch(req("/reco/engage/a", { body: { action: "like", on: true }, auth: t }), e);
    const r = await worker.fetch(req("/reco/feed", { method: "GET", auth: t }), e);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.posts.map((p) => p.shareId)).toEqual(["b", "a"]);   // 时间倒序,hidden 的 c 不出现
    const a = j.posts.find((p) => p.shareId === "a");
    expect(a.coverPhotoKey).toBe("users/u1/photos/1.jpg");
    expect(a.hasPhoto).toBe(true);
    expect(a.likes).toBe(1);
    expect(a.liked).toBe(true);
    expect(a.replies).toBe(1);          // b 回应了 a
    expect(a.mine).toBe(true);          // owner == 我的 scope
    const b = j.posts.find((p) => p.shareId === "b");
    expect(b.replyTo).toBe("a");
    expect(b.mine).toBe(false);
    expect(new Set(j.order)).toEqual(new Set(["a", "b"]));       // 推荐序覆盖全部可见帖
  });

  it("feed 每帖带 kind：文章帖 article、提示词帖 prompt", async () => {
    const env = { ...fakeD1([], [
      { share_id: "aaaaaaaaaaaa", owner: "users/u1/", author: "甲", title: "文章帖",
        first_shared_at: 1000, kind: "article", preview: null, cover_photo_key: null, has_photo: 0, article_count: 1, updated_at: 1000, reply_to: null, hidden: 0 },
      { share_id: "bbbbbbbbbbbb", owner: "users/u2/", author: "乙", title: "改毒舌",
        first_shared_at: 2000, kind: "prompt", preview: null, cover_photo_key: null, has_photo: 0, article_count: 1, updated_at: 2000, reply_to: null, hidden: 0 },
    ]), SESSION_SECRET: SECRET };
    const t = await token("users/u1/");
    const resp = await worker.fetch(req("/reco/feed", { method: "GET", auth: t }), env);
    const { posts } = await resp.json();
    const byId = Object.fromEntries(posts.map(p => [p.shareId, p]));
    expect(byId.aaaaaaaaaaaa.kind).toBe("article");
    expect(byId.bbbbbbbbbbbb.kind).toBe("prompt");
  });

  it("feed 无 D1 → 503（app 回退老的 list+rank 路径）", async () => {
    const t = await token("users/u1/");
    const r = await worker.fetch(req("/reco/feed", { method: "GET", auth: t }), { SESSION_SECRET: SECRET });
    expect(r.status).toBe(503);
  });

  // 2026-07-13 事故回归：社区过百帖后 IN (?,?,…) 超出 D1 的 100 参数上限，rank
  // 整条 500（app 静默回退：推荐退化成时间序、红心全 0）。分块后必须扛住 100+。
  it("rank 100+ 帖不炸：IN 查询分块，likes/liked 跨块合并", async () => {
    const e = env();
    const t = await token("users/u1/");
    await worker.fetch(req("/reco/engage/p003", { body: { action: "like", on: true }, auth: t }), e);
    await worker.fetch(req("/reco/engage/p150", { body: { action: "like", on: true }, auth: t }), e);
    const now = Date.now();
    const posts = Array.from({ length: 160 }, (_, i) => (
      { shareId: `p${String(i).padStart(3, "0")}`, firstSharedAt: now, author: "A", replyCount: 0 }
    ));
    const r = await worker.fetch(req("/reco/rank", { body: { posts }, auth: t }), e);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.order.length).toBe(160);
    expect(j.likes.p003).toBe(1);      // 第一块里的赞
    expect(j.likes.p150).toBe(1);      // 第二块里的赞（跨块合并）
    expect(j.liked).toContain("p003");
    expect(j.liked).toContain("p150");
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
