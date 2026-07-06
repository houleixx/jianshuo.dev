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
      [`${scope}ACCOUNT.json`]: JSON.stringify({ appleSub: "apple-sub-1" }),
      "links/apple-apple-sub-1.json": JSON.stringify({ scope }),
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
