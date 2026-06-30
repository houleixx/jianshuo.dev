import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";
import { sha256hex } from "../../functions/lib/auth.js";

const TOKEN = "anon_" + "s".repeat(28);
async function anonScope(token) {
  return `users/anon-${(await sha256hex(token)).slice(0, 32)}/`;
}

function reqCtx(method, segments, { token = TOKEN, body, contentType } = {}) {
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = contentType || "application/json";
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { request, env, params: { path: segments } };
}

describe("GET /style", () => {
  it("seeds the default 王建硕 style as v1 when neither exists (default:true)", async () => {
    const { DEFAULT_STYLE } = await import("../../functions/lib/style-store.js");
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    const res = await onRequest(ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.style).toBe(DEFAULT_STYLE);
    expect(body.head).toBe(1);
    expect(body.default).toBe(true);
    // 已落库为该用户自己的 CLAUDE.json
    expect(ctx.env.FILES._store.has(`${scope}CLAUDE.json`)).toBe(true);
  });

  it("default:false once the user has their own style", async () => {
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    ctx.env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 1, createdAt: 1, updatedAt: 2,
      versions: [{ v: 1, savedAt: 1, source: "app", style: "我自己的" }],
    }));
    const body = await (await onRequest(ctx)).json();
    expect(body.style).toBe("我自己的");
    expect(body.default).toBe(false);
  });

  it("reads the current 文风 from CLAUDE.json", async () => {
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    ctx.env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 2, createdAt: 1, updatedAt: 2,
      versions: [
        { v: 1, savedAt: 1, source: "app", style: "老" },
        { v: 2, savedAt: 2, source: "agent", style: "新文风" },
      ],
    }));
    const body = await (await onRequest(ctx)).json();
    expect(body.style).toBe("新文风");
    expect(body.head).toBe(2);
  });

  it("falls back to the legacy CLAUDE.md 文风 section", async () => {
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    ctx.env.FILES._store.set(`${scope}CLAUDE.md`, "# 我的名字\n王建硕\n\n# 我的文风\n回退文风");
    const body = await (await onRequest(ctx)).json();
    expect(body.style).toBe("回退文风");
    expect(body.legacy).toBe(true);
  });
});

describe("PUT /style", () => {
  it("creates CLAUDE.json v1 and never touches CLAUDE.md", async () => {
    const ctx = reqCtx("PUT", ["style"], { body: { style: "我的文风一" } });
    const scope = await anonScope(TOKEN);
    const body = await (await onRequest(ctx)).json();
    expect(body.ok).toBe(true);
    expect(body.head).toBe(1);
    const stored = JSON.parse(ctx.env.FILES._store.get(`${scope}CLAUDE.json`));
    expect(stored.schema).toBe(3);
    expect(stored.versions[0].style).toBe("我的文风一");
    expect(stored.versions[0].source).toBe("app");
    expect(ctx.env.FILES._store.has(`${scope}CLAUDE.md`)).toBe(false);
  });

  it("rejects empty style", async () => {
    const ctx = reqCtx("PUT", ["style"], { body: { style: "   " } });
    const resp = await onRequest(ctx);
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe("empty_content");
  });

  it("source=agent is honored", async () => {
    const ctx = reqCtx("PUT", ["style"], { body: { style: "agent 写的", source: "agent" } });
    const scope = await anonScope(TOKEN);
    await onRequest(ctx);
    const stored = JSON.parse(ctx.env.FILES._store.get(`${scope}CLAUDE.json`));
    expect(stored.versions[0].source).toBe("agent");
  });
});

describe("GET /style/history + PATCH /style/head", () => {
  it("returns history and moves the head pointer", async () => {
    const scope = await anonScope(TOKEN);
    // two writes
    await onRequest(reqCtx("PUT", ["style"], { body: { style: "v1" } }));
    // re-seed the same store across calls: reuse one env
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 2, createdAt: 1, updatedAt: 2,
      versions: [
        { v: 1, savedAt: 1, source: "app", style: "v1" },
        { v: 2, savedAt: 2, source: "app", style: "v2" },
      ],
    }));
    const histReq = { request: new Request(`https://jianshuo.dev/files/api/style/history`, { method: "GET", headers: { Authorization: `Bearer ${TOKEN}` } }), env, params: { path: ["style", "history"] } };
    const hist = await (await onRequest(histReq)).json();
    expect(hist.head).toBe(2);
    expect(hist.versions).toHaveLength(2);

    const patchReq = { request: new Request(`https://jianshuo.dev/files/api/style/head`, { method: "PATCH", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ head: 1 }) }), env, params: { path: ["style", "head"] } };
    const patched = await (await onRequest(patchReq)).json();
    expect(patched.head).toBe(1);
    const stored = JSON.parse(env.FILES._store.get(`${scope}CLAUDE.json`));
    expect(stored.head).toBe(1);
    expect(stored.versions).toHaveLength(2);
  });

  it("404s a head value not in versions", async () => {
    const scope = await anonScope(TOKEN);
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 1, createdAt: 1, updatedAt: 1,
      versions: [{ v: 1, savedAt: 1, source: "app", style: "v1" }],
    }));
    const patchReq = { request: new Request(`https://jianshuo.dev/files/api/style/head`, { method: "PATCH", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ head: 9 }) }), env, params: { path: ["style", "head"] } };
    expect((await onRequest(patchReq)).status).toBe(404);
  });
});

describe("profile name via /style — additive, name change mints NO version", () => {
  it("GET /style additively returns name from profile", async () => {
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    ctx.env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 1, createdAt: 1, updatedAt: 2,
      versions: [{ v: 1, savedAt: 1, source: "app", style: "文风" }],
      profile: { name: "王建硕" },
    }));
    const body = await (await onRequest(ctx)).json();
    expect(body.style).toBe("文风");
    expect(body.name).toBe("王建硕");
  });

  it("GET /style legacy path parses name from CLAUDE.md", async () => {
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    ctx.env.FILES._store.set(`${scope}CLAUDE.md`, "# 我的名字\n王建硕\n\n# 我的文风\n回退");
    const body = await (await onRequest(ctx)).json();
    expect(body.name).toBe("王建硕");
    expect(body.legacy).toBe(true);
  });

  it("PUT /style {name} only → sets profile.name, NO new version", async () => {
    const scope = await anonScope(TOKEN);
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 1, createdAt: 1, updatedAt: 1,
      versions: [{ v: 1, savedAt: 1, source: "app", style: "文风v1" }],
    }));
    const putReq = { request: new Request(`https://jianshuo.dev/files/api/style`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "王建硕" }) }), env, params: { path: ["style"] } };
    const body = await (await onRequest(putReq)).json();
    expect(body.ok).toBe(true);
    const stored = JSON.parse(env.FILES._store.get(`${scope}CLAUDE.json`));
    expect(stored.profile.name).toBe("王建硕");
    expect(stored.head).toBe(1);              // unchanged
    expect(stored.versions).toHaveLength(1);  // no new version
  });

  it("PUT /style {style, name} → one version + the name", async () => {
    const scope = await anonScope(TOKEN);
    const ctx = reqCtx("PUT", ["style"], { body: { style: "新文风", name: "王建硕" } });
    const body = await (await onRequest(ctx)).json();
    expect(body.ok).toBe(true);
    expect(body.head).toBe(1);
    const stored = JSON.parse(ctx.env.FILES._store.get(`${scope}CLAUDE.json`));
    expect(stored.versions[0].style).toBe("新文风");
    expect(stored.profile.name).toBe("王建硕");
  });

  it("PUT /style {style} (old client) unchanged — no profile key written", async () => {
    const scope = await anonScope(TOKEN);
    const ctx = reqCtx("PUT", ["style"], { body: { style: "只有文风" } });
    await onRequest(ctx);
    const stored = JSON.parse(ctx.env.FILES._store.get(`${scope}CLAUDE.json`));
    expect(stored.versions[0].style).toBe("只有文风");
    expect(stored.profile).toBeUndefined();
  });

  it("PUT /style {styles} writes profile.styles (ints only, capped 3), no version", async () => {
    const scope = await anonScope(TOKEN);
    const ctx = reqCtx("PUT", ["style"], { body: { styles: [7, 3, 9, 5, "x"] } });
    const body = await (await onRequest(ctx)).json();
    expect(body.ok).toBe(true);
    const stored = JSON.parse(ctx.env.FILES._store.get(`${scope}CLAUDE.json`));
    expect(stored.profile.styles).toEqual([7, 3, 9]);
    expect(stored.versions || []).toHaveLength(0);   // selection is not a文风 version
  });

  it("GET /style additively returns profile.styles", async () => {
    const ctx = reqCtx("GET", ["style"]);
    const scope = await anonScope(TOKEN);
    ctx.env.FILES._store.set(`${scope}CLAUDE.json`, JSON.stringify({
      schema: 3, head: 1, createdAt: 1, updatedAt: 2,
      versions: [{ v: 1, savedAt: 1, source: "app", style: "x" }],
      profile: { styles: [7, 3] },
    }));
    const body = await (await onRequest(ctx)).json();
    expect(body.styles).toEqual([7, 3]);
  });
});
