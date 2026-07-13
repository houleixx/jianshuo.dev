// GET /recordings — 主界面「我的录音」的轻量列表：根目录 delimiter listing（只有
// .m4a 在根上）+ 文章摘要索引的 sidecar 标记，两个并发 R2 读代替全量 /list。
// 这里钉住四个状态位的维护链路（成文 / 无语音 / 算力不足 / 预置标签）与
// 老数据经由后台对账回填的自愈路径。
import { describe, it, expect, vi } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

const TOKEN = "anon_" + "a".repeat(28);
let SCOPE; // resolved once from whoami — anon scope is a hash of the token

function ctx(method, segments, { body, contentType } = {}) {
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (contentType) headers["Content-Type"] = contentType;
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method, headers,
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  return { request, env, params: { path: segments } };
}

async function resolveScope(env) {
  if (SCOPE) return SCOPE;
  const c = ctx("GET", ["whoami"]);
  c.env = env;
  SCOPE = (await (await onRequest(c)).json()).scope;
  return SCOPE;
}

async function call(env, method, segments, opts = {}) {
  const c = ctx(method, segments, opts);
  c.env = env;
  if (opts.waitUntil) c.waitUntil = opts.waitUntil;
  const resp = await onRequest(c);
  expect(resp.status).toBe(opts.expect || 200);
  return resp.json();
}

describe("GET /recordings — 轻量录音列表", () => {
  it("只出根目录的 .m4a；photos/articles 子目录与根上的杂项不掺和", async () => {
    const env = ctx("GET", []).env;
    const scope = await resolveScope(env);
    env.FILES._store.set(`${scope}VoiceDrop-2026-07-01-a.m4a`, "AUDIO");
    env.FILES._store.set(`${scope}CLAUDE.md`, "# 我的名字");
    env.FILES._store.set(`${scope}photos/1/1.jpg`, "JPG");
    env.FILES._store.set(`${scope}articles/VoiceDrop-2026-07-01-a.srt`, "1\n");

    const body = await call(env, "GET", ["recordings"]);
    expect(body.recordings.map((r) => r.name)).toEqual(["VoiceDrop-2026-07-01-a.m4a"]);
    const r = body.recordings[0];
    expect(r).toMatchObject({ hasArticles: false, isEmpty: false, blocked: false, hasTags: false });
    expect(typeof r.uploaded).toBe("string");   // JSON 化后的时间戳，App 直接解码
  });

  it("四个状态位各自的写入口都会同步点亮索引", async () => {
    const env = ctx("GET", []).env;
    const scope = await resolveScope(env);
    for (const s of ["s-done", "s-empty", "s-blocked", "s-tagged", "s-pending"]) {
      env.FILES._store.set(`${scope}VoiceDrop-${s}.m4a`, "AUDIO");
    }
    // 成文：走 PUT /articles（putArticleDoc 维护索引）
    await call(env, "PUT", ["articles", "VoiceDrop-s-done"], { body: { articles: [{ title: "T", body: "B" }] } });
    // 无语音 / 算力不足：走各自路由
    await call(env, "PUT", ["articles", "VoiceDrop-s-empty", "empty"], { body: { reason: "no-speech" } });
    await call(env, "PUT", ["articles", "VoiceDrop-s-blocked", "blocked"], { body: { reason: "no-credit" } });
    // 预置标签：走通用上传路由的 .tags 特判
    await call(env, "PUT", ["upload", "articles", "VoiceDrop-s-tagged.tags"], { body: '["旅行"]', contentType: "application/json" });

    const by = Object.fromEntries((await call(env, "GET", ["recordings"])).recordings.map((r) => [r.name, r]));
    expect(by["VoiceDrop-s-done.m4a"]).toMatchObject({ hasArticles: true, isEmpty: false });
    expect(by["VoiceDrop-s-empty.m4a"]).toMatchObject({ hasArticles: false, isEmpty: true });
    expect(by["VoiceDrop-s-blocked.m4a"]).toMatchObject({ blocked: true });
    expect(by["VoiceDrop-s-tagged.m4a"]).toMatchObject({ hasTags: true });
    expect(by["VoiceDrop-s-pending.m4a"]).toMatchObject({ hasArticles: false, isEmpty: false, blocked: false, hasTags: false });
  });

  it("老数据（索引之前就存在的 .empty 标记）由后台对账回填", async () => {
    const env = ctx("GET", []).env;
    const scope = await resolveScope(env);
    env.FILES._store.set(`${scope}VoiceDrop-old.m4a`, "AUDIO");
    env.FILES._store.set(`${scope}articles/VoiceDrop-old.empty`, '{"status":"empty"}');   // 直写，索引不知道

    const waitUntil = vi.fn();
    const first = await call(env, "GET", ["recordings"], { waitUntil });
    expect(first.recordings[0].isEmpty).toBe(false);           // 第一次还看不到
    expect(waitUntil).toHaveBeenCalled();
    await Promise.all(waitUntil.mock.calls.map((c) => c[0])); // 对账跑完
    const second = await call(env, "GET", ["recordings"]);
    expect(second.recordings[0].isEmpty).toBe(true);           // 回填生效
  });

  it("sidecar 标记文件被直删（DELETE /file）→ 标记即时熄灭", async () => {
    const env = ctx("GET", []).env;
    const scope = await resolveScope(env);
    env.FILES._store.set(`${scope}VoiceDrop-x.m4a`, "AUDIO");
    await call(env, "PUT", ["articles", "VoiceDrop-x", "empty"], { body: {} });
    expect((await call(env, "GET", ["recordings"])).recordings[0].isEmpty).toBe(true);

    await call(env, "DELETE", ["file", "articles", "VoiceDrop-x.empty"]);
    expect((await call(env, "GET", ["recordings"])).recordings[0].isEmpty).toBe(false);
  });

  it("删文章（DELETE /articles/<stem>）→ hasArticles 熄灭", async () => {
    const env = ctx("GET", []).env;
    const scope = await resolveScope(env);
    env.FILES._store.set(`${scope}VoiceDrop-y.m4a`, "AUDIO");
    await call(env, "PUT", ["articles", "VoiceDrop-y"], { body: { articles: [{ title: "T", body: "B" }] } });
    expect((await call(env, "GET", ["recordings"])).recordings[0].hasArticles).toBe(true);
    await call(env, "DELETE", ["articles", "VoiceDrop-y"]);
    expect((await call(env, "GET", ["recordings"])).recordings[0].hasArticles).toBe(false);
  });

  it("admin token（无 scope）→ 400", async () => {
    const c = ctx("GET", ["recordings"]);
    c.request = new Request("https://jianshuo.dev/files/api/recordings", {
      headers: { Authorization: "Bearer admin" },
    });
    expect((await onRequest(c)).status).toBe(400);
  });
});
