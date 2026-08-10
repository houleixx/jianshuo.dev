// test/feedback-admin.test.js — GET /files/api/feedback/{dates,list}（admin/feedback.html 后端）：
// admin-only 403、日期文件夹列举、按天连内容返回并按 ts 倒序、坏 JSON 跳过。
import { describe, it, expect } from "vitest";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

function reqCtx(segments, { token = "admin", query = "" } = {}) {
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { request, env, params: { path: segments } };
}

function seed(env) {
  env.FILES._store.set("feedback/2026-08-09/100-aaa.json",
    JSON.stringify({ ts: "2026-08-09T10:00:00Z", scope: "users/anon-1/", name: "甲", text: "早的" }));
  env.FILES._store.set("feedback/2026-08-09/200-bbb.json",
    JSON.stringify({ ts: "2026-08-09T11:00:00Z", scope: "users/anon-2/", name: "乙", text: "晚的" }));
  env.FILES._store.set("feedback/2026-08-09/300-bad.json", "not json{{");
  env.FILES._store.set("feedback/2026-08-10/400-ccc.json",
    JSON.stringify({ ts: "2026-08-10T01:00:00Z", scope: "users/anon-3/", name: "丙", text: "次日" }));
}

describe("GET /files/api/feedback", () => {
  it("403s for a non-admin token", async () => {
    const c = reqCtx(["feedback", "dates"], { token: "anon_" + "x".repeat(28) });
    expect((await onRequest(c)).status).toBe(403);
  });

  it("dates lists day folders newest-first", async () => {
    const c = reqCtx(["feedback", "dates"]);
    seed(c.env);
    const d = await (await onRequest(c)).json();
    expect(d.dates).toEqual(["2026-08-10", "2026-08-09"]);
  });

  it("list returns that day's items with content, ts-desc, skipping bad JSON", async () => {
    const c = reqCtx(["feedback", "list"], { query: "?date=2026-08-09" });
    seed(c.env);
    const d = await (await onRequest(c)).json();
    expect(d.items.map((i) => i.text)).toEqual(["晚的", "早的"]);
    expect(d.items[0].key).toBe("feedback/2026-08-09/200-bbb.json");
    expect(d.items[0].scope).toBe("users/anon-2/");
  });

  it("list 400s without a valid date", async () => {
    const c = reqCtx(["feedback", "list"]);
    expect((await onRequest(c)).status).toBe(400);
  });
});
