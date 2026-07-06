import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { DEFAULT_UI_CONFIG, loadUserOverrides, applyUserOverrides, loadUIConfigFor } from "../src/ui-config.js";
import { handleUIConfigCustom } from "../src/ui-config-custom.js";
import { flattenPrompts } from "../src/prompt-registry.js";
import { fakeEnv } from "./fakes.js";

const SCOPE = "users/sub123/";
const KEY = SCOPE + "ui-config.json";
const COVER_ID = "voice-editor.longpress.text.insert.wechat-cover";
const OIL_ID = "voice-editor.longpress.image.style.oil";

const req = (method, body) =>
  new Request("https://jianshuo.dev/agent/ui-config/custom", {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("loadUserOverrides — 新格式 + 旧字符串兼容", () => {
  it("缺文件/坏 JSON → 空；非 users/ scope → 空", async () => {
    expect(await loadUserOverrides(fakeEnv(), SCOPE)).toEqual({ overrides: {}, hidden: [] });
    expect(await loadUserOverrides(fakeEnv({ [KEY]: "{oops" }), SCOPE)).toEqual({ overrides: {}, hidden: [] });
    expect(await loadUserOverrides(fakeEnv(), null)).toEqual({ overrides: {}, hidden: [] });
  });

  it("旧格式纯字符串 → 归一成 {instruction}；空值过滤", async () => {
    const env = fakeEnv({ [KEY]: JSON.stringify({ overrides: { [COVER_ID]: "自定义", empty: " " } }) });
    expect((await loadUserOverrides(env, SCOPE)).overrides).toEqual({ [COVER_ID]: { instruction: "自定义" } });
  });

  it("新格式 instruction+label+hidden；label 去空白", async () => {
    const env = fakeEnv({ [KEY]: JSON.stringify({
      overrides: { [COVER_ID]: { instruction: "我的指令", label: " 头图 " } },
      hidden: [OIL_ID, OIL_ID, 5],
    }) });
    const u = await loadUserOverrides(env, SCOPE);
    expect(u.overrides[COVER_ID]).toEqual({ instruction: "我的指令", label: "头图" });
    expect(u.hidden).toEqual([OIL_ID]);
  });
});

describe("applyUserOverrides — 改文本/改名/隐藏", () => {
  it("改名+改文本只动目标叶子", () => {
    const next = applyUserOverrides(DEFAULT_UI_CONFIG, {
      overrides: { [COVER_ID]: { instruction: "我的题图指令", label: "头图" } }, hidden: [],
    });
    const cover = flattenPrompts(next).find((p) => p.id === COVER_ID);
    expect(cover.instruction).toBe("我的题图指令");
    expect(cover.label).toBe("插入图片 · 头图");
    expect(flattenPrompts(DEFAULT_UI_CONFIG).find((p) => p.id === COVER_ID).label).toBe("插入图片 · 公众号题图");
  });

  it("hidden 叶子从菜单里消失，其余 11 条还在", () => {
    const next = applyUserOverrides(DEFAULT_UI_CONFIG, { overrides: {}, hidden: [OIL_ID] });
    const ids = flattenPrompts(next).map((p) => p.id);
    expect(ids).not.toContain(OIL_ID);
    expect(ids.length).toBe(11);
  });

  it("空覆盖 = 原样返回", () => {
    expect(applyUserOverrides(DEFAULT_UI_CONFIG, { overrides: {}, hidden: [] })).toBe(DEFAULT_UI_CONFIG);
  });
});

describe("loadUIConfigFor — 三层：内置 ← 全局 R2 ← 用户", () => {
  it("用户覆盖赢过全局覆盖", async () => {
    const globalCfg = applyUserOverrides(DEFAULT_UI_CONFIG, {
      overrides: { [COVER_ID]: { instruction: "全局版" } }, hidden: [],
    });
    const env = fakeEnv({
      "config/ui-config.json": JSON.stringify(globalCfg),
      [KEY]: JSON.stringify({ overrides: { [COVER_ID]: { instruction: "用户版" } } }),
    });
    const cfg = await loadUIConfigFor(env, SCOPE);
    expect(flattenPrompts(cfg).find((p) => p.id === COVER_ID).instruction).toBe("用户版");
    expect(flattenPrompts(cfg).find((p) => p.id.endsWith(".cartoon")).instruction).toContain("宫崎骏");
  });
});

describe("handleUIConfigCustom — GET 列表 / PUT 全量单条", () => {
  it("GET：12 条带 customLabel/hidden 状态", async () => {
    const env = fakeEnv({ [KEY]: JSON.stringify({
      overrides: { [COVER_ID]: { instruction: "自定义题图", label: "头图" } }, hidden: [OIL_ID],
    }) });
    const { items } = await (await handleUIConfigCustom(req("GET"), env, SCOPE)).json();
    expect(items.length).toBe(12);
    const cover = items.find((i) => i.id === COVER_ID);
    expect(cover.override).toBe("自定义题图");
    expect(cover.customLabel).toBe("头图");
    expect(cover.hidden).toBe(false);
    expect(items.find((i) => i.id === OIL_ID).hidden).toBe(true);
  });

  it("PUT 写入/改名/隐藏 → 落盘；清空全部 → 文件删除", async () => {
    const env = fakeEnv();
    let r = await (await handleUIConfigCustom(req("PUT", { id: COVER_ID, instruction: "我的版本", label: "头图" }), env, SCOPE)).json();
    expect(r).toMatchObject({ override: "我的版本", customLabel: "头图", hidden: false });

    r = await (await handleUIConfigCustom(req("PUT", { id: OIL_ID, hidden: true }), env, SCOPE)).json();
    expect(r.hidden).toBe(true);
    const disk = JSON.parse(env.FILES._store.get(KEY));
    expect(disk.hidden).toEqual([OIL_ID]);
    expect(disk.overrides[COVER_ID].label).toBe("头图");

    await handleUIConfigCustom(req("PUT", { id: COVER_ID, instruction: "", label: "" }), env, SCOPE);
    await handleUIConfigCustom(req("PUT", { id: OIL_ID, hidden: false }), env, SCOPE);
    expect(env.FILES._store.has(KEY)).toBe(false);
  });

  it("label 超长截断 20 字", async () => {
    const env = fakeEnv();
    const r = await (await handleUIConfigCustom(req("PUT", { id: COVER_ID, label: "一".repeat(30) }), env, SCOPE)).json();
    expect(r.customLabel.length).toBe(20);
  });

  it("PUT 未知 id → 404；坏 body → 400", async () => {
    const env = fakeEnv();
    expect((await handleUIConfigCustom(req("PUT", { id: "a.b.c", instruction: "x" }), env, SCOPE)).status).toBe(404);
    expect((await handleUIConfigCustom(req("PUT", {}), env, SCOPE)).status).toBe(400);
  });
});
