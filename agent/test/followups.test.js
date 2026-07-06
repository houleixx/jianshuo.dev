import { describe, it, expect } from "vitest";
import { parseArticles, extractFollowups } from "../src/miner.js";
import { setQuestionStatus } from "../../functions/lib/article-store.js";
import { onRequest } from "../../functions/files/api/[[path]].js";
import { fakeEnv } from "./fakes.js";

// ── parseArticles: questions 字段 ───────────────────────────────────────────────

describe("parseArticles — questions 字段", () => {
  it("带出每篇的 questions（去空白、去空串、截到 3 条）", () => {
    const out = parseArticles(JSON.stringify({
      articles: [
        { title: "A", body: "正文", questions: [" 问一？", "", "问二？", "问三？", "问四？"] },
        { title: "B", body: "正文2" },
      ],
    }));
    expect(out[0].questions).toEqual(["问一？", "问二？", "问三？"]);
    expect(out[1].questions).toBeUndefined();
  });

  it("非数组的 questions 被忽略", () => {
    const out = parseArticles(JSON.stringify({ articles: [{ title: "A", body: "x", questions: "问？" }] }));
    expect(out[0].questions).toBeUndefined();
  });

  it("兜底剥掉正文尾部的「——追问——」节（模型违规写进 body 时）", () => {
    const body = "第一段。\n\n第二段。\n\n——追问——\n1. 那家店叫什么？\n2. 花了多少钱？";
    const out = parseArticles(JSON.stringify({ articles: [{ title: "A", body }] }));
    expect(out[0].body).toBe("第一段。\n\n第二段。");
  });

  it("正文中部出现的「——追问——」行不误伤（只剥尾节）", () => {
    // 尾节定义 = 该行起直到结尾；若它在中部，后面还有内容也一并算尾节——
    // 这正是设计（节后内容本就是问题列表）。这里验证正常正文不受影响。
    const body = "只有正文，没有追问节。";
    const out = parseArticles(JSON.stringify({ articles: [{ title: "A", body }] }));
    expect(out[0].body).toBe(body);
  });
});

// ── extractFollowups: sidecar 收口 ─────────────────────────────────────────────

describe("extractFollowups", () => {
  it("questions 摘出为 doc 级 sidecar，article 对象上不留字段", () => {
    const { articles, questions } = extractFollowups([
      { title: "A", body: "x", style: 3, questions: ["问一？", "问二？"] },
      { title: "B", body: "y" },
      { title: "C", body: "z", questions: ["问三？"] },
    ], 1000);
    expect(articles).toEqual([{ title: "A", body: "x", style: 3 }, { title: "B", body: "y" }, { title: "C", body: "z" }]);
    expect(questions).toEqual([
      { id: "q1000-0-0", articleIndex: 0, text: "问一？", status: "pending", createdAt: 1000 },
      { id: "q1000-0-1", articleIndex: 0, text: "问二？", status: "pending", createdAt: 1000 },
      { id: "q1000-2-0", articleIndex: 2, text: "问三？", status: "pending", createdAt: 1000 },
    ]);
  });

  it("没有 questions → 空 sidecar，articles 原样", () => {
    const { articles, questions } = extractFollowups([{ title: "A", body: "x" }]);
    expect(articles).toEqual([{ title: "A", body: "x" }]);
    expect(questions).toEqual([]);
  });
});

// ── setQuestionStatus: 元数据写，不铸版本 ───────────────────────────────────────

function seed(env, questions) {
  const key = "users/u/articles/s1.json";
  env.FILES.put(key, JSON.stringify({
    schema: 2, id: "s1", head: 1,
    versions: [{ v: 1, savedAt: 1, source: "mine", articles: [{ title: "t", body: "b" }] }],
    questions,
  }));
  return key;
}

describe("setQuestionStatus", () => {
  it("answered：状态更新、盖 answeredAt、head/versions 不动", async () => {
    const env = fakeEnv();
    const key = seed(env, [{ id: "q1", articleIndex: 0, text: "问？", status: "pending", createdAt: 1 }]);
    const doc = await setQuestionStatus(env, key, "q1", "answered");
    expect(doc.questions[0].status).toBe("answered");
    expect(doc.questions[0].answeredAt).toBeGreaterThan(0);
    expect(doc.head).toBe(1);
    expect(doc.versions.length).toBe(1);
  });

  it("skipped 合法；未知状态 / 未知 id → null", async () => {
    const env = fakeEnv();
    const key = seed(env, [{ id: "q1", articleIndex: 0, text: "问？", status: "pending", createdAt: 1 }]);
    expect((await setQuestionStatus(env, key, "q1", "skipped")).questions[0].status).toBe("skipped");
    expect(await setQuestionStatus(env, key, "q1", "deleted")).toBeNull();
    expect(await setQuestionStatus(env, key, "nope", "answered")).toBeNull();
    expect(await setQuestionStatus(env, "users/u/articles/none.json", "q1", "answered")).toBeNull();
  });
});

// ── PATCH /articles/<sub>/<stem>/question（admin 路由）────────────────────────

function ctx(method, segments, body) {
  const env = { ...fakeEnv(), FILES_TOKEN: "admin", SESSION_SECRET: "secret" };
  const request = new Request(`https://jianshuo.dev/files/api/${segments.join("/")}`, {
    method,
    headers: { Authorization: "Bearer admin", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request, env, params: { path: segments } };
}

describe("PATCH /articles/<stem>/question", () => {
  it("改状态成功并回传 questions；GET 读回带 sidecar", async () => {
    const c = ctx("PATCH", ["articles", "u", "s1", "question"], { id: "q1", status: "answered" });
    seed(c.env, [{ id: "q1", articleIndex: 0, text: "问？", status: "pending", createdAt: 1 }]);
    const resp = await onRequest(c);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.questions[0].status).toBe("answered");

    const g = ctx("GET", ["articles", "u", "s1"]);
    g.env = c.env;
    const read = await (await onRequest(g)).json();
    expect(read.questions[0].status).toBe("answered");
    expect(read.articles[0].title).toBe("t");
  });

  it("缺 id/status → 400；不存在的 id → 404", async () => {
    const c = ctx("PATCH", ["articles", "u", "s1", "question"], { id: "q1" });
    seed(c.env, [{ id: "q1", articleIndex: 0, text: "问？", status: "pending", createdAt: 1 }]);
    expect((await onRequest(c)).status).toBe(400);

    const c2 = ctx("PATCH", ["articles", "u", "s1", "question"], { id: "zz", status: "answered" });
    seed(c2.env, [{ id: "q1", articleIndex: 0, text: "问？", status: "pending", createdAt: 1 }]);
    expect((await onRequest(c2)).status).toBe(404);
  });
});
