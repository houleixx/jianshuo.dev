import { describe, it, expect } from "vitest";
import { loadPrompts, validateOverride } from "../src/prompts/loader.js";
import { PROMPT_DEFAULTS } from "../src/prompts/catalog.js";
import { fakeEnv } from "./fakes.js";

const seed = (obj) => fakeEnv({ "config/prompts.json": JSON.stringify({ prompts: obj }) });

describe("loadPrompts", () => {
  it("无 R2 文件时返回全部默认值", async () => {
    const p = await loadPrompts(fakeEnv());
    expect(p["mine.system"]).toBe(PROMPT_DEFAULTS["mine.system"]);
    expect(p["image.write"]).toBe(PROMPT_DEFAULTS["image.write"]);
  });
  it("global 档被 R2 覆盖", async () => {
    const p = await loadPrompts(seed({ "mine.system": "新的成文提示词" }));
    expect(p["mine.system"]).toBe("新的成文提示词");
  });
  it("locked 档即便 R2 有值也不被覆盖", async () => {
    const p = await loadPrompts(seed({ "mine.imageOnly": "恶意覆盖" }));
    expect(p["mine.imageOnly"]).toBe(PROMPT_DEFAULTS["mine.imageOnly"]);
  });
  it("空串 / 未知 id 忽略", async () => {
    const p = await loadPrompts(seed({ "mine.force": "   ", "bogus.id": "x" }));
    expect(p["mine.force"]).toBe(PROMPT_DEFAULTS["mine.force"]);
    expect(p["bogus.id"]).toBeUndefined();
  });
  it("坏 JSON 回落默认，不抛", async () => {
    const env = fakeEnv({ "config/prompts.json": "{ not json" });
    const p = await loadPrompts(env);
    expect(p["mine.system"]).toBe(PROMPT_DEFAULTS["mine.system"]);
  });
  it("过长 override 忽略，回落默认", async () => {
    const p = await loadPrompts(seed({ "mine.system": "x".repeat(40001) }));
    expect(p["mine.system"]).toBe(PROMPT_DEFAULTS["mine.system"]);
  });
});

describe("validateOverride", () => {
  it("global 非空放行", () => expect(validateOverride("mine.system", "hi")).toBeNull());
  it("空串拒绝", () => expect(validateOverride("mine.system", "  ")).toBeTruthy());
  it("locked 拒绝", () => expect(validateOverride("mine.imageOnly", "x")).toBeTruthy());
  it("未知 id 拒绝", () => expect(validateOverride("nope", "x")).toBeTruthy());
  it("过长 instruction 拒绝", () => expect(validateOverride("mine.system", "x".repeat(40001))).toBeTruthy());
  it("正常长度放行", () => expect(validateOverride("mine.system", "x".repeat(100))).toBeNull());
});
