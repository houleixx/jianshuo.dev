// GET /files/api/link/<id> — the public universal-link resolver. Contract:
//   - shares/<id>       → {type:"article", owner, stem} (the app compares owner
//     to its whoami scope: own article → native detail, else → web fallback)
//   - community/<id>    → {type:"community", ...} via the schema-2 live pointer
//   - reported post     → 404 (taken-down content stays down, Apple 1.2)
//   - no auth required, malformed ids 400, unknown ids 404
import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

function ctx(id, seed = {}) {
  const env = { ...fakeEnv(seed), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const request = new Request(`https://jianshuo.dev/files/api/link/${id}`, { method: "GET" });
  return { request, env, params: { path: ["link", id] }, waitUntil: () => {} };
}

describe("GET link/<id> — universal-link resolver", () => {
  it("resolves a shares/<id> mapping to type article + owner + stem (no auth)", async () => {
    const res = await onRequest(ctx("Ab3xK9_p2Q", {
      "shares/Ab3xK9_p2Q": "users/u1/articles/VoiceDrop-2026-07-01-abc.json",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: "article", owner: "users/u1/", stem: "VoiceDrop-2026-07-01-abc",
    });
  });

  it("falls back to a community schema-2 pointer → type community", async () => {
    const res = await onRequest(ctx("Cm12shareId00", {
      "community/Cm12shareId00.json": JSON.stringify({
        schema: 2, shareId: "Cm12shareId00", owner: "users/u9/",
        articleKey: "users/u9/articles/VoiceDrop-c.json", author: "阿珍", firstSharedAt: 1,
      }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      type: "community", owner: "users/u9/", stem: "VoiceDrop-c",
    });
  });

  it("a reported community post 404s (same takedown as the public page)", async () => {
    const res = await onRequest(ctx("Cm12shareId00", {
      "community/Cm12shareId00.json": JSON.stringify({
        schema: 2, shareId: "Cm12shareId00", owner: "users/u9/",
        articleKey: "users/u9/articles/VoiceDrop-c.json", author: "阿珍", firstSharedAt: 1,
      }),
      "community/reports/Cm12shareId00.json": JSON.stringify({ status: "pending" }),
    }));
    expect(res.status).toBe(404);
  });

  it("unknown id → 404, malformed id → 400, share pointing outside articles → 404", async () => {
    expect((await onRequest(ctx("NoSuchIdAbc"))).status).toBe(404);
    expect((await onRequest(ctx("bad!id"))).status).toBe(400);
    expect((await onRequest(ctx("EvilShare01", {
      "shares/EvilShare01": "users/u1/WECHAT.json",
    }))).status).toBe(404);
  });
});
