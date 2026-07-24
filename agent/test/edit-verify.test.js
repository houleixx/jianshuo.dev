import { describe, it, expect, afterEach } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { runEditTurn, diffBodyLines, promptCatalogLine } from "../src/edit-turn.js";
import { fakeEnv, fakeFetch } from "./fakes.js";

afterEach(() => { delete globalThis.fetch; });

const asst = (...blocks) => ({ role: "assistant", content: blocks });
const toolUse = (name, input, id = name + "-1") => ({ type: "tool_use", id, name, input });
const text = (t) => ({ type: "text", text: t });
const ctx = (env) => ({ env, scope: "users/u/", articleKey: "users/u/articles/cur.json", token: "t", origin: "https://x" });

// 一个通过 HTTP fake 真正落盘的 write_article 环境（照 edit-turn.test.js 的套路）。
async function writableEnv(seed) {
  const env = fakeEnv(seed);
  const { writeArticleDoc } = await import("../../functions/lib/article-store.js");
  globalThis.fetch = fakeFetch({
    "PUT https://x/files/api/articles/cur": async ({ init }) => {
      await writeArticleDoc(env, "users/u/articles/cur.json", JSON.parse(init.body), "agent");
      return { ok: true, body: { ok: true } };
    },
  });
  return env;
}

describe("diffBodyLines", () => {
  it("lists removed and added lines only", () => {
    expect(diffBodyLines("a\nb\nc", "a\nx\nc")).toBe("- b\n+ x");
  });
  it("returns empty string when nothing changed", () => {
    expect(diffBodyLines("a\nb", "a\nb")).toBe("");
  });
  it("handles duplicated lines by multiplicity", () => {
    expect(diffBodyLines("a\na\nb", "a\nb")).toBe("- a");
  });
  it("caps huge diffs", () => {
    const before = Array.from({ length: 200 }, (_, i) => `old${i}`).join("\n");
    const d = diffBodyLines(before, "new");
    expect(d).toContain("行未列出");
  });
});

describe("runAgentLoop verify hook", () => {
  const seed = () => ({ "users/u/articles/cur.json": JSON.stringify({ schema: 2, transcript: "T", articles: [{ title: "C", body: "old" }] }) });

  it("passes: terminal short-circuit unchanged, verify called once with terminal names", async () => {
    const env = await writableEnv(seed());
    const script = [asst(text("改好了"), toolUse("write_article", { articles: [{ title: "C", body: "new" }] })), asst(text("不该到这"))];
    let i = 0;
    const seen = [];
    const r = await runAgentLoop({
      callClaude: async () => script[i++], ctx: ctx(env), system: "S", userContent: "改",
      verify: async ({ terminalNames }) => { seen.push(terminalNames); return null; },
    });
    expect(r.finalText).toBe("改好了");
    expect(i).toBe(1); // 校验通过 → 照旧短路，不多打一次模型
    expect(seen).toEqual([["write_article"]]);
    expect(r.verifyIssues).toEqual([]);
  });

  it("fails: cancels the short-circuit, feeds the issue back, and verifies only once", async () => {
    const env = await writableEnv(seed());
    const script = [
      asst(text("改好了"), toolUse("write_article", { articles: [{ title: "C", body: "wrong" }] })),
      asst(text("修好了"), toolUse("write_article", { articles: [{ title: "C", body: "right" }] }, "wa-2")),
      asst(text("不该到这")),
    ];
    let i = 0, calls = 0;
    let issueMsg;
    const r = await runAgentLoop({
      callClaude: async ({ messages }) => { issueMsg = messages; return script[i++]; },
      ctx: ctx(env), system: "S", userContent: "改",
      verify: async () => { calls++; return "第3行没有按指令改"; },
    });
    expect(calls).toBe(1); // 一回合只验一次——第二次 write_article 成功后直接短路
    expect(i).toBe(2);
    expect(r.finalText).toBe("修好了");
    expect(r.verifyIssues).toEqual(["第3行没有按指令改"]);
    // 对话里存在一条 user 消息：tool_result 之后跟着校验文本块（不另起消息，保持交替）
    const textBlocks = issueMsg
      .filter((m) => m.role === "user" && Array.isArray(m.content))
      .flatMap((m) => m.content.filter((b) => b.type === "text"));
    const vb = textBlocks.find((b) => b.text.includes("【自动校验】"));
    expect(vb).toBeTruthy();
    expect(vb.text).toContain("第3行没有按指令改");
  });

  it("verify throwing = pass-through (never breaks a successful edit)", async () => {
    const env = await writableEnv(seed());
    const script = [asst(text("改好了"), toolUse("write_article", { articles: [{ title: "C", body: "new" }] }))];
    let i = 0;
    const r = await runAgentLoop({
      callClaude: async () => script[i++], ctx: ctx(env), system: "S", userContent: "改",
      verify: async () => { throw new Error("haiku down"); },
    });
    expect(r.finalText).toBe("改好了");
    expect(r.hadError).toBe(false);
  });

  it("no terminal tool = verify never called", async () => {
    const env = fakeEnv(seed());
    let calls = 0;
    const r = await runAgentLoop({
      callClaude: async () => asst(text("就聊聊")), ctx: ctx(env), system: "S", userContent: "hi",
      verify: async () => { calls++; return "x"; },
    });
    expect(calls).toBe(0);
    expect(r.finalText).toBe("就聊聊");
  });
});

describe("runEditTurn write-after verify", () => {
  const seed = () => ({
    "users/u/articles/s.json": JSON.stringify({ schema: 2, createdAt: 1, transcript: "原文", articles: [{ title: "T", body: "第一段\n\n第二段" }] }),
  });
  const baseArgs = (env, callClaude, callVerify) => ({
    env, scope: "users/u/", articleKey: "users/u/articles/s.json",
    token: "t", origin: "https://jianshuo.dev", editId: "e1",
    instruction: "把第二段改成 DONE", images: [], system: "SYS", history: [],
    callClaude, callVerify,
  });
  const writableS = async (env) => {
    const { writeArticleDoc } = await import("../../functions/lib/article-store.js");
    globalThis.fetch = fakeFetch({
      "PUT https://jianshuo.dev/files/api/articles/s": async ({ init }) => {
        await writeArticleDoc(env, "users/u/articles/s.json", JSON.parse(init.body), "agent");
        return { ok: true, body: { ok: true } };
      },
    });
  };
  const verdict = (ok, issue = "") => ({ content: [{ type: "text", text: JSON.stringify({ ok, issue }) }] });

  it("haiku says not-ok → the model gets a second round to fix", async () => {
    const env = fakeEnv(seed());
    await writableS(env);
    const script = [
      asst(text("改好了"), toolUse("write_article", { articles: [{ title: "T", body: "第一段\n\n错的" }] })),
      asst(text("修好了"), toolUse("write_article", { articles: [{ title: "T", body: "第一段\n\nDONE" }] }, "wa-2")),
    ];
    let i = 0;
    const verifySeen = [];
    const callVerify = async ({ system, messages }) => {
      verifySeen.push({ system, user: messages[0].content });
      return verdict(false, "第二段没有改成 DONE");
    };
    const res = await runEditTurn(baseArgs(env, async () => script[i++], callVerify));
    expect(res.ok).toBe(true);
    expect(i).toBe(2); // 第一轮被打回，第二轮修正后短路
    expect(res.article.articles[0].body).toContain("DONE");
    // 质检员拿到的是指令 + diff（含被改坏的行），不是整篇文章
    expect(verifySeen).toHaveLength(1);
    expect(verifySeen[0].user).toContain("把第二段改成 DONE");
    expect(verifySeen[0].user).toContain("+ 错的");
    expect(verifySeen[0].system).toContain("质检员");
  });

  it("haiku says ok → single round, no extra model call", async () => {
    const env = fakeEnv(seed());
    await writableS(env);
    let i = 0, verifies = 0;
    const script = [asst(text("改好了"), toolUse("write_article", { articles: [{ title: "T", body: "第一段\n\nDONE" }] }))];
    const res = await runEditTurn(baseArgs(env, async () => script[i++], async () => { verifies++; return verdict(true); }));
    expect(res.ok).toBe(true);
    expect(res.reply).toBe("改好了");
    expect(i).toBe(1);
    expect(verifies).toBe(1);
  });

  it("no body change (title only) → verifier model not called at all", async () => {
    const env = fakeEnv(seed());
    await writableS(env);
    let verifies = 0;
    const script = [asst(text("标题改好了"), toolUse("write_article", { articles: [{ title: "新标题", body: "第一段\n\n第二段" }] }))];
    let i = 0;
    const res = await runEditTurn(baseArgs(env, async () => script[i++], async () => { verifies++; return verdict(false, "x"); }));
    expect(res.ok).toBe(true);
    expect(verifies).toBe(0);
  });

  it("garbage verifier output = pass-through", async () => {
    const env = fakeEnv(seed());
    await writableS(env);
    const script = [asst(text("改好了"), toolUse("write_article", { articles: [{ title: "T", body: "第一段\n\nDONE" }] }))];
    let i = 0;
    const res = await runEditTurn(baseArgs(env, async () => script[i++], async () => ({ content: [{ type: "text", text: "不是JSON" }] })));
    expect(res.ok).toBe(true);
    expect(res.reply).toBe("改好了");
  });
});

describe("promptCatalogLine", () => {
  it("lists template groups and labels for a user with no prompts.json", async () => {
    const env = fakeEnv({});
    const line = await promptCatalogLine(env, "users/u/");
    expect(line).toContain("【我的提示词菜单】");
    expect(line).toContain("图片风格：卡通/广告/水彩/素描/油画/胶片");
    expect(line).toContain("合影照片：");
  });
  it("uses the user's own tree when present", async () => {
    const env = fakeEnv({
      "users/u/prompts.json": JSON.stringify({ schema: 1, items: [
        { id: "p1", type: "action", label: "我的招牌改法", prompt: "X", appliesTo: ["text"] },
      ] }),
    });
    const line = await promptCatalogLine(env, "users/u/");
    expect(line).toContain("我的招牌改法");
    expect(line).not.toContain("图片风格");
  });
  it("storage failure degrades to the template catalog (loaders self-fallback, never throws)", async () => {
    const env = { FILES: { get: async () => { throw new Error("r2 down"); } } };
    const line = await promptCatalogLine(env, "users/u/");
    expect(line).toContain("图片风格：卡通");
  });
});
