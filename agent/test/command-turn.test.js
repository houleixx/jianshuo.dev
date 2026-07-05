import { describe, it, expect, vi } from "vitest";
import { runCommandTurn } from "../src/command-turn.js";

describe("runCommandTurn", () => {
  it("把 refs 编号清单喂进 prompt，并驱动命令工具集", async () => {
    let sawToolNames = null, sawUser = null;
    const callClaude = vi.fn(async ({ tools, messages }) => {
      sawToolNames = tools.map((t) => t.name);
      sawUser = JSON.stringify(messages);
      // 直接收尾（纯文本），不调工具
      return { content: [{ type: "text", text: "好的" }], usage: {} };
    });
    const env = { FILES: { async get() { return null; } } };
    const r = await runCommandTurn({
      env, scope: "users/x/", token: "tk", origin: "https://jianshuo.dev", turnId: "T1",
      instruction: "把③和④合并", refs: [
        { n: 1, stem: "S1", title: "一" }, { n: 2, stem: "S2", title: "二" },
        { n: 3, stem: "S3", title: "三" }, { n: 4, stem: "S4", title: "四" },
      ], callClaude,
    });
    expect(r.ok).toBe(true);
    expect(sawToolNames).toContain("merge_articles");
    expect(sawToolNames).not.toContain("edit_current_article");
    expect(sawUser).toContain("第3篇");   // 编号清单出现在 prompt
    expect(sawUser).toContain("S3");       // stem 映射可见
    expect(sawUser).toContain("把③和④合并");
  });

  it("history 前置在本轮指令之前（跨轮上下文）", async () => {
    let sawMessages = null;
    const callClaude = vi.fn(async ({ messages }) => {
      sawMessages = messages;
      return { content: [{ type: "text", text: "好" }], usage: {} };
    });
    const env = { FILES: { async get() { return null; } } };
    const history = [
      { role: "user", content: "把第2篇归到创业" },
      { role: "assistant", content: "已归类到「创业」" },
    ];
    const r = await runCommandTurn({
      env, scope: "users/x/", token: "tk", origin: "https://jianshuo.dev", turnId: "T3",
      instruction: "刚才那篇的标签去掉", refs: [{ n: 2, stem: "S2", title: "二" }], callClaude, history,
    });
    expect(r.ok).toBe(true);
    expect(sawMessages[0]).toEqual(history[0]);              // 历史在最前
    expect(sawMessages[1]).toEqual(history[1]);
    expect(JSON.stringify(sawMessages[2])).toContain("刚才那篇的标签去掉");  // 本轮殿后
  });

  it("透传工具 pending（破坏性删除待确认）", async () => {
    const callClaude = vi.fn(async () => ({ content: [
      { type: "text", text: "要删第②篇吗" },
      { type: "tool_use", id: "d1", name: "delete_article", input: { stem: "S2" } },
    ], usage: {} }));
    const env = { FILES: { async get(k) { return k.endsWith("S2.json") ? { async text() { return JSON.stringify({ articles: [{ title: "二", body: "x" }] }); } } : null; } } };
    const r = await runCommandTurn({
      env, scope: "users/x/", token: "tk", origin: "https://jianshuo.dev", turnId: "T2",
      instruction: "删掉第②篇", refs: [{ n: 2, stem: "S2", title: "二" }], callClaude,
    });
    expect(r.pending).toEqual([{ action: "delete", stem: "S2", title: "二" }]);
  });
});
