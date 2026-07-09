// GET /files/api/link/<id> — the public universal-link resolver. Contract:
//   - shares/<id>       → {type:"article", owner, stem, title, articles} (the app
//     compares owner to its whoami scope: own article → native detail; someone
//     else's → the native read-only reader, rendered from `articles` right here)
//   - community/<id>    → {type:"community", ...} via the schema-2 live pointer
//     (the app then opens the native post view, which loads via community/get)
//   - reported post     → 404 (taken-down content stays down, Apple 1.2)
//   - no auth required, malformed ids 400, unknown ids / missing article 404
import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

function ctx(id, seed = {}) {
  const env = { ...fakeEnv(seed), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const request = new Request(`https://jianshuo.dev/files/api/link/${id}`, { method: "GET" });
  return { request, env, params: { path: ["link", id] }, waitUntil: () => {} };
}

// A live schema-3 article doc on disk.
function schema3(...articles) {
  return JSON.stringify({
    schema: 3, createdAt: 1000, head: 1,
    versions: [{ v: 1, savedAt: 1000, source: "mine", articles }],
  });
}

describe("GET link/<id> — universal-link resolver", () => {
  it("resolves a shares/<id> mapping to article + content (no auth)", async () => {
    const res = await onRequest(ctx("Ab3xK9_p2Q", {
      "shares/Ab3xK9_p2Q": "users/u1/articles/VoiceDrop-2026-07-01-abc.json",
      "users/u1/articles/VoiceDrop-2026-07-01-abc.json":
        schema3({ title: "第一篇", body: "正文一" }, { title: "第二篇", body: "正文二 [[photo:photos/s/a.jpg]]" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: "article", owner: "users/u1/", stem: "VoiceDrop-2026-07-01-abc",
      title: "第一篇",
      articles: [{ title: "第一篇", body: "正文一" },
                 { title: "第二篇", body: "正文二 [[photo:photos/s/a.jpg]]" }],
    });
  });

  it("empty-body sections are dropped; legacy doc.photos rides along", async () => {
    const res = await onRequest(ctx("Ab3xK9_p2Q", {
      "shares/Ab3xK9_p2Q": "users/u1/articles/VoiceDrop-x.json",
      "users/u1/articles/VoiceDrop-x.json": JSON.stringify({
        schema: 3, createdAt: 1000, head: 1, photos: ["photos/s/legacy.jpg"],
        versions: [{ v: 1, savedAt: 1000, source: "mine",
          articles: [{ title: "有货", body: "带图 [[photo:1]]" }, { title: "空壳", body: "  " }] }],
      }),
    }));
    const body = await res.json();
    expect(body.articles).toEqual([{ title: "有货", body: "带图 [[photo:1]]" }]);
    expect(body.photos).toEqual(["photos/s/legacy.jpg"]);
  });

  it("falls back to a community schema-2 pointer → type community with live content", async () => {
    const res = await onRequest(ctx("Cm12shareId00", {
      "community/Cm12shareId00.json": JSON.stringify({
        schema: 2, shareId: "Cm12shareId00", owner: "users/u9/",
        articleKey: "users/u9/articles/VoiceDrop-c.json", author: "阿珍", firstSharedAt: 1,
      }),
      "users/u9/articles/VoiceDrop-c.json": schema3({ title: "社区帖", body: "帖子正文" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("community");
    expect(body.owner).toBe("users/u9/");
    expect(body.stem).toBe("VoiceDrop-c");
    expect(body.articles).toEqual([{ title: "社区帖", body: "帖子正文" }]);
  });

  it("a reported community post 404s (same takedown as the public page)", async () => {
    const res = await onRequest(ctx("Cm12shareId00", {
      "community/Cm12shareId00.json": JSON.stringify({
        schema: 2, shareId: "Cm12shareId00", owner: "users/u9/",
        articleKey: "users/u9/articles/VoiceDrop-c.json", author: "阿珍", firstSharedAt: 1,
      }),
      "users/u9/articles/VoiceDrop-c.json": schema3({ title: "社区帖", body: "帖子正文" }),
      "community/reports/Cm12shareId00.json": JSON.stringify({ status: "pending" }),
    }));
    expect(res.status).toBe(404);
  });

  it("unknown id → 404, malformed id → 400, non-article target → 404, deleted article → 404", async () => {
    expect((await onRequest(ctx("NoSuchIdAbc"))).status).toBe(404);
    expect((await onRequest(ctx("bad!id"))).status).toBe(400);
    expect((await onRequest(ctx("EvilShare01", {
      "shares/EvilShare01": "users/u1/WECHAT.json",
    }))).status).toBe(404);
    expect((await onRequest(ctx("GoneShare01", {
      "shares/GoneShare01": "users/u1/articles/VoiceDrop-gone.json",
    }))).status).toBe(404);
  });
});
