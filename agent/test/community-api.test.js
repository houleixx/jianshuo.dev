import { describe, it, expect, vi, afterEach } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";
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
});
