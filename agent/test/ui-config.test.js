import { vi, describe, it, expect } from "vitest";
vi.mock("agents", () => ({ Agent: class Agent {}, getAgentByName: async () => ({}) }));
import worker from "../src/index.js";
import { fakeEnv } from "./fakes.js";
import { DEFAULT_UI_CONFIG, loadUIConfig } from "../src/ui-config.js";

const leafInstructions = (menu) => {
  const out = [];
  const walk = (n) => { if (n.instruction) out.push(n.instruction); (n.children || []).forEach(walk); };
  (menu.groups || []).flat().forEach(walk);
  return out;
};

describe("DEFAULT_UI_CONFIG shape (spec 2026-07-04-longpress-actions-menu-design.md)", () => {
  const lp = DEFAULT_UI_CONFIG.pages["voice-editor"].longpress;

  it("schema 1 + voice-editor longpress 两节", () => {
    expect(DEFAULT_UI_CONFIG.schema).toBe(1);
    expect(lp.image.groups.length).toBeGreaterThan(0);
    expect(lp.text.groups.length).toBeGreaterThan(0);
  });

  it("image 六个风格叶子全带 [[photo:{{KEY}}]]，含 卡通(宫崎骏) 与 广告", () => {
    const ins = leafInstructions(lp.image);
    expect(ins.length).toBe(6);
    for (const i of ins) expect(i).toContain("[[photo:{{KEY}}]]");
    expect(ins.some((i) => i.includes("宫崎骏"))).toBe(true);
    expect(ins.some((i) => i.includes("商品广告"))).toBe(true);
  });

  it("text 四个改写叶子带 {{LINE}}+{{QUOTE}}；公众号题图说『放在文章最前面』+2.45:1，不带行占位", () => {
    const ins = leafInstructions(lp.text);
    const rewrites = ins.filter((i) => i.includes("{{LINE}}"));
    expect(rewrites.length).toBe(4);
    for (const i of rewrites) expect(i).toContain("{{QUOTE}}");
    const cover = ins.find((i) => i.includes("题图"));
    expect(cover).toBeTruthy();
    expect(cover).toContain("放在文章最前面");
    expect(cover).toContain("2.45:1");
    expect(cover).not.toContain("{{LINE}}");
  });
});

describe("loadUIConfig — R2 config/ui-config.json 整体覆盖，坏数据回退内置", () => {
  const envWith = (text) => ({
    FILES: { get: async (k) => (k === "config/ui-config.json" && text != null ? { text: async () => text } : null) },
  });

  it("R2 缺失 → 内置", async () => {
    expect(await loadUIConfig(envWith(null))).toEqual(DEFAULT_UI_CONFIG);
  });

  it("R2 合法 → 整体覆盖", async () => {
    const override = { schema: 1, pages: { "voice-editor": { longpress: { image: { groups: [[]] } } } } };
    expect(await loadUIConfig(envWith(JSON.stringify(override)))).toEqual(override);
  });

  it("R2 损坏 JSON / 非对象 / 缺 schema → 内置", async () => {
    expect(await loadUIConfig(envWith("{oops"))).toEqual(DEFAULT_UI_CONFIG);
    expect(await loadUIConfig(envWith('"just a string"'))).toEqual(DEFAULT_UI_CONFIG);
    expect(await loadUIConfig(envWith(JSON.stringify({ pages: {} })))).toEqual(DEFAULT_UI_CONFIG);
  });
});

describe("GET /agent/ui-config route", () => {
  it("无 token → 401", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/ui-config"), env);
    expect(res.status).toBe(401);
  });

  it("POST → 405", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(new Request("https://jianshuo.dev/agent/ui-config", { method: "POST" }), env);
    expect(res.status).toBe(405);
  });

  it("anon token → 200 JSON，body 即内置配置", async () => {
    const env = fakeEnv();
    const res = await worker.fetch(
      new Request("https://jianshuo.dev/agent/ui-config", { headers: { Authorization: "Bearer anon_testtoken1234567890" } }),
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.schema).toBe(1);
    expect(body.pages["voice-editor"].longpress.text.groups.length).toBeGreaterThan(0);
  });

  it("R2 覆盖经由 route 生效", async () => {
    const override = { schema: 1, pages: { library: { longpress: {} } } };
    const env = fakeEnv({ "config/ui-config.json": JSON.stringify(override) });
    const res = await worker.fetch(
      new Request("https://jianshuo.dev/agent/ui-config", { headers: { Authorization: "Bearer anon_testtoken1234567890" } }),
      env
    );
    expect(await res.json()).toEqual(override);
  });
});
