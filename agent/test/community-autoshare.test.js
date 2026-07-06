import { describe, it, expect } from "vitest";
import { maybeAutoShareCommunity } from "../src/miner.js";
import { fakeEnv } from "./fakes.js";
import { hmacSign } from "../../functions/lib/auth.js";

// 「成文后自动分享到 VD社区」 — the miner, after writing a fresh article, mirrors the
// app's POST community/share endpoint when users/<sub>/CONFIG.json opts in. These pin
// the cross-system contract: the auto-written pointer MUST be byte-identical to a
// manual share (same shareId derivation + same {schema,owner,articleKey,author}
// shape) or the app would 404 / double-post / fail to detect 已分享.

const SECRET = "secret";
const SUB = "anon-abc";
const SCOPE = `users/${SUB}/`;
const AUDIO = `${SCOPE}VoiceDrop-2026-06-28-101010-30-Sun-am.m4a`;
const ARTICLE_KEY = `${SCOPE}articles/VoiceDrop-2026-06-28-101010-30-Sun-am.json`;

// The server's own derivation (see functions/files/api: hmacSign('community:'+key)[:12]).
async function shareIdFor(articleKey) {
  return (await hmacSign("community:" + articleKey, SECRET)).slice(0, 12);
}

function env(seed = {}) {
  return { ...fakeEnv(seed), SESSION_SECRET: SECRET };
}

describe("maybeAutoShareCommunity", () => {
  it("opted in → writes a schema-2 pointer identical to a manual share", async () => {
    const e = env({
      [`${SCOPE}CONFIG.json`]: JSON.stringify({ autoShareCommunity: true }),
      [`${SCOPE}CLAUDE.md`]: "# 我的名字\n王建硕\n",
    });
    const shareId = await maybeAutoShareCommunity(AUDIO, e);

    expect(shareId).toBe(await shareIdFor(ARTICLE_KEY));
    const post = JSON.parse(await (await e.FILES.get(`community/${shareId}.json`)).text());
    expect(post).toMatchObject({
      schema: 2,
      shareId,
      owner: SCOPE,
      articleKey: ARTICLE_KEY,
      author: "王建硕",
    });
    expect(typeof post.firstSharedAt).toBe("number");
    expect("replyTo" in post).toBe(false);
  });

  it("no CONFIG.json → no-op", async () => {
    const e = env();
    expect(await maybeAutoShareCommunity(AUDIO, e)).toBeNull();
    expect(e.FILES._store.size).toBe(0);
  });

  it("CONFIG.json present but flag false → no-op", async () => {
    const e = env({ [`${SCOPE}CONFIG.json`]: JSON.stringify({ autoShareCommunity: false }) });
    expect(await maybeAutoShareCommunity(AUDIO, e)).toBeNull();
    expect(await e.FILES.head(`community/${await shareIdFor(ARTICLE_KEY)}.json`)).toBeNull();
  });

  it("missing SESSION_SECRET → no-op (can't derive shareId)", async () => {
    const e = fakeEnv({ [`${SCOPE}CONFIG.json`]: JSON.stringify({ autoShareCommunity: true }) });
    expect(await maybeAutoShareCommunity(AUDIO, e)).toBeNull();
  });

  it("no CLAUDE.md → author falls back to ID 前 6 位大写", async () => {
    const e = env({ [`${SCOPE}CONFIG.json`]: JSON.stringify({ autoShareCommunity: true }) });
    const shareId = await maybeAutoShareCommunity(AUDIO, e);
    const post = JSON.parse(await (await e.FILES.get(`community/${shareId}.json`)).text());
    expect(post.author).toBe("ABC");
  });

  it("re-share (re-mine) preserves firstSharedAt and replyTo, same shareId", async () => {
    const shareId = await shareIdFor(ARTICLE_KEY);
    const e = env({
      [`${SCOPE}CONFIG.json`]: JSON.stringify({ autoShareCommunity: true }),
      [`community/${shareId}.json`]: JSON.stringify({
        schema: 2, shareId, owner: SCOPE, articleKey: ARTICLE_KEY,
        author: "旧名", firstSharedAt: 111, replyTo: "deadbeef0001",
      }),
    });
    const got = await maybeAutoShareCommunity(AUDIO, e);
    expect(got).toBe(shareId);
    const post = JSON.parse(await (await e.FILES.get(`community/${shareId}.json`)).text());
    expect(post.firstSharedAt).toBe(111);
    expect(post.replyTo).toBe("deadbeef0001");
  });
});
