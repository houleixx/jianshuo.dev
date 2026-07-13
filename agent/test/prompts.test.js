import { describe, it, expect, vi } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import worker from "../src/index.js";
import { fakeEnv } from "./fakes.js";
import { resolveList, validateList, restoreDefaults, sanitizeStoredItems, MAX_ITEMS } from "../src/prompts.js";
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

describe("validateList — kind/imageParams 值域校验（不止白名单，值也要有界；活的滥用面：一条 PUT 能在 200 个 item 上各挂一份巨 blob，GET 全量 structuredClone）", () => {
  const entity = (over = {}) => ({ id: "p_abc123", type: "action", label: "我的", prompt: "内容", appliesTo: ["text"], ...over });

  it("kind 是短 weird 字符串仍必须通过（spec：只落盘透传，不能枚举限制，未来新 kind 不能 400）", () => {
    expect(validateList(TPL, [entity({ kind: "weird" })])).toBeNull();
  });

  it("kind 是 5MB 字符串 → 拒绝", () => {
    const out = validateList(TPL, [entity({ kind: "K".repeat(5_000_000) })]);
    expect(out).not.toBeNull();
    expect(typeof out).toBe("string");
  });

  it("kind 不是字符串 → 拒绝", () => {
    expect(validateList(TPL, [entity({ kind: 12345 })])).not.toBeNull();
    expect(validateList(TPL, [entity({ kind: { nested: true } })])).not.toBeNull();
  });

  it("imageParams 带嵌套对象 → 拒绝", () => {
    const out = validateList(TPL, [entity({ imageParams: { size: "1024x1024", nested: { seed: 1 } } })]);
    expect(out).not.toBeNull();
    expect(typeof out).toBe("string");
  });

  it("imageParams 带嵌套数组 → 拒绝", () => {
    const out = validateList(TPL, [entity({ imageParams: { tags: ["a", "b"] } })]);
    expect(out).not.toBeNull();
  });

  it("imageParams 本身是数组/null → 拒绝", () => {
    expect(validateList(TPL, [entity({ imageParams: [] })])).not.toBeNull();
    expect(validateList(TPL, [entity({ imageParams: null })])).not.toBeNull();
  });

  it("imageParams 超过 8 个自有键 → 拒绝", () => {
    const wide = {};
    for (let i = 0; i < 9; i++) wide[`k${i}`] = "v";
    expect(validateList(TPL, [entity({ imageParams: wide })])).not.toBeNull();
  });

  it("imageParams 某个字符串值超过 40 字 → 拒绝", () => {
    const out = validateList(TPL, [entity({ imageParams: { prompt: "长".repeat(41) } })]);
    expect(out).not.toBeNull();
  });

  it("imageParams 值是非有限数字（Infinity/NaN）→ 拒绝", () => {
    expect(validateList(TPL, [entity({ imageParams: { count: Infinity } })])).not.toBeNull();
    expect(validateList(TPL, [entity({ imageParams: { count: NaN } })])).not.toBeNull();
  });

  it("imageParams: {aspect:\"16:9\", count: 4} → 通过（字符串/有限数字/布尔都合法）", () => {
    expect(validateList(TPL, [entity({ imageParams: { aspect: "16:9", count: 4, hd: true } })])).toBeNull();
  });

  it("存量文档 kind/imageParams 都不带 → 照常通过（不因为新校验波及老数据）", () => {
    expect(validateList(TPL, [entity()])).toBeNull();
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

// ── CRITICAL③ 对抗性 review 命中的缺陷：存储层的垃圾节点必须被跳过，绝不能 throw ──
// 语境：users/<sub>/prompts.json 语法合法（JSON.parse 成功），但 items 数组里混进了
// null / 数字 / 字符串 / 布尔 / 数组 这类"节点"（历史 bug 写坏 / 手改 / 存储层损坏）。
// 降级路径是【跳过垃圾节点】，不是拿 validateList 校验整份文档再整体回退模板——
// 那样会把在【旧模板】下产生的合法悬空 ref 一并当垃圾判死刑，抹掉用户整份自定义列表
// （见文件头 spec 设计约束：悬空 ref 本来就该被静默跳过，垃圾节点要吃同一条待遇）。
describe("resolveList/restoreDefaults — CRITICAL③ 存储层垃圾节点必须被跳过，不能 throw", () => {
  it("resolveList：顶层 null 节点 → 跳过，不 throw（原 repro：TypeError reading 'ref' @ resolveNode）", () => {
    expect(() => resolveList(TPL, { schema: 1, items: [null] })).not.toThrow();
    expect(resolveList(TPL, { schema: 1, items: [null] })).toEqual([]);
  });

  it("restoreDefaults：顶层 null 节点 → 当作缺失处理，正常补回模板全量，不 throw（原 repro：TypeError reading 'children' @ cloneTop）", () => {
    expect(() => restoreDefaults(TPL, [null])).not.toThrow();
    expect(restoreDefaults(TPL, [null])).toEqual(restoreDefaults(TPL, []));
  });

  it("resolveList：ref-group 的 children 里混进 null（嵌套垃圾）→ 组还在，垃圾 child 被跳过，不 throw", () => {
    expect(() => resolveList(TPL, { schema: 1, items: [{ ref: "sys_g", children: [null] }] })).not.toThrow();
    const out = resolveList(TPL, { schema: 1, items: [{ ref: "sys_g", children: [null] }] });
    expect(out).toEqual([{ id: "sys_g", type: "group", label: "图片风格", origin: "system", children: [] }]);
  });

  it("restoreDefaults：ref-group 的 children 里混进 null（嵌套垃圾）→ 不 throw，垃圾被丢弃，缺的子项照补", () => {
    expect(() => restoreDefaults(TPL, [{ ref: "sys_g", children: [null] }])).not.toThrow();
    const out = restoreDefaults(TPL, [{ ref: "sys_g", children: [null] }]);
    expect(out[0].children).toEqual([{ ref: "sys_a" }, { ref: "sys_b" }]);
  });

  it.each([
    ["数字", 5],
    ["字符串", "x"],
    ["布尔", true],
    ["数组", [1, 2]],
  ])("resolveList：顶层节点是原始类型/数组（%s）→ 跳过，不产出幽灵节点，不 throw", (_label, junk) => {
    expect(() => resolveList(TPL, { schema: 1, items: [junk] })).not.toThrow();
    expect(resolveList(TPL, { schema: 1, items: [junk] })).toEqual([]);
  });

  it.each([
    ["数字", 5],
    ["字符串", "x"],
    ["布尔", true],
    ["数组", [1, 2]],
  ])("restoreDefaults：顶层节点是原始类型/数组（%s）→ 当作缺失，不 throw，不产出垃圾节点", (_label, junk) => {
    expect(() => restoreDefaults(TPL, [junk])).not.toThrow();
    expect(restoreDefaults(TPL, [junk])).toEqual(restoreDefaults(TPL, []));
  });

  it("★ 好节点和垃圾节点混在一起 → 好节点原样保留，垃圾静默跳过（不能因为一个 null 就丢了整份自定义）", () => {
    const out = resolveList(DEFAULT_PROMPT_TEMPLATE, { schema: 1, items: [null, { ref: "sys_cartoon" }, 5] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("sys_cartoon");
    expect(out[0].origin).toBe("system");
  });

  it.each([
    ["空对象", {}],
    ["数字", 5],
    ["字符串", "str"],
    ["布尔", true],
  ])("resolveList：ref-group 的 children 不是数组（%s）→ 当作没有 children（空组），不 throw", (_label, badChildren) => {
    expect(() => resolveList(TPL, { schema: 1, items: [{ ref: "sys_g", children: badChildren }] })).not.toThrow();
    const out = resolveList(TPL, { schema: 1, items: [{ ref: "sys_g", children: badChildren }] });
    expect(out[0].children).toEqual([]);
  });

  it.each([
    ["空对象", {}],
    ["数字", 5],
    ["布尔", true],
  ])("restoreDefaults：ref-group 的 children 不是数组（%s）→ 当作没有 children，正常补回缺的子项，不 throw", (_label, badChildren) => {
    expect(() => restoreDefaults(TPL, [{ ref: "sys_g", children: badChildren }])).not.toThrow();
    const out = restoreDefaults(TPL, [{ ref: "sys_g", children: badChildren }]);
    expect(out[0].children).toEqual([{ ref: "sys_a" }, { ref: "sys_b" }]);
  });
});

// ── sanitizeStoredItems — IMPORTANT① 悬空 ref 必须与 resolveList 待遇一致（静默丢弃）──
// 之前的实现只清垃圾节点，不认模板，导致模板热更删掉一个 sys_* 之后，任何还持有
// 那个 ref 的用户文档，在写路径（import / restore-defaults）上永远 400/500——
// 而 resolveList（读路径）早就把同一个悬空 ref 静默丢了。这里补齐写路径的清洗。
describe("sanitizeStoredItems — 悬空 ref 与垃圾节点同等对待，均静默丢弃", () => {
  it("顶层悬空 ref（模板已删）→ 丢弃", () => {
    expect(sanitizeStoredItems([{ ref: "sys_removed" }], TPL)).toEqual([]);
  });

  it("顶层悬空 ref 与合法节点混在一起 → 合法节点原样保留，顺序不变", () => {
    const out = sanitizeStoredItems([{ ref: "sys_removed" }, { ref: "sys_c" }], TPL);
    expect(out).toEqual([{ ref: "sys_c" }]);
  });

  it("group 的 children 里混进悬空 ref → 组保留，悬空 child 被丢弃，其余 children 不受影响", () => {
    const out = sanitizeStoredItems([{ ref: "sys_g", children: [{ ref: "sys_a" }, { ref: "sys_removed_child" }] }], TPL);
    expect(out).toEqual([{ ref: "sys_g", children: [{ ref: "sys_a" }] }]);
  });

  it("悬空 ref 本身就是 group → 整条（含 children）一起丢弃，与 resolveNode 对悬空 group ref 的处理一致", () => {
    const out = sanitizeStoredItems([{ ref: "sys_removed_group", children: [{ ref: "sys_a" }] }], TPL);
    expect(out).toEqual([]);
  });

  it("有效 ref + 实体节点均原样通过（非 ref 节点不受模板存在性影响）", () => {
    const entity = { id: "p_abc123", type: "action", label: "我的", prompt: "内容", appliesTo: ["text"] };
    const out = sanitizeStoredItems([{ ref: "sys_c" }, entity], TPL);
    expect(out).toEqual([{ ref: "sys_c" }, entity]);
  });

  it("垃圾节点（顶层 + 嵌套 children）依旧被丢弃（不因为加了模板参数就弱化原有清洗）", () => {
    const out = sanitizeStoredItems([null, { ref: "sys_g", children: [null, { ref: "sys_a" }, 5] }, 5, "junk"], TPL);
    expect(out).toEqual([{ ref: "sys_g", children: [{ ref: "sys_a" }] }]);
  });

  it("不修改传入的 items（含嵌套 children 数组）——纯函数", () => {
    const items = [{ ref: "sys_g", children: [{ ref: "sys_a" }] }];
    const snapshot = JSON.parse(JSON.stringify(items));
    sanitizeStoredItems(items, TPL);
    expect(items).toEqual(snapshot);
  });
});

// ── 路由层：GET/PUT /agent/prompts + POST /agent/prompts/restore-defaults ──────
// spec: voicedrop repo docs/superpowers/specs/2026-07-13-prompt-manager-redesign.md
// 纯逻辑（resolveList/validateList/restoreDefaults）已经在上面测过；这里测 HTTP 外壳：
// 鉴权、方法路由、body 解析、以及【GET 绝不落盘】这条最重要的不变式。
const TOKEN = "Bearer anon_testtoken1234567890";
const SCOPE_KEY = (env) => [...env.FILES._store.keys()].find((k) => k.endsWith("prompts.json"));
const GET = (env) => worker.fetch(new Request("https://jianshuo.dev/agent/prompts", { headers: { Authorization: TOKEN } }), env);
const PUT = (env, items) => worker.fetch(new Request("https://jianshuo.dev/agent/prompts", {
  method: "PUT", headers: { Authorization: TOKEN, "content-type": "application/json" },
  body: JSON.stringify({ items }),
}), env);
const PUT_RAW = (env, rawBody) => worker.fetch(new Request("https://jianshuo.dev/agent/prompts", {
  method: "PUT", headers: { Authorization: TOKEN, "content-type": "application/json" },
  body: rawBody,
}), env);

describe("GET /agent/prompts", () => {
  it("无 token → 401", async () => {
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompts"), fakeEnv());
    expect(res.status).toBe(401);
  });

  it("新用户（无 prompts.json）→ 模板全量，全部 origin=system", async () => {
    const res = await GET(fakeEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema).toBe(1);
    expect(body.items.length).toBe(DEFAULT_PROMPT_TEMPLATE.items.length);
    expect(body.items.every((i) => i.origin === "system")).toBe(true);
  });

  it("★ 读盘不落盘：GET 不该给新用户创建 prompts.json", async () => {
    const env = fakeEnv();
    await GET(env);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });

  it("坏 prompts.json → 当没有，回退模板（不 500）", async () => {
    const env = fakeEnv();
    const res0 = await PUT(env, []);          // 先建出 key，拿到真实 scope 路径
    expect(res0.status).toBe(200);
    env.FILES._store.set(SCOPE_KEY(env), "{oops");
    const res = await GET(env);
    expect(res.status).toBe(200);
    expect((await res.json()).items.length).toBe(DEFAULT_PROMPT_TEMPLATE.items.length);
  });

  it("★ CRITICAL③ prompts.json 语法合法但 items 混进 null/原始类型垃圾节点 → 200（不是 500），垃圾跳过，好节点保留", async () => {
    const env = fakeEnv();
    await PUT(env, []);          // 先建出 key，拿到真实 scope 路径
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({ schema: 1, items: [null, { ref: "sys_cartoon" }, 5] }));
    const res = await GET(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("sys_cartoon");
    expect(body.items[0].origin).toBe("system");
  });

  it("★ CRITICAL③ group 的 children 里混进 null（嵌套垃圾）→ 200，组还在，垃圾 child 被跳过", async () => {
    const env = fakeEnv();
    await PUT(env, []);
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({ schema: 1, items: [{ ref: "sys_style", children: [null] }] }));
    const res = await GET(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("sys_style");
    expect(body.items[0].children).toEqual([]);
  });
});

describe("PUT /agent/prompts", () => {
  it("整树写入 → 200 + 返回解析结果；GET 读回一致", async () => {
    const env = fakeEnv();
    const items = [{ id: "p_zq1f6e", type: "action", label: "写成小红书", prompt: "我的", appliesTo: ["text"] }];
    const put = await PUT(env, items);
    expect(put.status).toBe(200);
    const putBody = await put.json();
    expect(putBody.items).toHaveLength(1);
    expect(putBody.items[0].origin).toBe("user");

    const got = await (await GET(env)).json();
    expect(got.items).toEqual(putBody.items);
  });

  it("校验失败 → 400 且不落盘", async () => {
    const env = fakeEnv();
    const res = await PUT(env, [{ ref: "sys_nope" }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/unknown ref/);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });

  it("body 不是 {items:[...]} → 400", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompts", {
      method: "PUT", headers: { Authorization: TOKEN, "content-type": "application/json" }, body: "{oops",
    }), env);
    expect(res.status).toBe(400);
  });

  it("空列表可写（用户删光）", async () => {
    const env = fakeEnv();
    expect((await PUT(env, [])).status).toBe(200);
    expect((await (await GET(env)).json()).items).toEqual([]);
  });

  it("DELETE → 405", async () => {
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompts", {
      method: "DELETE", headers: { Authorization: TOKEN },
    }), fakeEnv());
    expect(res.status).toBe(405);
  });

  // ── 对抗性探测：不信任 body 的任何形状 ──────────────────────────────────
  it("body 缺失（无 body）→ 400 且不落盘", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompts", {
      method: "PUT", headers: { Authorization: TOKEN },
    }), env);
    expect(res.status).toBe(400);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });

  it("body 是裸数组（没有 items 包一层）→ 400 且不落盘", async () => {
    const env = fakeEnv();
    const res = await PUT_RAW(env, JSON.stringify([{ ref: "sys_cartoon" }]));
    expect(res.status).toBe(400);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });

  it("items 不是数组（{items:'notanarray'}）→ 400 且不落盘", async () => {
    const env = fakeEnv();
    const res = await PUT_RAW(env, JSON.stringify({ items: "notanarray" }));
    expect(res.status).toBe(400);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });

  it("body 是 JSON null → 400 且不落盘", async () => {
    const env = fakeEnv();
    const res = await PUT_RAW(env, "null");
    expect(res.status).toBe(400);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });

  it("超过 MAX_ITEMS 的树 → 400 且不落盘", async () => {
    const env = fakeEnv();
    const items = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({
      id: `p_over${String(i).padStart(4, "0")}`, type: "action", label: `条目${i}`, prompt: "内容", appliesTo: ["text"],
    }));
    const res = await PUT(env, items);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too many items/);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });
});

// ── PUT /agent/prompts 保存后同步分享副本（write-through on save，Piece B）──────
// 老模型（ui-config-custom.js，已退役）每次 PUT 都调 refreshPromptShare；新模型的
// 整树 PUT 起初没接这条线——作者编辑一条正在分享的提示词后，分享副本（shares/<码>）
// 停在旧版本，直到这里补上 syncActiveShares。
describe("PUT /agent/prompts — 保存时刷新正在分享的条目", () => {
  const MINT = (env, id) => worker.fetch(new Request("https://jianshuo.dev/agent/prompt-share", {
    method: "POST", headers: { Authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }), env);
  const UNSHARE = (env, id) => worker.fetch(new Request(`https://jianshuo.dev/agent/prompt-share/${id}`, {
    method: "DELETE", headers: { Authorization: TOKEN },
  }), env);
  const shareDocOf = (env) => {
    const k = [...env.FILES._store.keys()].find((x) => x.startsWith("shares/"));
    return k ? JSON.parse(env.FILES._store.get(k)) : null;
  };

  it("作者编辑正在分享的条目 → 分享副本随 PUT 同步更新（label/instruction/appliesTo），createdAt/importCount 保留", async () => {
    const env = fakeEnv();
    await PUT(env, [{ id: "p_share01", type: "action", label: "标题", prompt: "初版", appliesTo: ["text"] }]);
    const { code } = await (await MINT(env, "p_share01")).json();
    const before = shareDocOf(env);
    // 模拟这条分享已经被别人导入过几次——改词不能把导入计数清零。
    env.FILES._store.set(`shares/${code}`, JSON.stringify({ ...before, importCount: 5 }));

    const res = await PUT(env, [{ id: "p_share01", type: "action", label: "新标题", prompt: "改过的内容", appliesTo: ["text", "image"] }]);
    expect(res.status).toBe(200);

    const after = shareDocOf(env);
    expect(after.instruction).toBe("改过的内容");
    expect(after.label).toBe("新标题");
    expect(after.appliesTo).toEqual(["text", "image"]);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.importCount).toBe(5);
  });

  it("作者没有任何分享 → PUT 正常保存，不产生任何 shares/* 写入", async () => {
    const env = fakeEnv();
    const res = await PUT(env, [{ id: "p_noshare1", type: "action", label: "标题", prompt: "内容", appliesTo: ["text"] }]);
    expect(res.status).toBe(200);
    expect([...env.FILES._store.keys()].some((k) => k.startsWith("shares/"))).toBe(false);
    const got = await (await GET(env)).json();
    expect(got.items.find((i) => i.id === "p_noshare1").prompt).toBe("内容");
  });

  it("分享已关闭的条目被编辑 → 不复活分享（PUT 仍 200，shares/<码> 依旧不存在）", async () => {
    const env = fakeEnv();
    await PUT(env, [{ id: "p_share02", type: "action", label: "标题", prompt: "初版", appliesTo: ["text"] }]);
    const { code } = await (await MINT(env, "p_share02")).json();
    await UNSHARE(env, "p_share02");
    expect(env.FILES._store.has(`shares/${code}`)).toBe(false);

    const res = await PUT(env, [{ id: "p_share02", type: "action", label: "标题", prompt: "又改了一版", appliesTo: ["text"] }]);
    expect(res.status).toBe(200);
    expect(env.FILES._store.has(`shares/${code}`)).toBe(false);
  });

  it("刷新分享副本本身失败不影响 PUT（best-effort）：R2 写 shares/<码> 抛错，PUT 仍 200 且用户列表已保存", async () => {
    const env = fakeEnv();
    await PUT(env, [{ id: "p_share03", type: "action", label: "标题", prompt: "初版", appliesTo: ["text"] }]);
    await MINT(env, "p_share03");
    const origPut = env.FILES.put.bind(env.FILES);
    env.FILES.put = async (key, value) => {
      if (key.startsWith("shares/")) throw new Error("boom");
      return origPut(key, value);
    };
    const res = await PUT(env, [{ id: "p_share03", type: "action", label: "标题", prompt: "又改了一版", appliesTo: ["text"] }]);
    expect(res.status).toBe(200);
    env.FILES.put = origPut;
    const got = await (await GET(env)).json();
    expect(got.items.find((i) => i.id === "p_share03").prompt).toBe("又改了一版");
  });
});

describe("POST /agent/prompts/restore-defaults", () => {
  const RESTORE = (env) => worker.fetch(new Request("https://jianshuo.dev/agent/prompts/restore-defaults", {
    method: "POST", headers: { Authorization: TOKEN },
  }), env);

  it("删光后恢复 → 模板全量回来", async () => {
    const env = fakeEnv();
    await PUT(env, []);
    const res = await RESTORE(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(DEFAULT_PROMPT_TEMPLATE.items.length);
    expect(body.items.every((i) => i.origin === "system")).toBe(true);
    // 落盘了，GET 读回一致
    expect((await (await GET(env)).json()).items).toEqual(body.items);
  });

  it("自建条目保留在前，补回来的排后面", async () => {
    const env = fakeEnv();
    await PUT(env, [{ id: "p_zq1f6e", type: "action", label: "写成小红书", prompt: "我的", appliesTo: ["text"] }]);
    const body = await (await RESTORE(env)).json();
    expect(body.items[0].origin).toBe("user");
    expect(body.items.length).toBe(1 + DEFAULT_PROMPT_TEMPLATE.items.length);
  });

  it("无 token → 401", async () => {
    expect((await worker.fetch(new Request("https://jianshuo.dev/agent/prompts/restore-defaults", { method: "POST" }), fakeEnv())).status).toBe(401);
  });

  it("新用户（无 prompts.json）→ no-op，不落盘", async () => {
    const env = fakeEnv();
    const res = await RESTORE(env);
    expect(res.status).toBe(200);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });

  it("GET 方法 → 405", async () => {
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/prompts/restore-defaults", {
      method: "GET", headers: { Authorization: TOKEN },
    }), fakeEnv());
    expect(res.status).toBe(405);
  });

  it("★ CRITICAL③ prompts.json 语法合法但 items 混进 null/原始类型垃圾节点 → 200（不是 500），垃圾跳过，好节点（sys_cartoon）保留且只出现一次", async () => {
    const env = fakeEnv();
    await PUT(env, []);
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({ schema: 1, items: [null, { ref: "sys_cartoon" }, 5] }));
    const res = await RESTORE(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    const flatten = (nodes) => nodes.flatMap((n) => [n, ...(n.children || [])]);
    const cartoonNodes = flatten(body.items).filter((n) => n.id === "sys_cartoon");
    expect(cartoonNodes).toHaveLength(1);
    // 落盘的内容也是干净的：GET 读回和 restore 的响应一致
    const got = await (await GET(env)).json();
    expect(got.items).toEqual(body.items);
  });

  it("★ CRITICAL③ group 的 children 里混进 null（嵌套垃圾）→ 200，垃圾丢弃，组里缺的子项照补", async () => {
    const env = fakeEnv();
    await PUT(env, []);
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({ schema: 1, items: [{ ref: "sys_style", children: [null] }] }));
    const res = await RESTORE(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    const styleGroup = body.items.find((n) => n.id === "sys_style");
    expect(styleGroup).toBeDefined();
    expect(styleGroup.children.some((c) => c.id === "sys_cartoon")).toBe(true);
  });

  it("IMPORTANT① 存量文档带悬空 ref（模板已删的 sys_*）→ 200（不是 400/500），悬空 ref 被丢弃，模板项正常补回", async () => {
    const env = fakeEnv();
    await PUT(env, []);          // 先建出 key，拿到真实 scope 路径
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({ schema: 1, items: [{ ref: "sys_removed" }] }));
    const res = await RESTORE(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.some((n) => n.id === "sys_removed")).toBe(false);
    // 落盘的内容也是干净的：GET 读回和 restore 的响应一致
    const got = await (await GET(env)).json();
    expect(got.items).toEqual(body.items);
    expect(got.items.length).toBe(DEFAULT_PROMPT_TEMPLATE.items.length);
  });

  it("IMPORTANT① 悬空 ref 藏在 group 的 children 里 → 也被丢弃，组和其余内容不受影响", async () => {
    const env = fakeEnv();
    await PUT(env, []);
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({
      schema: 1,
      items: [{ ref: "sys_style", children: [{ ref: "sys_cartoon" }, { ref: "sys_removed_child" }] }],
    }));
    const res = await RESTORE(env);
    expect(res.status).toBe(200);
    const body = await res.json();
    const style = body.items.find((n) => n.id === "sys_style");
    expect(style).toBeDefined();
    expect(style.children.some((c) => c.id === "sys_removed_child")).toBe(false);
    expect(style.children.some((c) => c.id === "sys_cartoon")).toBe(true);
  });
});

// ── POST /agent/prompts/import — 魔法数字导入成自建副本 ────────────────────────
// spec §8：导入 = 独立实体副本（origin:user，无 forkedFrom）——原作者之后的编辑不影响你。
describe("POST /agent/prompts/import — 魔法数字导入（4b）", () => {
  const IMPORT = (env, code) => worker.fetch(new Request("https://jianshuo.dev/agent/prompts/import", {
    method: "POST", headers: { Authorization: TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  }), env);
  const seedShare = (over = {}) => ({
    "shares/4820135": JSON.stringify({
      type: "prompt", sub: "anon-other", itemId: "p_orig01",
      label: "改写成播客口播稿", instruction: "把文章改写成口播稿…",
      appliesTo: ["text"], importCount: 128, ...over,
    }),
  });

  it("★ 导入 → 追加一条实体副本（origin=user，无 forkedFrom）", async () => {
    const env = fakeEnv(seedShare());
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.label).toBe("改写成播客口播稿");
    expect(item.prompt).toContain("口播稿");
    expect(item.appliesTo).toEqual(["text"]);
    expect(item.origin).toBe("user");
    expect(item.forkedFrom).toBeUndefined();
    expect(item.id).toMatch(/^p_[a-z0-9]{6,}$/);
  });

  it("★ 首次导入（用户还没 prompts.json）→ 模板项被物化成 ref，一条都不丢", async () => {
    const env = fakeEnv(seedShare());
    await IMPORT(env, "4820135");
    const got = await (await GET(env)).json();
    expect(got.items.length).toBe(DEFAULT_PROMPT_TEMPLATE.items.length + 1);
    // 模板项仍是 system（= 仍是 ref、仍跟随最新），没被冻结
    expect(got.items.filter((i) => i.origin === "system").length).toBe(DEFAULT_PROMPT_TEMPLATE.items.length);
    expect(got.items[got.items.length - 1].origin).toBe("user");
  });

  it("已有列表 → 追加到末尾", async () => {
    const env = fakeEnv(seedShare());
    await PUT(env, []);
    await IMPORT(env, "4820135");
    const got = await (await GET(env)).json();
    expect(got.items).toHaveLength(1);
    expect(got.items[0].origin).toBe("user");
  });

  it("importCount +1 写回 shares/<码>", async () => {
    const env = fakeEnv(seedShare());
    await IMPORT(env, "4820135");
    const doc = JSON.parse(env.FILES._store.get("shares/4820135"));
    expect(doc.importCount).toBe(129);
  });

  it("老副本无 appliesTo → 导入成「都行」", async () => {
    const env = fakeEnv(seedShare({ appliesTo: undefined }));
    const { item } = await (await IMPORT(env, "4820135")).json();
    expect(new Set(item.appliesTo)).toEqual(new Set(["text", "image"]));
  });

  it("分享文档 appliesTo 被手改成非法值 [\"banana\"] → 兜底都行，导入仍成功（不因 validateList 拒收而 400）", async () => {
    const env = fakeEnv(seedShare({ appliesTo: ["banana"] }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(new Set(item.appliesTo)).toEqual(new Set(["text", "image"]));
  });

  it("分享文档 appliesTo 部分合法 [\"text\",\"banana\"] → 只保留 [\"text\"]，导入成功", async () => {
    const env = fakeEnv(seedShare({ appliesTo: ["text", "banana"] }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.appliesTo).toEqual(["text"]);
  });

  it("无效码 → 404，不落盘", async () => {
    const env = fakeEnv();
    expect((await IMPORT(env, "9999999")).status).toBe(404);
    expect(SCOPE_KEY(env)).toBeUndefined();
  });

  it("缺 code → 400；无 token → 401；GET → 405", async () => {
    const env = fakeEnv(seedShare());
    expect((await worker.fetch(new Request("https://jianshuo.dev/agent/prompts/import", {
      method: "POST", headers: { Authorization: TOKEN, "content-type": "application/json" }, body: "{}",
    }), env)).status).toBe(400);
    expect((await worker.fetch(new Request("https://jianshuo.dev/agent/prompts/import", { method: "POST" }), env)).status).toBe(401);
    expect((await worker.fetch(new Request("https://jianshuo.dev/agent/prompts/import", { headers: { Authorization: TOKEN } }), env)).status).toBe(405);
  });

  it("导入两次 → 两条独立副本（各自 id 不同）", async () => {
    const env = fakeEnv(seedShare());
    const a = (await (await IMPORT(env, "4820135")).json()).item;
    const b = (await (await IMPORT(env, "4820135")).json()).item;
    expect(a.id).not.toBe(b.id);
    expect((await (await GET(env)).json()).items.filter((i) => i.origin === "user")).toHaveLength(2);
  });

  // ── 对抗性探测 ───────────────────────────────────────────────────────────
  it("★ 存量 prompts.json 混进垃圾节点（顶层 + 嵌套 children）→ 导入不 500、不 400，垃圾被清掉，好节点原样保留", async () => {
    const env = fakeEnv(seedShare());
    await PUT(env, []);          // 先建出 key，拿到真实 scope 路径
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({
      schema: 1,
      items: [null, { ref: "sys_style", children: [null, { ref: "sys_cartoon" }, 5] }, 5, "junk"],
    }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const got = await (await GET(env)).json();
    // 垃圾没有复活成幽灵节点
    expect(got.items.every((n) => n && typeof n === "object")).toBe(true);
    const style = got.items.find((n) => n.id === "sys_style");
    expect(style).toBeDefined();
    expect(style.children.map((c) => c.id)).toEqual(["sys_cartoon"]);
    // 新导入的那条在末尾
    expect(got.items[got.items.length - 1].origin).toBe("user");
    expect(got.items.filter((n) => n.origin === "user")).toHaveLength(1);
  });

  it("分享 label 超过 40 字 → 截断到 40，导入仍成功（不因为 validateList 拒收而 400）", async () => {
    const longLabel = "很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的标题超过四十个字啦啦啦啦啦啦啦啦啦啦";
    expect(longLabel.length).toBeGreaterThan(40);
    const env = fakeEnv(seedShare({ label: longLabel }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.label.length).toBeLessThanOrEqual(40);
    expect(longLabel.startsWith(item.label)).toBe(true);
  });

  it("分享 instruction 超过 4000 字 → 截断到 4000，导入仍成功", async () => {
    const longInstruction = "指".repeat(4100);
    const env = fakeEnv(seedShare({ instruction: longInstruction }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.prompt.length).toBeLessThanOrEqual(4000);
    expect(longInstruction.startsWith(item.prompt)).toBe(true);
  });

  it("列表已满 MAX_ITEMS → 导入 400，不落盘一条截断/损坏的列表", async () => {
    const env = fakeEnv(seedShare());
    const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({
      id: `p_full${String(i).padStart(4, "0")}`, type: "action", label: `条目${i}`, prompt: "内容", appliesTo: ["text"],
    }));
    await PUT(env, items);
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(400);
    const got = await (await GET(env)).json();
    expect(got.items).toHaveLength(MAX_ITEMS);   // 没有被半途写坏
  });

  it("未知 kind 字段透传，不影响导入", async () => {
    const env = fakeEnv(seedShare({ kind: "mystery-kind" }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.kind).toBe("mystery-kind");
  });

  it("★ newUserId 撞上列表里已有的 id → 悄悄重摇一个新 id，而不是让 validateList 判 400", async () => {
    const env = fakeEnv(seedShare());
    await PUT(env, [{ id: "p_00000000", type: "action", label: "已有的", prompt: "已有的内容", appliesTo: ["text"] }]);
    const spy = vi.spyOn(crypto, "getRandomValues").mockImplementationOnce((a) => { a[0] = 0; a[1] = 0; return a; })   // → p_00000000（撞车）
      .mockImplementationOnce((a) => { a[0] = 1; a[1] = 0; return a; });                                                // → p_10000000（重摇后）
    try {
      const res = await IMPORT(env, "4820135");
      expect(res.status).toBe(200);
      const { item } = await res.json();
      expect(item.id).not.toBe("p_00000000");
      expect(item.id).toBe("p_10000000");
    } finally { spy.mockRestore(); }
  });

  // ── Task 8 review fixes ─────────────────────────────────────────────────
  it("IMPORTANT① 存量文档带悬空 ref（模板已删的 sys_*）→ 200，悬空 ref 被丢弃，导入正常追加", async () => {
    const env = fakeEnv(seedShare());
    await PUT(env, []);          // 先建出 key，拿到真实 scope 路径
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({ schema: 1, items: [{ ref: "sys_removed" }] }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const got = await (await GET(env)).json();
    // 悬空 ref 没有以任何形式复活（既不是幽灵 system 节点，也不残留在存储里）
    expect(got.items.some((n) => n.id === "sys_removed")).toBe(false);
    expect(got.items.filter((n) => n.origin === "user")).toHaveLength(1);
  });

  it("IMPORTANT① 悬空 ref 藏在 group 的 children 里 → 也被丢弃，组和其余 children 原样保留", async () => {
    const env = fakeEnv(seedShare());
    await PUT(env, []);
    env.FILES._store.set(SCOPE_KEY(env), JSON.stringify({
      schema: 1,
      items: [{ ref: "sys_style", children: [{ ref: "sys_cartoon" }, { ref: "sys_removed_child" }] }],
    }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const got = await (await GET(env)).json();
    const style = got.items.find((n) => n.id === "sys_style");
    expect(style).toBeDefined();
    expect(style.children.map((c) => c.id)).toEqual(["sys_cartoon"]);
  });

  it("IMPORTANT② 分享 label 为纯空白 → 不 400，落回默认标签「导入的提示词」", async () => {
    const env = fakeEnv(seedShare({ label: "     " }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.label).toBe("导入的提示词");
  });

  it("MINOR③ label 截断不能切断代理对：39 个汉字 + 1 个 emoji（长度 41）→ 截到 40 后丢掉落单的高位代理，emoji 整体被丢弃", async () => {
    const label = "字".repeat(39) + "😀"; // "😀" 是代理对，label.length === 41
    expect(label.length).toBe(41);
    const env = fakeEnv(seedShare({ label }));
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.label).toBe("字".repeat(39));      // emoji（半个代理对）被整体丢弃，不留 mojibake
    expect(item.label.length).toBe(39);
    // 结果必须不含孤立代理项（不能有 codeUnit 落在 0xD800-0xDFFF 区间）
    for (let i = 0; i < item.label.length; i++) {
      const c = item.label.charCodeAt(i);
      expect(c >= 0xD800 && c <= 0xDFFF).toBe(false);
    }
  });

  it("importCount 写回失败不影响导入本身（shares/<码> 在导入过程中消失）", async () => {
    const env = fakeEnv(seedShare());
    const origGet = env.FILES.get.bind(env.FILES);
    let calls = 0;
    env.FILES.get = async (key) => {
      calls++;
      // 第一次 get 给 resolvePromptShare 用，后续（importCount 回写读取）模拟消失
      if (key === "shares/4820135" && calls > 1) return null;
      return origGet(key);
    };
    const res = await IMPORT(env, "4820135");
    expect(res.status).toBe(200);
    const { item } = await res.json();
    expect(item.origin).toBe("user");
  });
});
