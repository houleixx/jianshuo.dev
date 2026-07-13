import { describe, it, expect } from "vitest";
import { resolveList } from "../src/prompts.js";

// 小模板，测试自带，不依赖真模板的内容（真模板的内容由 prompt-template.test.js 盯）
const TPL = {
  schema: 1,
  items: [
    { id: "sys_g", type: "group", label: "图片风格", children: [
      { id: "sys_a", type: "action", label: "卡通", prompt: "原始卡通", appliesTo: ["image"], kind: "image" },
      { id: "sys_b", type: "action", label: "水彩", prompt: "原始水彩", appliesTo: ["image"], kind: "image" },
    ]},
    { id: "sys_c", type: "action", label: "更简洁", prompt: "原始简洁", appliesTo: ["text"] },
  ],
};

describe("resolveList — 无用户文档 = 模板全量跟随", () => {
  it("null userDoc → 模板全量，全部 origin=system", () => {
    const out = resolveList(TPL, null);
    expect(out.map((n) => n.id)).toEqual(["sys_g", "sys_c"]);
    expect(out[0].origin).toBe("system");
    expect(out[0].children.map((c) => c.id)).toEqual(["sys_a", "sys_b"]);
    expect(out[0].children[0].origin).toBe("system");
    expect(out[0].children[0].prompt).toBe("原始卡通");
    expect(out[1].origin).toBe("system");
  });
});

describe("resolveList — ref 跟随模板（核心性质）", () => {
  const doc = { schema: 1, items: [
    { ref: "sys_g", children: [{ ref: "sys_a" }] },
    { ref: "sys_c" },
  ]};

  it("ref 项整条读模板内容", () => {
    const out = resolveList(TPL, doc);
    expect(out[0].label).toBe("图片风格");
    expect(out[0].children[0].prompt).toBe("原始卡通");
    expect(out[0].children[0].kind).toBe("image");
    expect(out[1].prompt).toBe("原始简洁");
  });

  it("★ 模板改了 prompt → ref 项跟着变（不折腾的用户永远吃最新）", () => {
    const tuned = JSON.parse(JSON.stringify(TPL));
    tuned.items[0].children[0].prompt = "调优后的卡通";
    tuned.items[1].prompt = "调优后的简洁";
    const out = resolveList(tuned, doc);
    expect(out[0].children[0].prompt).toBe("调优后的卡通");
    expect(out[1].prompt).toBe("调优后的简洁");
  });

  it("用户列表的顺序覆盖模板顺序", () => {
    const reordered = { schema: 1, items: [{ ref: "sys_c" }, { ref: "sys_g", children: [{ ref: "sys_b" }] }] };
    const out = resolveList(TPL, reordered);
    expect(out.map((n) => n.id)).toEqual(["sys_c", "sys_g"]);
    expect(out[1].children.map((c) => c.id)).toEqual(["sys_b"]);
  });

  it("模板删了某条 → 悬空 ref 静默跳过，不崩", () => {
    const shrunk = { schema: 1, items: [TPL.items[0]] };  // 没有 sys_c 了
    const out = resolveList(shrunk, doc);
    expect(out.map((n) => n.id)).toEqual(["sys_g"]);
  });

  it("模板删了组里某条 → 组还在，那个 child 消失", () => {
    const shrunk = JSON.parse(JSON.stringify(TPL));
    shrunk.items[0].children = [shrunk.items[0].children[1]];   // 只剩 sys_b
    const out = resolveList(shrunk, { schema: 1, items: [{ ref: "sys_g", children: [{ ref: "sys_a" }, { ref: "sys_b" }] }] });
    expect(out[0].children.map((c) => c.id)).toEqual(["sys_b"]);
  });
});

describe("resolveList — 实体（fork / 自建）", () => {
  it("fork 一条：只有那条冻结，其余仍跟随模板", () => {
    const doc = { schema: 1, items: [
      { ref: "sys_g", children: [
        { id: "p_abc123", type: "action", label: "卡通风", prompt: "我改过的", appliesTo: ["image"], forkedFrom: "sys_a" },
        { ref: "sys_b" },
      ]},
    ]};
    const tuned = JSON.parse(JSON.stringify(TPL));
    tuned.items[0].children[0].prompt = "调优后的卡通";   // 被 fork 的那条，模板变了
    tuned.items[0].children[1].prompt = "调优后的水彩";   // 没 fork 的那条

    const out = resolveList(tuned, doc);
    expect(out[0].children[0].prompt).toBe("我改过的");        // 冻结
    expect(out[0].children[0].origin).toBe("custom");
    expect(out[0].children[0].forkedFrom).toBe("sys_a");
    expect(out[0].children[1].prompt).toBe("调优后的水彩");    // 仍跟随
    expect(out[0].children[1].origin).toBe("system");
  });

  it("纯自建（无 forkedFrom）→ origin=user", () => {
    const doc = { schema: 1, items: [
      { id: "p_zq1f6e", type: "action", label: "写成小红书", prompt: "口语、emoji…", appliesTo: ["text"] },
    ]};
    const out = resolveList(TPL, doc);
    expect(out[0].origin).toBe("user");
    expect(out[0].forkedFrom).toBeUndefined();
  });

  it("★ 轻度触碰不冻结全局：新增一条自建，系统项仍是 ref、仍跟随", () => {
    const doc = { schema: 1, items: [
      { ref: "sys_c" },
      { id: "p_zq1f6e", type: "action", label: "写成小红书", prompt: "我的", appliesTo: ["text"] },
    ]};
    const tuned = JSON.parse(JSON.stringify(TPL));
    tuned.items[1].prompt = "调优后的简洁";
    const out = resolveList(tuned, doc);
    expect(out[0].prompt).toBe("调优后的简洁");   // 系统项照样跟随
    expect(out[1].prompt).toBe("我的");
  });

  it("fork 一个 group：label 冻结，children 照常解析", () => {
    const doc = { schema: 1, items: [
      { id: "p_grp001", type: "group", label: "我的图片风格", forkedFrom: "sys_g", children: [{ ref: "sys_a" }] },
    ]};
    const out = resolveList(TPL, doc);
    expect(out[0].label).toBe("我的图片风格");
    expect(out[0].origin).toBe("custom");
    expect(out[0].children[0].prompt).toBe("原始卡通");
  });

  it("空 items → 空列表（用户把所有条目都删了）", () => {
    expect(resolveList(TPL, { schema: 1, items: [] })).toEqual([]);
  });
});
