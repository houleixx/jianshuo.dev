import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import { DEFAULT_UI_CONFIG, loadUserOverrides, applyUserOverrides, loadUIConfigFor } from "../src/ui-config.js";
import { handleUIConfigCustom } from "../src/ui-config-custom.js";
import { flattenPrompts } from "../src/prompt-registry.js";
import { fakeEnv } from "./fakes.js";

const SCOPE = "users/sub123/";
const KEY = SCOPE + "ui-config.json";
const COVER_ID = "voice-editor.longpress.text.insert.wechat-cover";

const req = (method, body) =>
  new Request("https://jianshuo.dev/agent/ui-config/custom", {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe("applyUserOverrides — 稀疏合并", () => {
  it("只覆盖命中的叶子，其余不动；未知 id 忽略；不动原对象", () => {
    const next = applyUserOverrides(DEFAULT_UI_CONFIG, { [COVER_ID]: "我的题图指令", "x.y.z": "nope" });
    const flat = flattenPrompts(next);
    expect(flat.find((p) => p.id === COVER_ID).instruction).toBe("我的题图指令");
    expect(flat.filter((p) => p.id !== COVER_ID)).toEqual(
      flattenPrompts(DEFAULT_UI_CONFIG).filter((p) => p.id !== COVER_ID));
    expect(flattenPrompts(DEFAULT_UI_CONFIG).find((p) => p.id === COVER_ID).instruction).toContain("2.45:1");
  });

  it("空覆盖 = 原样返回", () => {
    expect(applyUserOverrides(DEFAULT_UI_CONFIG, {})).toBe(DEFAULT_UI_CONFIG);
  });
});

describe("loadUserOverrides — 读用户稀疏文件", () => {
  it("缺文件/坏 JSON/空值过滤", async () => {
    expect(await loadUserOverrides(fakeEnv(), SCOPE)).toEqual({});
    expect(await loadUserOverrides(fakeEnv({ [KEY]: "{oops" }), SCOPE)).toEqual({});
    const env = fakeEnv({ [KEY]: JSON.stringify({ overrides: { [COVER_ID]: "自定义", empty: "  ", num: 5 } }) });
    expect(await loadUserOverrides(env, SCOPE)).toEqual({ [COVER_ID]: "自定义" });
  });

  it("非 users/ scope（admin）→ 空", async () => {
    expect(await loadUserOverrides(fakeEnv(), null)).toEqual({});
  });
});

describe("loadUIConfigFor — 三层：内置 ← 全局 R2 ← 用户", () => {
  it("用户覆盖赢过全局覆盖", async () => {
    const globalCfg = JSON.parse(JSON.stringify(DEFAULT_UI_CONFIG));
    const env = fakeEnv({
      "config/ui-config.json": JSON.stringify(applyUserOverrides(globalCfg, { [COVER_ID]: "全局版" })),
      [KEY]: JSON.stringify({ overrides: { [COVER_ID]: "用户版" } }),
    });
    const cfg = await loadUIConfigFor(env, SCOPE);
    expect(flattenPrompts(cfg).find((p) => p.id === COVER_ID).instruction).toBe("用户版");
    // 没有用户覆盖的叶子 → 全局/内置
    expect(flattenPrompts(cfg).find((p) => p.id.endsWith(".cartoon")).instruction).toContain("宫崎骏");
  });
});

describe("handleUIConfigCustom — GET 列表 / PUT 写删", () => {
  it("GET：11 条，default 来自全局生效版，override 缺省 null", async () => {
    const env = fakeEnv({ [KEY]: JSON.stringify({ overrides: { [COVER_ID]: "自定义题图" } }) });
    const res = await handleUIConfigCustom(req("GET"), env, SCOPE);
    const { items } = await res.json();
    expect(items.length).toBe(11);
    const cover = items.find((i) => i.id === COVER_ID);
    expect(cover.default).toContain("2.45:1");
    expect(cover.override).toBe("自定义题图");
    expect(items.find((i) => i.id.endsWith(".cartoon")).override).toBeNull();
  });

  it("PUT 写入 → 文件落盘；PUT 空 → 删条目，最后一条删掉整个文件", async () => {
    const env = fakeEnv();
    let res = await handleUIConfigCustom(req("PUT", { id: COVER_ID, instruction: "我的版本" }), env, SCOPE);
    expect((await res.json()).override).toBe("我的版本");
    expect(JSON.parse(env.FILES._store.get(KEY)).overrides[COVER_ID]).toBe("我的版本");

    res = await handleUIConfigCustom(req("PUT", { id: COVER_ID, instruction: "  " }), env, SCOPE);
    expect((await res.json()).override).toBeNull();
    expect(env.FILES._store.has(KEY)).toBe(false);
  });

  it("PUT 未知 id → 404；坏 body → 400", async () => {
    const env = fakeEnv();
    expect((await handleUIConfigCustom(req("PUT", { id: "a.b.c", instruction: "x" }), env, SCOPE)).status).toBe(404);
    expect((await handleUIConfigCustom(req("PUT", {}), env, SCOPE)).status).toBe(400);
  });
});
