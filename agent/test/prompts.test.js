import { describe, it, expect } from "vitest";
import { resolveList, validateList } from "../src/prompts.js";

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

describe("resolveList — 防御性拷贝（不能让解析结果引用模板里的同一个数组/对象）", () => {
  it("★ ref 解析出的节点，appliesTo 不是模板节点的同一个对象引用（否则一个请求改了输出会污染全局模板）", () => {
    const out = resolveList(TPL, null);
    const resolvedAction = out[0].children[0]; // sys_a
    const templateAction = TPL.items[0].children[0]; // sys_a in template
    expect(resolvedAction.appliesTo).toEqual(templateAction.appliesTo);
    expect(resolvedAction.appliesTo).not.toBe(templateAction.appliesTo);
  });

  it("imageParams 同理，不共享引用", () => {
    const tplWithParams = JSON.parse(JSON.stringify(TPL));
    tplWithParams.items[0].children[0].imageParams = { size: "1024x1024" };
    const out = resolveList(tplWithParams, null);
    const resolvedAction = out[0].children[0];
    expect(resolvedAction.imageParams).toEqual({ size: "1024x1024" });
    expect(resolvedAction.imageParams).not.toBe(tplWithParams.items[0].children[0].imageParams);
  });

  it("fork（fromEntity）出的实体，appliesTo 也不是入参节点的同一个对象引用", () => {
    const doc = { schema: 1, items: [
      { id: "p_abc123", type: "action", label: "自建", prompt: "内容", appliesTo: ["text", "image"] },
    ]};
    const out = resolveList(TPL, doc);
    expect(out[0].appliesTo).toEqual(["text", "image"]);
    expect(out[0].appliesTo).not.toBe(doc.items[0].appliesTo);
  });
});

describe("validateList — PUT 的守门人", () => {
  const ok = (items) => validateList(TPL, items);
  const entity = (over = {}) => ({ id: "p_abc123", type: "action", label: "我的", prompt: "内容", appliesTo: ["text"], ...over });

  it("合法列表 → null", () => {
    expect(ok([{ ref: "sys_g", children: [{ ref: "sys_a" }] }, entity()])).toBeNull();
  });

  it("非数组 → 报错", () => {
    expect(validateList(TPL, null)).toMatch(/items/);
    expect(validateList(TPL, "nope")).toMatch(/items/);
  });

  it("未知 ref → 报错", () => {
    expect(ok([{ ref: "sys_nope" }])).toMatch(/unknown ref/);
  });

  it("实体 id 格式非法 → 报错", () => {
    expect(ok([entity({ id: "abc" })])).toMatch(/id/);
    expect(ok([entity({ id: "p_AB" })])).toMatch(/id/);       // 大写 + 太短
    expect(ok([entity({ id: "sys_a" })])).toMatch(/id/);      // 不许冒充 sys_
  });

  it("id 全树重复 → 报错（含跨层级）", () => {
    expect(ok([entity(), entity()])).toMatch(/duplicate/);
    expect(ok([
      { id: "p_grp001", type: "group", label: "组", children: [entity()] },
      entity(),
    ])).toMatch(/duplicate/);
  });

  it("两级封顶：group 套 group → 报错", () => {
    expect(ok([{
      id: "p_grp001", type: "group", label: "外", children: [
        { id: "p_grp002", type: "group", label: "内", children: [] },
      ],
    }])).toMatch(/two levels|group/);
  });

  it("action 的 appliesTo 空 / 非法值 → 报错", () => {
    expect(ok([entity({ appliesTo: [] })])).toMatch(/appliesTo/);
    expect(ok([entity({ appliesTo: ["video"] })])).toMatch(/appliesTo/);
    expect(ok([entity({ appliesTo: "text" })])).toMatch(/appliesTo/);
  });

  it("group 不许带 prompt / appliesTo → 报错", () => {
    expect(ok([{ id: "p_grp001", type: "group", label: "组", prompt: "x", children: [] }])).toMatch(/group/);
    expect(ok([{ id: "p_grp001", type: "group", label: "组", appliesTo: ["text"], children: [] }])).toMatch(/group/);
  });

  it("label > 40 / prompt > 4000 → 报错", () => {
    expect(ok([entity({ label: "长".repeat(41) })])).toMatch(/label/);
    expect(ok([entity({ prompt: "长".repeat(4001) })])).toMatch(/prompt/);
  });

  it("空 label → 报错", () => {
    expect(ok([entity({ label: "  " })])).toMatch(/label/);
  });

  it("未知 type → 报错", () => {
    expect(ok([entity({ type: "widget" })])).toMatch(/type/);
  });

  it("超过 200 条 → 报错", () => {
    const many = Array.from({ length: 201 }, (_, i) => entity({ id: `p_x${String(i).padStart(5, "0")}` }));
    expect(ok(many)).toMatch(/too many/);
  });

  it("空列表合法（用户可以删光）", () => {
    expect(ok([])).toBeNull();
  });

  it("CRITICAL① label 上限不能被前导空白绕过（校验必须用原始长度，不是 trim 后的）", () => {
    expect(ok([entity({ label: " ".repeat(10000) + "A" })])).toMatch(/label/);
  });

  it("空白 only 的 label 仍然算空（不能因为①的修复而误判合法空白）", () => {
    expect(ok([entity({ label: "   " })])).toMatch(/label/);
  });

  it("CRITICAL② action 节点（ref 到 action）不许带 children —— 否则未校验的任意载荷直接进库", () => {
    const badChildren = Array.from({ length: 500 }, (_, i) => ({
      id: `not a valid id ${i}`,
      type: "group",
      label: "",
      appliesTo: "not-an-array",
    }));
    expect(ok([{ ref: "sys_a", children: badChildren }])).toMatch(/children/);
  });

  it("CRITICAL② action 节点（实体 type:action）不许带 children", () => {
    const badChildren = Array.from({ length: 500 }, (_, i) => ({
      id: `not a valid id ${i}`,
      type: "group",
      label: "",
      appliesTo: "not-an-array",
    }));
    expect(ok([entity({ children: badChildren })])).toMatch(/children/);
  });

  it("合法的 group 嵌套（group 带 children）依然通过，且 children 计入 200 条上限", () => {
    expect(ok([{ ref: "sys_g", children: [{ ref: "sys_a" }, { ref: "sys_b" }] }])).toBeNull();

    const many = Array.from({ length: 199 }, (_, i) => entity({ id: `p_x${String(i).padStart(5, "0")}` }));
    const withGroup = [{ id: "p_grp001", type: "group", label: "组", children: [entity({ id: "p_child01" })] }, ...many];
    // 1 (group) + 1 (child) + 199 = 201 > 200
    expect(ok(withGroup)).toMatch(/too many/);
  });
});

describe("validateList/resolveList — IMPORTANT③ imageParams 深拷贝（不能与模板共享嵌套引用）", () => {
  const tplWithNestedParams = {
    schema: 1,
    items: [
      { id: "sys_c", type: "action", label: "更简洁", prompt: "原始简洁", appliesTo: ["text"],
        imageParams: { size: "1024x1024", nested: { seed: 1 }, tags: ["a", "b"] } },
    ],
  };

  it("ref 解析出的 imageParams 嵌套对象不与模板节点共享引用", () => {
    const out = resolveList(tplWithNestedParams, null);
    const resolvedAction = out[0];
    const templateAction = tplWithNestedParams.items[0];
    expect(resolvedAction.imageParams).toEqual(templateAction.imageParams);
    expect(resolvedAction.imageParams.nested).not.toBe(templateAction.imageParams.nested);
    expect(resolvedAction.imageParams.tags).not.toBe(templateAction.imageParams.tags);

    // 手滑改了解析结果的嵌套字段，不能污染模板（活过整个 Worker isolate）
    resolvedAction.imageParams.nested.seed = 999;
    expect(templateAction.imageParams.nested.seed).toBe(1);
  });

  it("fork（fromEntity）出的实体，imageParams 嵌套对象也不与入参共享引用", () => {
    const doc = { schema: 1, items: [
      { id: "p_abc123", type: "action", label: "自建", prompt: "内容", appliesTo: ["text"],
        imageParams: { nested: { seed: 1 } } },
    ]};
    const out = resolveList(TPL, doc);
    expect(out[0].imageParams).toEqual(doc.items[0].imageParams);
    expect(out[0].imageParams.nested).not.toBe(doc.items[0].imageParams.nested);

    out[0].imageParams.nested.seed = 999;
    expect(doc.items[0].imageParams.nested.seed).toBe(1);
  });
});
