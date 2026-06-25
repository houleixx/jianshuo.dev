import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

// Simulate a Cloudflare Pages Function context (admin token throughout).
function ctx(method, path, { body } = {}) {
  const segments = ["articles", ...path.split("/").filter(Boolean)];
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };

  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method,
    headers: { Authorization: `Bearer admin`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  return { request, env: { ...env, FILES_TOKEN: "admin" }, params: { path: segments } };
}

// Seed a schema-3 article for user "u", stem defaulting to "s1".
function seedArticle(env, stem = "s1", extra = {}) {
  const key = `users/u/articles/${stem}.json`;
  const base = {
    schema: 3, createdAt: 1000, transcript: "tx",
    head: 1,
    versions: [{ v: 1, savedAt: 1000, source: "mine", articles: [{ title: "T1", body: "B1" }] }],
  };
  env.FILES._store.set(key, JSON.stringify({ ...base, ...extra }));
  return key;
}

// ── list ────────────────────────────────────────────────────────────────────

describe("GET /articles — list", () => {
  it("returns articles newest-first", async () => {
    const context = ctx("GET", "");
    seedArticle(context.env, "s1", { createdAt: 1000 });
    seedArticle(context.env, "s2", { createdAt: 2000 });
    context.params.path = ["articles", "u"];
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.articles.map((a) => a.stem)).toEqual(["s2", "s1"]);
  });
});

// ── read ────────────────────────────────────────────────────────────────────

describe("GET /articles/<sub>/<stem> — read (admin)", () => {
  it("returns top-level articles from current head, strips versions/head", async () => {
    const context = ctx("GET", "u/s1");
    seedArticle(context.env, "s1");
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.articles[0].title).toBe("T1");
    expect(body.versions).toBeUndefined();
    expect(body.head).toBeUndefined();
  });

  it("returns articles from head version, not latest version", async () => {
    const context = ctx("GET", "u/s1");
    seedArticle(context.env, "s1", {
      head: 1,
      versions: [
        { v: 1, savedAt: 1000, source: "mine",  articles: [{ title: "old", body: "" }] },
        { v: 2, savedAt: 2000, source: "agent", articles: [{ title: "new", body: "" }] },
      ],
    });
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(body.articles[0].title).toBe("old");   // head=1, not the latest v2
  });

  it("404s a missing stem", async () => {
    const context = ctx("GET", "u/nope");
    expect((await onRequest(context)).status).toBe(404);
  });
});

// ── write ────────────────────────────────────────────────────────────────────

describe("PUT /articles/<sub>/<stem> — write (admin)", () => {
  it("creates a new article with head=1", async () => {
    const context = ctx("PUT", "u/s1", { body: { articles: [{ title: "New", body: "Body" }] } });
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.head).toBe(1);
    const stored = JSON.parse(context.env.FILES._store.get("users/u/articles/s1.json"));
    expect(stored.head).toBe(1);
    expect(stored.versions[0].source).toBe("mine");
  });

  it("increments head on second write", async () => {
    const context = ctx("PUT", "u/s1", { body: { articles: [{ title: "v2", body: "" }] } });
    seedArticle(context.env, "s1");
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(body.head).toBe(2);
    const stored = JSON.parse(context.env.FILES._store.get("users/u/articles/s1.json"));
    expect(stored.versions).toHaveLength(2);
    expect(stored.versions[0].v).toBe(1);
    expect(stored.versions[1].v).toBe(2);
  });
});

// ── history ─────────────────────────────────────────────────────────────────

describe("GET /articles/<sub>/<stem>/history", () => {
  it("returns {head, versions} oldest-first", async () => {
    const context = ctx("GET", "u/s1/history");
    seedArticle(context.env, "s1", {
      head: 2,
      versions: [
        { v: 1, savedAt: 900,  source: "mine",  articles: [{ title: "old", body: "" }] },
        { v: 2, savedAt: 2000, source: "agent", articles: [{ title: "new", body: "" }] },
      ],
    });
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.head).toBe(2);
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0].v).toBe(1);
    expect(body.versions[1].v).toBe(2);
  });
});

// ── PATCH head ───────────────────────────────────────────────────────────────

describe("PATCH /articles/<sub>/<stem>/head", () => {
  it("moves head to a valid version", async () => {
    const context = ctx("PATCH", "u/s1/head", { body: { head: 1 } });
    seedArticle(context.env, "s1", {
      head: 2,
      versions: [
        { v: 1, savedAt: 1000, source: "mine",  articles: [{ title: "T1", body: "" }] },
        { v: 2, savedAt: 2000, source: "agent", articles: [{ title: "T2", body: "" }] },
      ],
    });
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.head).toBe(1);
    const stored = JSON.parse(context.env.FILES._store.get("users/u/articles/s1.json"));
    expect(stored.head).toBe(1);
    expect(stored.versions).toHaveLength(2);   // versions unchanged
  });

  it("404s if head value is not in versions", async () => {
    const context = ctx("PATCH", "u/s1/head", { body: { head: 99 } });
    seedArticle(context.env, "s1");
    expect((await onRequest(context)).status).toBe(404);
  });
});

// ── SRT / empty / delete (unchanged) ────────────────────────────────────────

describe("PUT /articles/<sub>/<stem>/srt", () => {
  it("stores the SRT content", async () => {
    const context = ctx("PUT", "u/s1/srt");
    context.request = new Request("https://jianshuo.dev/files/api/articles/u/s1/srt", {
      method: "PUT",
      headers: { Authorization: "Bearer admin", "Content-Type": "text/plain" },
      body: "1\n00:00:00,000 --> 00:00:01,000\nHello",
    });
    const resp = await onRequest(context);
    expect(resp.status).toBe(200);
    expect(context.env.FILES._store.get("users/u/articles/s1.srt")).toContain("Hello");
  });
});

describe("PUT /articles/<sub>/<stem>/empty", () => {
  it("stores the empty marker with reason", async () => {
    const context = ctx("PUT", "u/s1/empty", { body: { reason: "no-speech" } });
    const resp = await onRequest(context);
    expect(resp.status).toBe(200);
    const stored = JSON.parse(context.env.FILES._store.get("users/u/articles/s1.empty"));
    expect(stored.reason).toBe("no-speech");
  });
});

describe("DELETE /articles/<sub>/<stem>", () => {
  it("deletes .json + .srt + .empty", async () => {
    const context = ctx("DELETE", "u/s1");
    seedArticle(context.env, "s1");
    context.env.FILES._store.set("users/u/articles/s1.srt", "srt");
    context.env.FILES._store.set("users/u/articles/s1.empty", "{}");
    const resp = await onRequest(context);
    expect(resp.status).toBe(200);
    expect(context.env.FILES._store.has("users/u/articles/s1.json")).toBe(false);
    expect(context.env.FILES._store.has("users/u/articles/s1.srt")).toBe(false);
    expect(context.env.FILES._store.has("users/u/articles/s1.empty")).toBe(false);
  });
});
