import { describe, it, expect } from "vitest";
import { resolveList, validateList, restoreDefaults, MAX_ITEMS } from "../src/prompts.js";
import { DEFAULT_PROMPT_TEMPLATE } from "../src/prompt-template.js";

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

describe("validateList — CRITICAL① children 非数组必须报错，不能 throw", () => {
  // 用真实模板：sys_style 是 group，sys_cartoon 是它下面的 action（对齐 review 给的确切用例）。
  it("ref 指向 group，children 是个空对象 → 报错，不 throw", () => {
    expect(() => validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_style", children: {} }])).not.toThrow();
    expect(validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_style", children: {} }])).toMatch(/children/);
  });

  it("实体 group，children 是个空对象 → 报错，不 throw", () => {
    const items = [{ id: "p_grp001", type: "group", label: "组", children: {} }];
    expect(() => validateList(DEFAULT_PROMPT_TEMPLATE, items)).not.toThrow();
    expect(validateList(DEFAULT_PROMPT_TEMPLATE, items)).toMatch(/children/);
  });

  it("ref 指向 group，children 是数字 5 → 报错，不 throw", () => {
    expect(() => validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_style", children: 5 }])).not.toThrow();
    expect(validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_style", children: 5 }])).toMatch(/children/);
  });

  it("ref 指向 group，children 是 true → 报错，不 throw", () => {
    expect(() => validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_style", children: true }])).not.toThrow();
    expect(validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_style", children: true }])).toMatch(/children/);
  });
});

describe("validateList — CRITICAL② 未知字段必须被拒绝（严格白名单），不能悄悄进库", () => {
  it("ref 到 action（sys_cartoon）夹带 notChildren 大字段 → 必须报错，不能是 null", () => {
    const out = validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_cartoon", notChildren: "X".repeat(5_000_000) }]);
    expect(out).not.toBeNull();
    expect(typeof out).toBe("string");
  });

  it("ref 到 group（sys_style）夹带 junkPayload 大字段 → 必须报错，不能是 null", () => {
    const out = validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_style", junkPayload: "A".repeat(5_000_000) }]);
    expect(out).not.toBeNull();
    expect(typeof out).toBe("string");
  });

  it("实体 action 夹带未知字段 junk 大字段 → 必须报错，不能是 null", () => {
    const out = validateList(DEFAULT_PROMPT_TEMPLATE, [{
      id: "p_abc123", type: "action", label: "我的", prompt: "内容",
      appliesTo: ["text"], junk: "X".repeat(5_000_000),
    }]);
    expect(out).not.toBeNull();
    expect(typeof out).toBe("string");
  });

  it("实体 group 夹带未知字段 → 报错（对称：group 也要挡未知字段，不止 action）", () => {
    const out = validateList(TPL, [{ id: "p_grp001", type: "group", label: "组", children: [], weird: 1 }]);
    expect(out).not.toBeNull();
  });

  it("ref 节点混入 id 字段（企图同时冒充 ref 和实体）→ 报错，不是白名单外字段被静默忽略", () => {
    const out = validateList(TPL, [{ ref: "sys_g", id: "p_abc123", children: [] }]);
    expect(out).not.toBeNull();
  });

  it("白名单允许的字段齐全时仍然合法通过（ref 节点：ref+children；实体 action：全部允许字段）", () => {
    expect(validateList(DEFAULT_PROMPT_TEMPLATE, [{ ref: "sys_style", children: [{ ref: "sys_cartoon" }] }])).toBeNull();
    expect(validateList(TPL, [{
      id: "p_abc123", type: "action", label: "我的", prompt: "内容",
      appliesTo: ["text"], kind: "image", imageParams: { size: "1024x1024" }, forkedFrom: "sys_a",
    }])).toBeNull();
  });
});

describe("validateList — 必须是 total 函数：任何 JSON 可解析出的形状都不能 throw", () => {
  const hostileItems = [
    5, true, false, null, "x", [], [[]], [[[[[1]]]]],
    { ref: "sys_style", children: {} },
    { ref: "sys_style", children: 5 },
    { ref: "sys_style", children: true },
    { ref: "sys_style", children: "abc" },
    { ref: "sys_style", children: null },
    { ref: "sys_cartoon", children: [] },
    { ref: {} },
    { ref: [1, 2, 3] },
    { id: "p_grp001", type: "group", label: "组", children: {} },
    { id: "p_grp001", type: "group", label: "组", children: 5 },
    { id: "p_grp001", type: "group", label: "组", children: true },
    { id: 5, type: "group", children: [] },
    { id: "p_abc123", type: "action", label: {}, prompt: [], appliesTo: {} },
    {},
    [],
    "not an object",
    123,
    { ref: "sys_style", children: [{ ref: "sys_style", children: [{ ref: "sys_style", children: [] }] }] },
  ];

  it("逐个喂 hostile 顶层 item：永不 throw，结果永远是 string 或 null", () => {
    for (const item of hostileItems) {
      let result;
      expect(() => { result = validateList(DEFAULT_PROMPT_TEMPLATE, [item]); }).not.toThrow();
      expect(result === null || typeof result === "string").toBe(true);
    }
  });

  it("items 本身就是深层嵌套的 junk 数组 → 不 throw", () => {
    const deeplyNested = [[[[[[[[[[1]]]]]]]]]];
    let result;
    expect(() => { result = validateList(DEFAULT_PROMPT_TEMPLATE, deeplyNested); }).not.toThrow();
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("整棵 hostile 树一次性塞进 items（混合各种形状）→ 不 throw", () => {
    expect(() => validateList(DEFAULT_PROMPT_TEMPLATE, hostileItems)).not.toThrow();
  });
});

describe("validateList — 再验证：不能弱化任何已通过的合法路径（回归护栏）", () => {
  const ok = (items) => validateList(TPL, items);
  const entity = (over = {}) => ({ id: "p_abc123", type: "action", label: "我的", prompt: "内容", appliesTo: ["text"], ...over });

  it("空列表仍然合法", () => {
    expect(ok([])).toBeNull();
  });

  it("合法 group 嵌套仍然通过", () => {
    expect(ok([{ ref: "sys_g", children: [{ ref: "sys_a" }] }])).toBeNull();
  });

  it("group children 仍计入 200 条上限：1 group + 1 child + 198 siblings = 200 通过，201 失败", () => {
    const siblings198 = Array.from({ length: 198 }, (_, i) => entity({ id: `p_x${String(i).padStart(5, "0")}` }));
    const with200 = [{ id: "p_grp001", type: "group", label: "组", children: [entity({ id: "p_child01" })] }, ...siblings198];
    expect(ok(with200)).toBeNull();

    const siblings199 = Array.from({ length: 199 }, (_, i) => entity({ id: `p_x${String(i).padStart(5, "0")}` }));
    const with201 = [{ id: "p_grp001", type: "group", label: "组", children: [entity({ id: "p_child01" })] }, ...siblings199];
    expect(ok(with201)).toMatch(/too many/);
  });

  it("group 没有 children 这个 key（完全不写）依然合法", () => {
    expect(ok([{ id: "p_grp001", type: "group", label: "组" }])).toBeNull();
    expect(ok([{ ref: "sys_g" }])).toBeNull();
  });

  it("label 恰好 40 通过，41 失败", () => {
    expect(ok([entity({ label: "长".repeat(40) })])).toBeNull();
    expect(ok([entity({ label: "长".repeat(41) })])).toMatch(/label/);
  });

  it("prompt 恰好 4000 通过，4001 失败", () => {
    expect(ok([entity({ prompt: "长".repeat(4000) })])).toBeNull();
    expect(ok([entity({ prompt: "长".repeat(4001) })])).toMatch(/prompt/);
  });

  it("CRITICAL① 回归：label 上限不能被前导空白绕过", () => {
    expect(ok([entity({ label: " ".repeat(10000) + "A" })])).toMatch(/label/);
  });

  it("CRITICAL② 回归：action 节点（ref 到 action / 实体 action）不许带 children", () => {
    expect(ok([{ ref: "sys_a", children: [{ ref: "sys_b" }] }])).toMatch(/children/);
    expect(ok([entity({ children: [] })])).toMatch(/children/);
  });
});

describe("restoreDefaults — 补回模板里缺的（后悔药 + 拿系统新 prompt）", () => {
  it("删光了 → 补回模板全量（全是 ref）", () => {
    const out = restoreDefaults(TPL, []);
    expect(out).toEqual([
      { ref: "sys_g", children: [{ ref: "sys_a" }, { ref: "sys_b" }] },
      { ref: "sys_c" },
    ]);
  });

  it("只删了组内一条 → 只补那一条，补回该组末尾", () => {
    const items = [{ ref: "sys_g", children: [{ ref: "sys_b" }] }, { ref: "sys_c" }];
    const out = restoreDefaults(TPL, items);
    expect(out[0].children).toEqual([{ ref: "sys_b" }, { ref: "sys_a" }]);
    expect(out[1]).toEqual({ ref: "sys_c" });
  });

  it("组的 ref 完全没有 children 这个 key（= 空组）→ 恢复默认后必须显式带上 children（否则会被 resolveList 解析成空组）", () => {
    const items = [{ ref: "sys_g" }, { ref: "sys_c" }];
    const out = restoreDefaults(TPL, items);
    expect(out[0]).toHaveProperty("children");
    expect(out[0].children).toEqual([{ ref: "sys_a" }, { ref: "sys_b" }]);
  });

  it("★ 已 fork 的不重复补（认 forkedFrom）", () => {
    const forked = { id: "p_abc123", type: "action", label: "卡通风", prompt: "我的", appliesTo: ["image"], forkedFrom: "sys_a" };
    const items = [{ ref: "sys_g", children: [forked] }, { ref: "sys_c" }];
    const out = restoreDefaults(TPL, items);
    // sys_a 已被 fork → 不补；sys_b 缺 → 补
    expect(out[0].children).toEqual([forked, { ref: "sys_b" }]);
  });

  it("fork 过的 group 不重复补，但组内缺的照补", () => {
    const items = [{ id: "p_grp001", type: "group", label: "我的风格", forkedFrom: "sys_g", children: [{ ref: "sys_a" }] }];
    const out = restoreDefaults(TPL, items);
    expect(out[0].id).toBe("p_grp001");
    expect(out[0].children).toEqual([{ ref: "sys_a" }, { ref: "sys_b" }]);
    expect(out[1]).toEqual({ ref: "sys_c" });   // 顶层缺的也补
  });

  it("自建条目原样保留，不受影响", () => {
    const mine = { id: "p_zq1f6e", type: "action", label: "写成小红书", prompt: "我的", appliesTo: ["text"] };
    const out = restoreDefaults(TPL, [mine]);
    expect(out[0]).toEqual(mine);
    expect(out.slice(1)).toEqual([
      { ref: "sys_g", children: [{ ref: "sys_a" }, { ref: "sys_b" }] },
      { ref: "sys_c" },
    ]);
  });

  it("★ 模板新增一条系统 prompt → 补进来（这是老用户拿到新 prompt 的唯一入口）", () => {
    const grown = JSON.parse(JSON.stringify(TPL));
    grown.items.push({ id: "sys_new", type: "action", label: "新功能", prompt: "新的", appliesTo: ["text"] });
    const items = [{ ref: "sys_g", children: [{ ref: "sys_a" }, { ref: "sys_b" }] }, { ref: "sys_c" }];
    const out = restoreDefaults(grown, items);
    expect(out[out.length - 1]).toEqual({ ref: "sys_new" });
  });

  it("什么都不缺 → 原样返回", () => {
    const items = [{ ref: "sys_g", children: [{ ref: "sys_a" }, { ref: "sys_b" }] }, { ref: "sys_c" }];
    expect(restoreDefaults(TPL, items)).toEqual(items);
  });

  it("不修改传入的 items 参数（含嵌套 children 数组）", () => {
    const items = [{ ref: "sys_g", children: [{ ref: "sys_b" }] }, { ref: "sys_c" }];
    const snapshot = JSON.parse(JSON.stringify(items));
    restoreDefaults(TPL, items);
    expect(items).toEqual(snapshot);
  });

  it("不修改传入的 template 参数（模块级字面量，活过整个 Worker isolate）", () => {
    const snapshot = JSON.parse(JSON.stringify(TPL));
    restoreDefaults(TPL, []);
    restoreDefaults(TPL, [{ ref: "sys_g", children: [{ ref: "sys_a" }] }]);
    expect(TPL).toEqual(snapshot);
  });

  it("★ 输出必须通过 validateList（结果会被直接持久化）", () => {
    const cases = [
      [],
      [{ ref: "sys_g", children: [{ ref: "sys_b" }] }],
      [{ id: "p_grp001", type: "group", label: "我的风格", forkedFrom: "sys_g", children: [{ ref: "sys_a" }] }],
      [{ id: "p_zq1f6e", type: "action", label: "写成小红书", prompt: "我的", appliesTo: ["text"] }],
    ];
    for (const items of cases) {
      const out = restoreDefaults(TPL, items);
      expect(validateList(TPL, out)).toBeNull();
    }
  });

  it("★ 幂等：连续调用两次，第二次不再新增任何东西", () => {
    const seeds = [
      [],
      [{ ref: "sys_g", children: [{ ref: "sys_b" }] }, { ref: "sys_c" }],
      [{ id: "p_grp001", type: "group", label: "我的风格", forkedFrom: "sys_g", children: [{ ref: "sys_a" }] }],
    ];
    for (const items of seeds) {
      const once = restoreDefaults(TPL, items);
      const twice = restoreDefaults(TPL, once);
      expect(twice).toEqual(once);
    }
  });
});

/// 递归 Object.freeze：items/template 若被 restoreDefaults 手滑写了一下，
/// 模块是 ES module（天然 strict mode），对冻结对象赋值会直接 throw TypeError——
/// 比"跑完后 diff 快照"更硬的保证：写的那一刻就炸，不给"侥幸没被测到"的空间。
function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.values(obj).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

describe("restoreDefaults — 深冻结 items 与 template，确认真的一个字节都不写", () => {
  const frozenTpl = deepFreeze(JSON.parse(JSON.stringify(TPL)));

  const cases = {
    "空列表": [],
    "已 fork 的 action": [{ ref: "sys_g", children: [
      { id: "p_abc123", type: "action", label: "卡通风", prompt: "我的", appliesTo: ["image"], forkedFrom: "sys_a" },
    ] }, { ref: "sys_c" }],
    "已 fork 的 group": [{ id: "p_grp001", type: "group", label: "我的风格", forkedFrom: "sys_g", children: [{ ref: "sys_a" }] }],
    "纯用户自建": [{ id: "p_zq1f6e", type: "action", label: "写成小红书", prompt: "我的", appliesTo: ["text"] }],
    "部分清空的组": [{ ref: "sys_g", children: [{ ref: "sys_b" }] }, { ref: "sys_c" }],
  };

  for (const [label, items] of Object.entries(cases)) {
    it(`${label}：items 与 template 都深冻结后调用不 throw，且不修改任何一方`, () => {
      const frozenItems = deepFreeze(JSON.parse(JSON.stringify(items)));
      expect(() => restoreDefaults(frozenTpl, frozenItems)).not.toThrow();
    });
  }
});

describe("restoreDefaults — CRITICAL① 输出不能超过 MAX_ITEMS，否则自己的 validateList 都会拒绝自己", () => {
  it("195 条自建 + 整套模板（3 组 12 条）会超 200 → restoreDefaults 必须封顶，输出仍必须通过 validateList", () => {
    const items = Array.from({ length: 195 }, (_, i) => ({
      id: `p_cap${String(i).padStart(3, "0")}`, type: "action", label: `自建${i}`, prompt: "x", appliesTo: ["text"],
    }));
    const out = restoreDefaults(DEFAULT_PROMPT_TEMPLATE, items);
    expect(validateList(DEFAULT_PROMPT_TEMPLATE, out)).toBeNull();
  });

  it("封顶后的输出节点数（顶层+子项，按 validateList 的计数方式）不超过 MAX_ITEMS", () => {
    const items = Array.from({ length: 195 }, (_, i) => ({
      id: `p_cap${String(i).padStart(3, "0")}`, type: "action", label: `自建${i}`, prompt: "x", appliesTo: ["text"],
    }));
    const out = restoreDefaults(DEFAULT_PROMPT_TEMPLATE, items);
    const countNodes = (nodes) => (nodes || []).reduce((n, node) => n + 1 + countNodes(node.children), 0);
    expect(countNodes(out)).toBeLessThanOrEqual(MAX_ITEMS);
  });

  it("封顶场景下仍然幂等：再跑一次不再新增（不会试图硬塞超过上限的条目）", () => {
    const items = Array.from({ length: 195 }, (_, i) => ({
      id: `p_cap${String(i).padStart(3, "0")}`, type: "action", label: `自建${i}`, prompt: "x", appliesTo: ["text"],
    }));
    const once = restoreDefaults(DEFAULT_PROMPT_TEMPLATE, items);
    const twice = restoreDefaults(DEFAULT_PROMPT_TEMPLATE, once);
    expect(twice).toEqual(once);
  });
});

describe("restoreDefaults — IMPORTANT② 拖出组外的 fork 必须在整棵树范围内被认作「已覆盖」，不能被判定为缺失后重复补", () => {
  it("卡通被 fork 出来拖到组外 → sys_style 判定为「缺」时，只补真正缺的子项，不把 sys_cartoon 也塞回来（否则 resolveList 后卡通出现两次）", () => {
    const items = [{
      id: "p_dragged1", type: "action", label: "我的卡通(拖出)", prompt: "自定义",
      appliesTo: ["image"], forkedFrom: "sys_cartoon",
    }];
    const out = restoreDefaults(DEFAULT_PROMPT_TEMPLATE, items);

    // sys_cartoon 一定不能作为 {ref:"sys_cartoon"} 在任何层级再次出现
    const flatRefs = out.flatMap((n) => [n.ref, ...(n.children || []).map((c) => c.ref)]);
    expect(flatRefs).not.toContain("sys_cartoon");

    // resolveList 之后，"卡通" 只应该出现一次（来自用户拖出的 fork）
    const resolved = resolveList(DEFAULT_PROMPT_TEMPLATE, { schema: 1, items: out });
    const flatten = (nodes) => nodes.flatMap((n) => [n, ...(n.children || [])]);
    const cartoonLike = flatten(resolved).filter((n) => n.forkedFrom === "sys_cartoon" || n.id === "sys_cartoon");
    expect(cartoonLike).toHaveLength(1);
    expect(cartoonLike[0].id).toBe("p_dragged1");
  });

  it("输出必须通过 validateList（拖出场景，结果会被持久化）", () => {
    const items = [{
      id: "p_dragged1", type: "action", label: "我的卡通(拖出)", prompt: "自定义",
      appliesTo: ["image"], forkedFrom: "sys_cartoon",
    }];
    const out = restoreDefaults(DEFAULT_PROMPT_TEMPLATE, items);
    expect(validateList(DEFAULT_PROMPT_TEMPLATE, out)).toBeNull();
  });

  it("拖出场景下幂等：再跑一次不再新增", () => {
    const items = [{
      id: "p_dragged1", type: "action", label: "我的卡通(拖出)", prompt: "自定义",
      appliesTo: ["image"], forkedFrom: "sys_cartoon",
    }];
    const once = restoreDefaults(DEFAULT_PROMPT_TEMPLATE, items);
    const twice = restoreDefaults(DEFAULT_PROMPT_TEMPLATE, once);
    expect(twice).toEqual(once);
  });
});
