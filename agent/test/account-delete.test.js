import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";
import { sha256hex } from "../../functions/lib/auth.js";

// Apple 5.1.1(v): POST account/delete must erase the WHOLE user — their
// users/<sub>/ prefix, their community posts (+ report markers), share links
// resolving into their scope, and the Sign-in-with-Apple binding — while
// leaving every other user's data untouched.

const SECRET = "secret";

function ctx(method, segments, { token, seed = {} } = {}) {
  const env = { ...fakeEnv(seed), FILES_TOKEN: "admin", SESSION_SECRET: SECRET };
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method, headers: { Authorization: `Bearer ${token}` },
  });
  return { request, env, params: { path: segments } };
}

const ANON = "anon_test-token-1234567890";
async function anonScope() {
  return `users/anon-${(await sha256hex(ANON)).slice(0, 32)}/`;
}

describe("POST account/delete", () => {
  it("wipes the user's scope, community posts, report markers, share links and Apple link — nothing else", async () => {
    const scope = await anonScope();
    const seed = {
      // the user's own data box
      [`${scope}VoiceDrop-a.m4a`]: "audio",
      [`${scope}articles/VoiceDrop-a.json`]: "{}",
      [`${scope}photos/s/1-abc.jpg`]: "jpg",
      [`${scope}ACCOUNT.json`]: JSON.stringify({ appleSub: "apple-sub-1", wechatUnionid: "union-1", wechatOpenid: "open-1" }),
      "links/apple-apple-sub-1.json": JSON.stringify({ scope }),
      "links/wechat-unionid-union-1.json": JSON.stringify({ scope }),
      "links/wechat-openid-open-1.json": JSON.stringify({ scope }),
      // community: one post mine (reported), one post someone else's
      "community/mine1.json": JSON.stringify({ schema: 2, shareId: "mine1", owner: scope, articleKey: `${scope}articles/VoiceDrop-a.json` }),
      "community/reports/mine1.json": JSON.stringify({ reporters: ["x"] }),
      "community/other1.json": JSON.stringify({ schema: 2, shareId: "other1", owner: "users/other/", articleKey: "users/other/articles/x.json" }),
      // share links: one into my scope, one into another user's
      "shares/aaaa": `${scope}articles/VoiceDrop-a.json`,
      "shares/bbbb": "users/other/articles/x.json",
      // another user's box must survive
      "users/other/articles/x.json": "{}",
    };
    const context = ctx("POST", ["account", "delete"], { token: ANON, seed });
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deleted.objects).toBe(4);
    expect(body.deleted.communityPosts).toBe(1);
    expect(body.deleted.shareLinks).toBe(1);

    const left = [...context.env.FILES._store.keys()].sort();
    expect(left).toEqual([
      "community/other1.json",
      "shares/bbbb",
      "users/other/articles/x.json",
    ]);
  });

  // F2: 提示词分享码的 shares/<码> 值是 JSON（{type:"prompt",...}），不是纯文本
  // articleKey，销号时 shareLinks 清理循环的 startsWith(scope) 匹配永远打不中——
  // 销号后 voicedrop.cn/<码> 永久公开且无人能关。销号必须连 owner 索引
  // users/<sub>/prompt-shares.json 里记的每个码一起杀。
  it("wipes the user's prompt share codes (shares/<码> is JSON, not the plain-text articleKey shape)", async () => {
    const scope = await anonScope();
    const seed = {
      [`${scope}ACCOUNT.json`]: JSON.stringify({}),
      [`${scope}prompt-shares.json`]: JSON.stringify({
        byItem: {
          p_1: { code: "1112223", createdAt: "2026-07-01T00:00:00Z" },
          sys_cartoon: { code: "4445556", createdAt: "2026-07-02T00:00:00Z" },
        },
        mintLog: [],
      }),
      "shares/1112223": JSON.stringify({ type: "prompt", sub: "x", label: "口语化", instruction: "把这段改得更口语" }),
      "shares/4445556": JSON.stringify({ type: "prompt", sub: "x", label: "卡通化", instruction: "把这段改得更卡通" }),
      // an article share link into the same scope must still be cleaned by the existing path
      [`${scope}articles/a.json`]: "{}",
      "shares/aaaa": `${scope}articles/a.json`,
      // another user's prompt code must survive untouched
      "users/other/prompt-shares.json": JSON.stringify({ byItem: { p_9: { code: "9998887", createdAt: "x" } }, mintLog: [] }),
      "shares/9998887": JSON.stringify({ type: "prompt", sub: "other", label: "别人的", instruction: "别删我" }),
    };
    const context = ctx("POST", ["account", "delete"], { token: ANON, seed });
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.deleted.promptCodes).toBe(2);
    const left = [...context.env.FILES._store.keys()];
    expect(left).not.toContain("shares/1112223");
    expect(left).not.toContain("shares/4445556");
    expect(left).toContain("shares/9998887");                    // other user's code survives
    expect(left).toContain("users/other/prompt-shares.json");    // other user's index untouched
  });

  it("works for a user with no Apple binding and no community activity", async () => {
    const scope = await anonScope();
    const seed = { [`${scope}VoiceDrop-b.m4a`]: "audio" };
    const context = ctx("POST", ["account", "delete"], { token: ANON, seed });
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.deleted.objects).toBe(1);
    expect(context.env.FILES._store.size).toBe(0);
  });

  it("admin token is rejected", async () => {
    const context = ctx("POST", ["account", "delete"], { token: "admin" });
    const resp = await onRequest(context);
    expect(resp.status).toBe(400);
  });
});
