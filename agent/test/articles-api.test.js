import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";
import { sha256hex } from "../../functions/lib/auth.js";

// Generic request context with an arbitrary bearer token (admin by default).
// segments are the raw URL path under /files/api/.
function reqCtx(method, segments, { token = "admin", body } = {}) {
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const headers = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { request, env, params: { path: segments } };
}

// The users/anon-<hash>/ scope an anon capability token resolves to (mirrors the
// server's own derivation), so a test can seed data into that exact box.
async function anonScope(token) {
  return `users/anon-${(await sha256hex(token)).slice(0, 32)}/`;
}

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

// ── raw /download of an article json — legacy raw-download clients (build ≤77) ─
// Old iOS builds fetch /download/users/<sub>/articles/<stem>.json and read a
// top-level `articles`. Schema-3 docs keep content under versions[head], so the
// download route must reconstruct `articles` via the shared resolveArticles.

describe("GET /download/<key> for an article json — build-61 compat", () => {
  function dlCtx(key) {
    const segments = ["download", ...key.split("/")];
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
      method: "GET",
      headers: { Authorization: "Bearer admin" },
    });
    return { request, env, params: { path: segments } };
  }

  it("reconstructs top-level articles from versions[head] for a schema-3 doc", async () => {
    const context = dlCtx("users/u/articles/s1.json");
    seedArticle(context.env, "s1");   // schema-3: no top-level articles, content in versions[head]
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(Array.isArray(body.articles)).toBe(true);
    expect(body.articles[0].title).toBe("T1");
    expect(body.articles[0].body).toBe("B1");
    // versions/head left intact (additive) so version-aware readers are unaffected
    expect(body.head).toBe(1);
  });

  it("resolves the head version, not a stale one, after an undo (head < latest)", async () => {
    const context = dlCtx("users/u/articles/s1.json");
    seedArticle(context.env, "s1", {
      head: 1,   // head points back at v1 (an undo), even though v2 exists
      versions: [
        { v: 1, savedAt: 1000, source: "mine",  articles: [{ title: "V1", body: "B1" }] },
        { v: 2, savedAt: 2000, source: "agent", articles: [{ title: "V2", body: "B2" }] },
      ],
    });
    const body = await (await onRequest(context)).json();
    expect(body.articles[0].title).toBe("V1");
  });
});

// ── Legacy docs ON DISK, read/written through the NEW API ─────────────────────
// seedArticle writes schema-3, but real buckets still hold v1 and schema-2 docs
// written by old builds. The current API reads them via readArticleDoc (which
// migrates in memory) + resolveArticles, so an old recording must still open and
// must not lose content when a NEW build edits it. These seed the raw legacy
// shapes and drive them through onRequest — the exact path a future build hits.

describe("GET /articles/<stem> — reading a legacy doc on disk", () => {
  it("v1 doc (top-level title/body, no articles[]) → reconstructed top-level articles", async () => {
    const context = ctx("GET", "u/v1");
    context.env.FILES._store.set("users/u/articles/v1.json", JSON.stringify({
      version: 1, _source: "mine", createdAt: 1000, updatedAt: 1500,
      title: "老标题", body: "v1 正文内容", transcript: "tx",
    }));
    const resp = await onRequest(context);
    const body = await resp.json();
    expect(resp.status).toBe(200);
    expect(body.articles[0]).toEqual({ title: "老标题", body: "v1 正文内容" });
    expect(body.transcript).toBe("tx");
    expect(body.versions).toBeUndefined();   // internal shape never leaks to clients
    expect(body.head).toBeUndefined();
  });

  it("schema-2 doc → reconstructed articles, and wechatMediaId survives migration", async () => {
    const context = ctx("GET", "u/s2");
    context.env.FILES._store.set("users/u/articles/s2.json", JSON.stringify({
      schema: 2, _source: "mine", createdAt: 1000, updatedAt: 2000, transcript: "tx2",
      articles: [{ title: "S2", body: "b2", wechatMediaId: "media-123" }],
    }));
    const body = await (await onRequest(context)).json();
    expect(body.articles[0].title).toBe("S2");
    // a previously-published old article keeps its WeChat material id (no re-upload)
    expect(body.articles[0].wechatMediaId).toBe("media-123");
  });
});

describe("PUT /articles/<stem> — editing a legacy doc does not lose old content", () => {
  // Mirrors the real agent round-trip (read_article → write_article in tools.js):
  // the client resends metadata (transcript) in the PUT body; the server manages
  // only versions/head. The key guarantee: a NEW build editing an OLD schema-2
  // article keeps the original content as v1 (undo still works) and carries the
  // transcript through, so old recordings stay editable after any app upgrade.
  it("writing over a schema-2 doc keeps the original as v1 and appends v2", async () => {
    const context = ctx("PUT", "u/s2", {
      body: { articles: [{ title: "edited", body: "new" }], transcript: "txOld" },
    });
    context.env.FILES._store.set("users/u/articles/s2.json", JSON.stringify({
      schema: 2, _source: "mine", createdAt: 1000, updatedAt: 2000, transcript: "txOld",
      articles: [{ title: "orig", body: "old" }],
    }));
    const body = await (await onRequest(context)).json();
    expect(body.head).toBe(2);   // migrated v1 + the new write
    const stored = JSON.parse(context.env.FILES._store.get("users/u/articles/s2.json"));
    expect(stored.versions.map((e) => e.articles[0].title)).toEqual(["orig", "edited"]);
    expect(stored.head).toBe(2);
    expect(stored.transcript).toBe("txOld");   // resent metadata rides through the migrate+write
  });
});

describe("GET /download/<key> — legacy docs for build ≤77 raw-download clients", () => {
  function dlCtx(key) {
    const segments = ["download", ...key.split("/")];
    const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
    const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
      method: "GET", headers: { Authorization: "Bearer admin" },
    });
    return { request, env, params: { path: segments } };
  }

  it("reconstructs articles from a v1 doc (top-level body)", async () => {
    const context = dlCtx("users/u/articles/v1.json");
    context.env.FILES._store.set("users/u/articles/v1.json", JSON.stringify({
      version: 1, title: "标题", body: "正文", transcript: "tx",
    }));
    const body = await (await onRequest(context)).json();
    expect(body.articles[0]).toEqual({ title: "标题", body: "正文" });
  });

  it("reconstructs articles from a schema-2 doc (top-level articles)", async () => {
    const context = dlCtx("users/u/articles/s2.json");
    context.env.FILES._store.set("users/u/articles/s2.json", JSON.stringify({
      schema: 2, transcript: "tx", articles: [{ title: "S2", body: "b2" }],
    }));
    const body = await (await onRequest(context)).json();
    expect(body.articles[0].title).toBe("S2");
  });
});

// ── Anonymous capability token — the DEFAULT auth path for old AND new builds ──
// STATE.md: the app sends the anon token (anon_…) for ALL calls by default. So
// the most-trafficked auth path is not the admin token these tests usually use.
// These drive a real anon Bearer through onRequest and confirm it resolves to the
// stable users/anon-<hash>/ box and can read only its own data.

describe("anon token through onRequest", () => {
  const TOKEN = "anon_" + "z".repeat(28);

  it("GET /whoami returns the anon's hashed scope", async () => {
    const context = reqCtx("GET", ["whoami"], { token: TOKEN });
    const body = await (await onRequest(context)).json();
    expect(body.scope).toBe(await anonScope(TOKEN));
  });

  it("admin token's /whoami scope is '' (full bucket)", async () => {
    const body = await (await onRequest(reqCtx("GET", ["whoami"]))).json();
    expect(body.scope).toBe("");
  });

  it("lists + reads ONLY the anon's own articles", async () => {
    const scope = await anonScope(TOKEN);
    const context = reqCtx("GET", ["articles"], { token: TOKEN });
    context.env.FILES._store.set(`${scope}articles/mine.json`, JSON.stringify({
      schema: 3, createdAt: 1000, head: 1,
      versions: [{ v: 1, savedAt: 1000, source: "mine", articles: [{ title: "MINE", body: "b" }] }],
    }));
    // someone else's article must not appear
    context.env.FILES._store.set("users/other/articles/theirs.json", JSON.stringify({
      schema: 3, createdAt: 9999, head: 1,
      versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{ title: "THEIRS", body: "x" }] }],
    }));
    const body = await (await onRequest(context)).json();
    expect(body.articles.map((a) => a.stem)).toEqual(["mine"]);
    expect(body.articles[0].title).toBe("MINE");
  });

  it("rejects a missing/garbage token with 401", async () => {
    const context = reqCtx("GET", ["articles"], { token: "garbage" });
    expect((await onRequest(context)).status).toBe(401);
  });
});
