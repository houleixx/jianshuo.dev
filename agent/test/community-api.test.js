import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv, fakeRecoD1 } from "./fakes.js";
import { b64url, b64urlToString, hmacSign } from "../../functions/lib/auth.js";

// The VD社区 (community) surface had NO test coverage, yet it carries the most
// legacy branches in the whole Files API: schema-1 inline posts written by old
// builds, the legacy `photos` array, and the [[photo:N]] markers that ride in
// their bodies. A future build (94) must keep reading all of them. These pin the
// cross-version contract: an old community post never 404s, a live schema-2
// pointer always reflects the source article, and the Apple write-gate stays put.

const SECRET = "secret";

// Generic request context with an arbitrary bearer token (admin by default).
function reqCtx(method, segments, { token = "admin", body, headers: extraHeaders = {}, env: extraEnv = {} } = {}) {
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: SECRET, ...extraEnv };
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, extraHeaders);
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { request, env, params: { path: segments } };
}

// A real signed session JWT (matches mintSession: {scope, apple, exp}).
async function session(scope, { apple = true, wechat = false } = {}) {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({ scope, apple, wechat, exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${h}.${p}.${await hmacSign(`${h}.${p}`, SECRET)}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The server's own shareId derivation (HMAC of the article key, first 12 chars).
async function shareIdFor(articleKey) {
  return (await hmacSign("community:" + articleKey, SECRET)).slice(0, 12);
}

// A live schema-3 article doc on disk.
function schema3(title, extra = {}) {
  return JSON.stringify({
    schema: 3, createdAt: 1000, head: 1,
    versions: [{ v: 1, savedAt: 1000, source: "mine", articles: [{ title, body: `body of ${title}` }] }],
    ...extra,
  });
}

// ── GET community/get — read one post across every stored shape ───────────────

describe("GET community/get/<id>", () => {
  it("legacy schema-1 inline post (no articleKey) is read verbatim, markers + photos kept", async () => {
    const context = reqCtx("GET", ["community", "get", "leg100000001"]);
    context.env.FILES._store.set("community/leg100000001.json", JSON.stringify({
      schema: 1, shareId: "leg100000001", author: "王建硕", title: "老帖标题",
      articles: [{ title: "老帖标题", body: "正文 [[photo:1]]" }],
      photos: ["photos/s/a.jpg"], firstSharedAt: 3000,
    }));
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.title).toBe("老帖标题");
    expect(body.articles[0].body).toContain("[[photo:1]]");   // marker survives for legacy resolution
    expect(body.photos).toEqual(["photos/s/a.jpg"]);          // legacy photos array passed through
  });

  it("schema-2 pointer resolves the LIVE article (edits show immediately)", async () => {
    const context = reqCtx("GET", ["community", "get", "ptr100000001"]);
    context.env.FILES._store.set("users/u/articles/s1.json", schema3("Live标题"));
    context.env.FILES._store.set("community/ptr100000001.json", JSON.stringify({
      schema: 2, shareId: "ptr100000001", owner: "users/u/",
      articleKey: "users/u/articles/s1.json", author: "作者", firstSharedAt: 5000,
    }));
    const body = await (await onRequest(context)).json();
    expect(body.title).toBe("Live标题");        // read live, not from a frozen copy
    expect(body.owner).toBe("users/u/");        // owner = photo prefix for the client
    expect(body.photos).toBeUndefined();        // new posts carry no legacy photos array
  });

  it("schema-2 pointer to a legacy v1 source doc still renders", async () => {
    const context = reqCtx("GET", ["community", "get", "ptrv10000001"]);
    // The SOURCE article is the original v1 shape (top-level title/body, no versions).
    context.env.FILES._store.set("users/u/articles/old.json", JSON.stringify({
      version: 1, title: "V1帖", body: "v1 正文",
    }));
    context.env.FILES._store.set("community/ptrv10000001.json", JSON.stringify({
      schema: 2, shareId: "ptrv10000001", owner: "users/u/",
      articleKey: "users/u/articles/old.json", author: "作者", firstSharedAt: 6000,
    }));
    const body = await (await onRequest(context)).json();
    expect(body.title).toBe("V1帖");
    expect(body.articles[0].body).toBe("v1 正文");
  });

  it("404s when the pointer's source article was deleted (orphan)", async () => {
    const context = reqCtx("GET", ["community", "get", "gone00000001"]);
    context.env.FILES._store.set("community/gone00000001.json", JSON.stringify({
      schema: 2, shareId: "gone00000001", owner: "users/u/",
      articleKey: "users/u/articles/missing.json", author: "x", firstSharedAt: 1,
    }));
    expect((await onRequest(context)).status).toBe(404);
  });

  // 提示词社区帖（Task 5，2026-07-15）：内容零复制，实时读 shares/<码> 写穿副本。
  it("community/get 对提示词帖返回合成 articles + kind + promptCode + appliesTo", async () => {
    const context = reqCtx("GET", ["community", "get", "prm100000001"]);
    context.env.FILES._store.set("shares/4563566", JSON.stringify({
      type: "prompt", sub: "u", itemId: "p_1", label: "口语化",
      instruction: "把这段改得更口语", appliesTo: ["text"],
    }));
    context.env.FILES._store.set("community/prm100000001.json", JSON.stringify({
      schema: 2, shareId: "prm100000001", owner: "users/u/", kind: "prompt",
      promptCode: "4563566", author: "王建硕", firstSharedAt: 5000,
    }));
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.articles).toEqual([{ title: "口语化", body: "把这段改得更口语" }]);
    expect(body.kind).toBe("prompt");
    expect(body.promptCode).toBe("4563566");
    expect(body.appliesTo).toEqual(["text"]);
    expect(body.owner).toBe("users/u/");
  });

  it("community/get：提示词码已失效（shares/<码> 没了）→ 404 且帖被自愈清掉", async () => {
    const db = fakeRecoD1();
    db._posts.set("prm200000001", { share_id: "prm200000001", owner: "users/u/", hidden: 0, kind: "prompt" });
    const context = reqCtx("GET", ["community", "get", "prm200000001"], { env: { RECO_DB: db } });
    context.env.FILES._store.set("community/prm200000001.json", JSON.stringify({
      schema: 2, shareId: "prm200000001", owner: "users/u/", kind: "prompt",
      promptCode: "7654321", author: "王建硕", firstSharedAt: 5000,
    }));
    const resp = await onRequest(context);
    expect(resp.status).toBe(404);
    expect(context.env.FILES._store.has("community/prm200000001.json")).toBe(false);
    expect(db._posts.has("prm200000001")).toBe(false);
  });
});

// ── GET community/list — mixed schemas, ordering, self-heal ───────────────────

describe("GET community/list", () => {
  it("mixes schema-1 + schema-2 posts newest-first and drops a reaped orphan", async () => {
    const context = reqCtx("GET", ["community", "list"]);
    const env = context.env;
    // schema-1 legacy inline post (older)
    env.FILES._store.set("community/leg000000001.json", JSON.stringify({
      schema: 1, shareId: "leg000000001", author: "A", title: "老帖",
      articles: [{ title: "老帖", body: "x" }], firstSharedAt: 3000,
    }));
    // schema-2 live pointer (newer)
    env.FILES._store.set("users/u/articles/s1.json", schema3("新帖"));
    env.FILES._store.set("community/ptr000000001.json", JSON.stringify({
      schema: 2, shareId: "ptr000000001", owner: "users/u/",
      articleKey: "users/u/articles/s1.json", author: "B", firstSharedAt: 5000,
    }));
    // orphan: source article + audio both gone → reaped + dropped
    env.FILES._store.set("community/orphan000001.json", JSON.stringify({
      schema: 2, shareId: "orphan000001", owner: "users/u/",
      articleKey: "users/u/articles/gone.json", author: "C", firstSharedAt: 9000,
    }));

    const body = await (await onRequest(context)).json();
    expect(body.posts.map((p) => p.shareId)).toEqual(["ptr000000001", "leg000000001"]);  // newest-first, orphan gone
    expect(body.posts[0].title).toBe("新帖");   // schema-2 title read live
    expect(body.posts[1].title).toBe("老帖");   // schema-1 title from stored copy
    expect(env.FILES._store.has("community/orphan000001.json")).toBe(false); // self-healed
  });

  // 瀑布流卡片素材（2026-07-13）：list 每帖补 hasPhoto/coverPhotoKey/preview，
  // 客户端不用为每张卡再拉一次全文。
  it("photo post carries coverPhotoKey (owner-joined) + hasPhoto + marker-free preview", async () => {
    const context = reqCtx("GET", ["community", "list"]);
    const env = context.env;
    env.FILES._store.set("users/u/articles/p1.json", JSON.stringify({
      schema: 3, createdAt: 1000, head: 1,
      versions: [{ v: 1, savedAt: 1000, source: "mine",
        articles: [{ title: "有图帖", body: "开头一句。[[photo:photos/7/1.jpg]] 后文继续。" }] }],
    }));
    env.FILES._store.set("community/pic000000001.json", JSON.stringify({
      schema: 2, shareId: "pic000000001", owner: "users/u/",
      articleKey: "users/u/articles/p1.json", author: "P", firstSharedAt: 1000,
    }));

    const body = await (await onRequest(context)).json();
    const post = body.posts.find((p) => p.shareId === "pic000000001");
    expect(post.hasPhoto).toBe(true);
    expect(post.coverPhotoKey).toBe("users/u/photos/7/1.jpg");   // owner prefix joined server-side
    expect(post.preview).toContain("开头一句");
    expect(post.preview).not.toContain("[[photo");               // markers stripped from preview
  });

  it("text-only post: hasPhoto=false, no coverPhotoKey; legacy [[photo:N]] resolves via photos array", async () => {
    const context = reqCtx("GET", ["community", "list"]);
    const env = context.env;
    env.FILES._store.set("users/u/articles/t1.json", schema3("纯文帖"));
    env.FILES._store.set("community/txt000000001.json", JSON.stringify({
      schema: 2, shareId: "txt000000001", owner: "users/u/",
      articleKey: "users/u/articles/t1.json", author: "T", firstSharedAt: 2000,
    }));
    // legacy schema-1 with numeric marker + photos array
    env.FILES._store.set("community/leg000000002.json", JSON.stringify({
      schema: 1, shareId: "leg000000002", author: "L", title: "老图帖", owner: "users/v/",
      articles: [{ title: "老图帖", body: "看图 [[photo:1]]" }],
      photos: ["photos/s/a.jpg"], firstSharedAt: 1500,
    }));

    const body = await (await onRequest(context)).json();
    const txt = body.posts.find((p) => p.shareId === "txt000000001");
    expect(txt.hasPhoto).toBe(false);
    expect(txt.coverPhotoKey).toBeUndefined();
    expect(txt.preview).toContain("body of 纯文帖");
    const leg = body.posts.find((p) => p.shareId === "leg000000002");
    expect(leg.hasPhoto).toBe(true);
    expect(leg.coverPhotoKey).toBe("users/v/photos/s/a.jpg");    // 1-based index into photos
  });
});

// ── POST community/share — the Apple write-gate + no-content-copy contract ─────

describe("POST community/share — write gate", () => {
  it("anon (non-Apple) token → 403 needs_apple_signin", async () => {
    const token = "anon_" + "z".repeat(28);
    const context = reqCtx("POST", ["community", "share", "articles", "s1.json"], { token });
    const resp = await onRequest(context);
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("needs_apple_signin");
  });

  it("Android anon token → 403 needs_wechat_signin", async () => {
    const token = "anon_" + "z".repeat(28);
    const context = reqCtx("POST", ["community", "share", "articles", "s1.json"], {
      token,
      headers: { "X-VD-Platform": "android" },
    });
    const resp = await onRequest(context);
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("needs_wechat_signin");
  });

  it("admin token → 403 admin cannot share", async () => {
    const context = reqCtx("POST", ["community", "share", "articles", "s1.json"]);
    const resp = await onRequest(context);
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toBe("admin cannot share");
  });

  it("Apple session writes a schema-2 POINTER (no content copy) and returns shareId", async () => {
    const token = await session("users/u/");
    const context = reqCtx("POST", ["community", "share", "articles", "s1.json"], { token });
    context.env.FILES._store.set("users/u/articles/s1.json", schema3("分享标题"));
    context.env.FILES._store.set("users/u/CLAUDE.md", "# 我的名字\n王建硕\n\n口语点");

    const expectedId = await shareIdFor("users/u/articles/s1.json");
    const body = await (await onRequest(context)).json();
    expect(body.ok).toBe(true);
    expect(body.shareId).toBe(expectedId);

    const stored = JSON.parse(context.env.FILES._store.get(`community/${expectedId}.json`));
    expect(stored.schema).toBe(2);
    expect(stored.owner).toBe("users/u/");
    expect(stored.articleKey).toBe("users/u/articles/s1.json");
    expect(stored.author).toBe("王建硕");        // pulled from CLAUDE.md
    expect(stored.articles).toBeUndefined();      // content is NEVER copied into the post
  });

  it("WeChat session writes a schema-2 POINTER without touching Apple gate", async () => {
    const token = await session("users/u/", { apple: false, wechat: true });
    const context = reqCtx("POST", ["community", "share", "articles", "s1.json"], { token });
    context.env.FILES._store.set("users/u/articles/s1.json", schema3("微信分享标题"));
    context.env.FILES._store.set("users/u/CLAUDE.md", "# 我的名字\n安卓用户\n");

    const expectedId = await shareIdFor("users/u/articles/s1.json");
    const body = await (await onRequest(context)).json();
    expect(body.ok).toBe(true);
    expect(body.shareId).toBe(expectedId);

    const stored = JSON.parse(context.env.FILES._store.get(`community/${expectedId}.json`));
    expect(stored.owner).toBe("users/u/");
    expect(stored.articleKey).toBe("users/u/articles/s1.json");
    expect(stored.author).toBe("安卓用户");
  });

  it("re-sharing preserves the original firstSharedAt", async () => {
    const token = await session("users/u/");
    const context = reqCtx("POST", ["community", "share", "articles", "s1.json"], { token });
    context.env.FILES._store.set("users/u/articles/s1.json", schema3("标题"));
    const id = await shareIdFor("users/u/articles/s1.json");
    context.env.FILES._store.set(`community/${id}.json`, JSON.stringify({
      schema: 2, shareId: id, owner: "users/u/",
      articleKey: "users/u/articles/s1.json", author: "王建硕", firstSharedAt: 1234,
    }));
    await onRequest(context);
    const stored = JSON.parse(context.env.FILES._store.get(`community/${id}.json`));
    expect(stored.firstSharedAt).toBe(1234);
  });
});

// ── POST auth/wechat — Android sign-in, independent from Apple ───────────────

describe("POST auth/wechat", () => {
  const MINI_APP_ID_FIXTURE = "mini-app";
  const MINI_APP_CREDENTIAL_FIXTURE = "fixture-wechat-credential";

  function stubWechatExchange(body) {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      expect(String(url)).toContain("api.weixin.qq.com/sns/oauth2/access_token");
      return {
        ok: true,
        status: 200,
        json: async () => body,
      };
    }));
  }

  it("binds the current anon scope and mints a WeChat-only session", async () => {
    stubWechatExchange({ openid: "open-1", unionid: "union-1", access_token: "at" });
    const anon = "anon_" + "a".repeat(28);
    const context = reqCtx("POST", ["auth", "wechat"], {
      token: anon,
      body: { code: "wx-code", nickname: "安卓用户", avatar: "https://example.com/a.jpg" },
      env: { WECHAT_OPEN_APP_ID: "wx-app", WECHAT_OPEN_APP_SECRET: "wx-secret" },
    });

    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.scope).toMatch(/^users\/anon-[0-9a-f]{32}\/$/);
    expect(context.env.FILES._store.has("links/wechat-unionid-union-1.json")).toBe(true);

    const account = JSON.parse(context.env.FILES._store.get(`${body.scope}ACCOUNT.json`));
    expect(account.wechatUnionid).toBe("union-1");
    expect(account.wechatOpenid).toBe("open-1");
    expect(account.name).toBe("安卓用户");

    const sess = JSON.parse(b64urlToString(body.session.split(".")[1]));
    expect(sess.apple).toBeFalsy();
    expect(sess.wechat).toBe(true);
  });

  it("exchanges Mini Program js_code via jscode2session without changing the auth route", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = new URL(String(url));
      expect(`${u.origin}${u.pathname}`).toBe("https://api.weixin.qq.com/sns/jscode2session");
      expect(u.searchParams.get("appid")).toBe(MINI_APP_ID_FIXTURE);
      expect(u.searchParams.get("secret")).toBe(MINI_APP_CREDENTIAL_FIXTURE);
      expect(u.searchParams.get("js_code")).toBe("mini-code");
      expect(u.searchParams.get("grant_type")).toBe("authorization_code");
      return {
        ok: true,
        status: 200,
        json: async () => ({ openid: "mini-open-1", unionid: "mini-union-1", session_key: "sk" }),
      };
    }));
    const anon = "anon_" + "b".repeat(28);
    const context = reqCtx("POST", ["auth", "wechat"], {
      token: anon,
      body: {
        code: "mini-code",
        platform: "mini_program",
        appid: MINI_APP_ID_FIXTURE,
        nickname: "小程序用户",
        avatar: "https://example.com/mini.jpg",
      },
      env: { WECHAT_MINI_APP_ID: MINI_APP_ID_FIXTURE, WECHAT_MINI_APP_SECRET: MINI_APP_CREDENTIAL_FIXTURE },
    });

    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.scope).toMatch(/^users\/anon-[0-9a-f]{32}\/$/);
    expect(context.env.FILES._store.has("links/wechat-unionid-mini-union-1.json")).toBe(true);

    const account = JSON.parse(context.env.FILES._store.get(`${body.scope}ACCOUNT.json`));
    expect(account.wechatUnionid).toBe("mini-union-1");
    expect(account.wechatOpenid).toBe("mini-open-1");
    expect(account.name).toBe("小程序用户");

    const sess = JSON.parse(b64urlToString(body.session.split(".")[1]));
    expect(sess.wechat).toBe(true);
  });
});

// ── POST community/unshare — owner-only ───────────────────────────────────────

describe("POST community/unshare — owner only", () => {
  function seedPost(env) {
    env.FILES._store.set("community/p10000000001.json", JSON.stringify({
      schema: 2, shareId: "p10000000001", owner: "users/u/",
      articleKey: "users/u/articles/s1.json", author: "王建硕", firstSharedAt: 1,
    }));
  }

  it("a non-owner Apple user gets 403 and the post stays", async () => {
    const token = await session("users/other/");
    const context = reqCtx("POST", ["community", "unshare", "p10000000001"], { token });
    seedPost(context.env);
    const resp = await onRequest(context);
    expect(resp.status).toBe(403);
    expect(context.env.FILES._store.has("community/p10000000001.json")).toBe(true);
  });

  it("the owner deletes their own post", async () => {
    const token = await session("users/u/");
    const context = reqCtx("POST", ["community", "unshare", "p10000000001"], { token });
    seedPost(context.env);
    const resp = await onRequest(context);
    expect(resp.status).toBe(200);
    expect(context.env.FILES._store.has("community/p10000000001.json")).toBe(false);
  });

  it("提示词帖：owner 撤帖连码同死", async () => {
    const token = await session("users/u/");
    const context = reqCtx("POST", ["community", "unshare", "prm300000001"], { token });
    context.env.FILES._store.set("community/prm300000001.json", JSON.stringify({
      schema: 2, shareId: "prm300000001", owner: "users/u/", kind: "prompt",
      promptCode: "1112223", author: "王建硕", firstSharedAt: 1,
    }));
    context.env.FILES._store.set("shares/1112223", JSON.stringify({
      type: "prompt", label: "口语化", instruction: "把这段改得更口语",
    }));
    const resp = await onRequest(context);
    expect(resp.status).toBe(200);
    expect(context.env.FILES._store.has("community/prm300000001.json")).toBe(false);
    expect(context.env.FILES._store.has("shares/1112223")).toBe(false);
  });
});

// ── D1 展示索引双写（2026-07-14）：R2 真源不变，RECO_DB 是 /reco/feed 的物化索引 ──

describe("community D1 index dual-write", () => {
  it("share upserts an index row with cover/preview; unshare deletes it", async () => {
    const token = await session("users/u/");
    const db = fakeRecoD1();
    const ctx1 = reqCtx("POST", ["community", "share", "articles", "s1.json"], { token, env: { RECO_DB: db } });
    ctx1.env.FILES._store.set("users/u/articles/s1.json", JSON.stringify({
      schema: 3, createdAt: 1000, head: 1,
      versions: [{ v: 1, savedAt: 1000, source: "mine",
        articles: [{ title: "有图分享", body: "开头。[[photo:photos/9/1.jpg]] 后文。" }] }],
    }));
    const id = await shareIdFor("users/u/articles/s1.json");
    expect((await (await onRequest(ctx1)).json()).ok).toBe(true);

    const row = db._posts.get(id);
    expect(row.owner).toBe("users/u/");
    expect(row.title).toBe("有图分享");
    expect(row.cover_photo_key).toBe("users/u/photos/9/1.jpg");
    expect(row.has_photo).toBe(1);
    expect(row.preview).toContain("开头");
    expect(row.hidden).toBe(0);

    const ctx2 = reqCtx("POST", ["community", "unshare", id], { token, env: { RECO_DB: db } });
    ctx2.env.FILES._store.set(`community/${id}.json`, JSON.stringify({ shareId: id, owner: "users/u/" }));
    expect((await (await onRequest(ctx2)).json()).ok).toBe(true);
    expect(db._posts.has(id)).toBe(false);
  });

  it("report hides the index row; resolve-restore unhides; resolve-remove deletes", async () => {
    const token = await session("users/u2/");
    const db = fakeRecoD1();
    db._posts.set("rpt000000001", { share_id: "rpt000000001", owner: "users/u/", hidden: 0 });
    const ctx = reqCtx("POST", ["community", "report", "rpt000000001"], { token, env: { RECO_DB: db } });
    ctx.env.FILES._store.set("community/rpt000000001.json", JSON.stringify({ shareId: "rpt000000001", owner: "users/u/" }));
    expect((await (await onRequest(ctx)).json()).ok).toBe(true);
    expect(db._posts.get("rpt000000001").hidden).toBe(1);

    const ctxRestore = reqCtx("POST", ["community", "resolve", "rpt000000001"], { body: { action: "restore" }, env: { RECO_DB: db } });
    expect((await (await onRequest(ctxRestore)).json()).restored).toBe(true);
    expect(db._posts.get("rpt000000001").hidden).toBe(0);

    const ctxRemove = reqCtx("POST", ["community", "resolve", "rpt000000001"], { body: { action: "remove" }, env: { RECO_DB: db } });
    expect((await (await onRequest(ctxRemove)).json()).removed).toBe(true);
    expect(db._posts.has("rpt000000001")).toBe(false);
  });

  it("reindex rebuilds rows from R2 (hidden from report markers) and drops stale rows", async () => {
    const db = fakeRecoD1();
    db._posts.set("stale0000001", { share_id: "stale0000001", owner: "users/x/", hidden: 0 });  // R2 里已不存在
    const context = reqCtx("POST", ["community", "reindex"], { env: { RECO_DB: db } });   // admin token
    const env = context.env;
    env.FILES._store.set("users/u/articles/p1.json", schema3("重建帖"));
    env.FILES._store.set("community/idx000000001.json", JSON.stringify({
      schema: 2, shareId: "idx000000001", owner: "users/u/",
      articleKey: "users/u/articles/p1.json", author: "B", firstSharedAt: 5000,
    }));
    env.FILES._store.set("community/reports/idx000000001.json", JSON.stringify({ status: "pending" }));

    const body = await (await onRequest(context)).json();
    expect(body.ok).toBe(true);
    expect(body.indexed).toBe(1);
    expect(body.removed).toBe(1);                        // stale0000001 被清掉
    const row = db._posts.get("idx000000001");
    expect(row.title).toBe("重建帖");
    expect(row.hidden).toBe(1);                          // report 标记 → hidden
    expect(db._posts.has("stale0000001")).toBe(false);
  });

  it("no RECO_DB binding → community writes still work (index is best-effort)", async () => {
    const token = await session("users/u/");
    const context = reqCtx("POST", ["community", "share", "articles", "s1.json"], { token });
    context.env.FILES._store.set("users/u/articles/s1.json", schema3("无索引分享"));
    const body = await (await onRequest(context)).json();
    expect(body.ok).toBe(true);
  });

  it("indexUpsert 带 kind=prompt 时行的 kind 是 prompt；缺省是 article", async () => {
    const token = await session("users/u/");
    const db = fakeRecoD1();
    // 普通分享（无 kind）→ 索引行 kind 缺省 article。
    const ctx1 = reqCtx("POST", ["community", "share", "articles", "s1.json"], { token, env: { RECO_DB: db } });
    ctx1.env.FILES._store.set("users/u/articles/s1.json", schema3("普通帖"));
    const articleId = await shareIdFor("users/u/articles/s1.json");
    expect((await (await onRequest(ctx1)).json()).ok).toBe(true);
    expect(db._posts.get(articleId).kind).toBe("article");

    // 提示词帖（kind:'prompt' + promptCode，Task 5 起真实形状）→ reindex 收编，
    // 走同一个 indexUpsert，kind 是 prompt。
    const ctx2 = reqCtx("POST", ["community", "reindex"], { env: { RECO_DB: db } });
    ctx2.env.FILES._store.set("shares/1234567", JSON.stringify({
      type: "prompt", label: "提示词帖", instruction: "指令正文",
    }));
    ctx2.env.FILES._store.set("community/prm000000001.json", JSON.stringify({
      schema: 2, shareId: "prm000000001", owner: "users/u/", kind: "prompt",
      promptCode: "1234567", author: "B", firstSharedAt: 5000,
    }));
    const body = await (await onRequest(ctx2)).json();
    expect(body.ok).toBe(true);
    expect(db._posts.get("prm000000001").kind).toBe("prompt");
  });

  it("reconcileIndex 收编提示词帖：从 shares/<码> 读 title/preview，kind=prompt", async () => {
    const db = fakeRecoD1();
    const context = reqCtx("POST", ["community", "reindex"], { env: { RECO_DB: db } });
    context.env.FILES._store.set("shares/2223334", JSON.stringify({
      type: "prompt", label: "更简洁", instruction: "把这段话改得更简洁一些",
    }));
    context.env.FILES._store.set("community/prm400000001.json", JSON.stringify({
      schema: 2, shareId: "prm400000001", owner: "users/u/", kind: "prompt",
      promptCode: "2223334", author: "王建硕", firstSharedAt: 6000,
    }));
    const body = await (await onRequest(context)).json();
    expect(body.ok).toBe(true);
    expect(body.indexed).toBe(1);
    const row = db._posts.get("prm400000001");
    expect(row.kind).toBe("prompt");
    expect(row.title).toBe("更简洁");
    expect(row.preview).toContain("把这段话改得更简洁一些");
  });

  it("reconcileIndex：码失效的提示词帖被清（R2 帖 + D1 行）", async () => {
    const db = fakeRecoD1();
    db._posts.set("prm500000001", { share_id: "prm500000001", owner: "users/u/", hidden: 0, kind: "prompt" });
    const context = reqCtx("POST", ["community", "reindex"], { env: { RECO_DB: db } });
    context.env.FILES._store.set("community/prm500000001.json", JSON.stringify({
      schema: 2, shareId: "prm500000001", owner: "users/u/", kind: "prompt",
      promptCode: "3334445", author: "王建硕", firstSharedAt: 6000,
    }));
    const body = await (await onRequest(context)).json();
    expect(body.ok).toBe(true);
    expect(context.env.FILES._store.has("community/prm500000001.json")).toBe(false);
    expect(db._posts.has("prm500000001")).toBe(false);
  });
});

// ── D1 快路径（2026-07-13）：list/replies 直接读展示索引，R2 慢路径只做兜底 ──

describe("GET community/list — D1 fast path", () => {
  function row(over = {}) {
    return { share_id: "d1a000000001", owner: "users/u/", article_key: "users/u/articles/a.json",
             author: "A", title: "索引帖", preview: "预览文字", cover_photo_key: "users/u/photos/1/1.jpg",
             has_photo: 1, article_count: 2, first_shared_at: 9000, updated_at: 9500,
             reply_to: null, hidden: 0, ...over };
  }

  it("serves the whole feed from the index — zero R2 article reads, hidden rows dropped", async () => {
    const db = fakeRecoD1();
    db._posts.set("d1a000000001", row());
    db._posts.set("d1b000000001", row({ share_id: "d1b000000001", title: "被举报帖", hidden: 1 }));
    db._posts.set("d1c000000001", row({ share_id: "d1c000000001", title: "旧帖", first_shared_at: 100,
                                        has_photo: 0, cover_photo_key: null, preview: null, updated_at: null }));
    const token = await session("users/u/");
    const context = reqCtx("GET", ["community", "list"], { token, env: { RECO_DB: db } });
    // 注意：R2 store 是空的——列表若碰 R2 就会全空，这正是「快路径不读 R2」的证明。

    const body = await (await onRequest(context)).json();
    expect(body.posts.map((p) => p.shareId)).toEqual(["d1a000000001", "d1c000000001"]); // 新→旧，hidden 掉了
    expect(body.posts[0]).toMatchObject({
      author: "A", title: "索引帖", count: 2, firstSharedAt: 9000, updatedAt: 9500,
      hasPhoto: true, coverPhotoKey: "users/u/photos/1/1.jpg", preview: "预览文字", mine: true,
    });
    expect(body.posts[1].hasPhoto).toBe(false);
    expect(body.posts[1].coverPhotoKey).toBeUndefined();
    expect(body.posts[1].updatedAt).toBe(100);              // updated_at 空 → 回落 first_shared_at
    expect(body.posts[1].mine).toBe(true);
  });

  it("kicks a background reconcile via waitUntil that heals drifted rows", async () => {
    const db = fakeRecoD1();
    db._posts.set("d1a000000001", row({ title: "过期标题" }));
    db._posts.set("gone00000001", row({ share_id: "gone00000001" }));   // R2 里已不存在 → 应被对账清掉
    const token = await session("users/u/");
    const context = reqCtx("GET", ["community", "list"], { token, env: { RECO_DB: db } });
    context.waitUntil = vi.fn();
    // R2 真源：这篇活文章已改名
    context.env.FILES._store.set("users/u/articles/a.json", schema3("新标题"));
    context.env.FILES._store.set("community/d1a000000001.json", JSON.stringify({
      schema: 2, shareId: "d1a000000001", owner: "users/u/",
      articleKey: "users/u/articles/a.json", author: "A", firstSharedAt: 9000,
    }));

    const body = await (await onRequest(context)).json();
    expect(body.posts[0].title).toBe("过期标题");            // 本次响应仍用索引（快）
    expect(context.waitUntil).toHaveBeenCalled();
    await Promise.all(context.waitUntil.mock.calls.map((c) => c[0]));   // 等后台对账跑完
    expect(db._posts.get("d1a000000001").title).toBe("新标题");   // 漂移收敛
    expect(db._posts.has("gone00000001")).toBe(false);            // 幽灵行清掉
  });

  it("empty index falls back to the R2 slow path (feed never blanks out)", async () => {
    const db = fakeRecoD1();
    const context = reqCtx("GET", ["community", "list"], { env: { RECO_DB: db } });
    context.env.FILES._store.set("users/u/articles/s1.json", schema3("兜底帖"));
    context.env.FILES._store.set("community/ptr000000009.json", JSON.stringify({
      schema: 2, shareId: "ptr000000009", owner: "users/u/",
      articleKey: "users/u/articles/s1.json", author: "B", firstSharedAt: 5000,
    }));
    const body = await (await onRequest(context)).json();
    expect(body.posts.map((p) => p.shareId)).toEqual(["ptr000000009"]);
    expect(body.posts[0].title).toBe("兜底帖");
  });

  it("broken D1 falls back to the R2 slow path", async () => {
    const db = { prepare: () => ({ bind() { return this; }, async all() { throw new Error("boom"); },
                                   async run() { throw new Error("boom"); } }) };
    const context = reqCtx("GET", ["community", "list"], { env: { RECO_DB: db } });
    context.env.FILES._store.set("users/u/articles/s1.json", schema3("容错帖"));
    context.env.FILES._store.set("community/ptr000000008.json", JSON.stringify({
      schema: 2, shareId: "ptr000000008", owner: "users/u/",
      articleKey: "users/u/articles/s1.json", author: "B", firstSharedAt: 5000,
    }));
    const body = await (await onRequest(context)).json();
    expect(body.posts.map((p) => p.shareId)).toEqual(["ptr000000008"]);
  });

  it("community/list D1 快路径每帖带 kind", async () => {
    const db = fakeRecoD1();
    db._posts.set("d1a000000001", row({ kind: "prompt" }));
    db._posts.set("d1c000000001", row({ share_id: "d1c000000001", first_shared_at: 100 }));  // 无 kind → 兜底 article
    const token = await session("users/u/");
    const context = reqCtx("GET", ["community", "list"], { token, env: { RECO_DB: db } });
    const body = await (await onRequest(context)).json();
    expect(body.posts.find((p) => p.shareId === "d1a000000001").kind).toBe("prompt");
    expect(body.posts.find((p) => p.shareId === "d1c000000001").kind).toBe("article");
  });
});

describe("GET community/replies — D1 fast path", () => {
  it("returns replies oldest-first from the index without R2 reads", async () => {
    const db = fakeRecoD1();
    db._posts.set("root00000001", { share_id: "root00000001", owner: "users/u/", author: "根",
                                    title: "根帖", first_shared_at: 100, reply_to: null, hidden: 0 });
    db._posts.set("rep200000001", { share_id: "rep200000001", owner: "users/v/", author: "乙",
                                    title: "后回", first_shared_at: 300, reply_to: "root00000001", hidden: 0 });
    db._posts.set("rep100000001", { share_id: "rep100000001", owner: "users/w/", author: "甲",
                                    title: "先回", first_shared_at: 200, reply_to: "root00000001", hidden: 0 });
    db._posts.set("repX00000001", { share_id: "repX00000001", owner: "users/x/", author: "丙",
                                    title: "被举报回复", first_shared_at: 250, reply_to: "root00000001", hidden: 1 });
    const context = reqCtx("GET", ["community", "replies", "root00000001"], { env: { RECO_DB: db } });
    const body = await (await onRequest(context)).json();
    expect(body.posts.map((p) => p.shareId)).toEqual(["rep100000001", "rep200000001"]);  // 旧→新，hidden 掉了
    expect(body.posts[0]).toMatchObject({ author: "甲", title: "先回", replyTo: "root00000001" });
  });

  it("without RECO_DB the R2 slow path still answers", async () => {
    const context = reqCtx("GET", ["community", "replies", "root00000001"]);
    const env = context.env;
    env.FILES._store.set("users/u/articles/r1.json", schema3("回帖"));
    env.FILES._store.set("community/rep100000001.json", JSON.stringify({
      schema: 2, shareId: "rep100000001", owner: "users/u/", replyTo: "root00000001",
      articleKey: "users/u/articles/r1.json", author: "甲", firstSharedAt: 200,
    }));
    const body = await (await onRequest(context)).json();
    expect(body.posts.map((p) => p.shareId)).toEqual(["rep100000001"]);
    expect(body.posts[0].title).toBe("回帖");
  });
});
