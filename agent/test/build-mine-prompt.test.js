import { describe, it, expect } from "vitest";
import { buildMinePrompt } from "../src/miner.js";

const T = "今天去看了一家咖啡馆。";

describe("buildMinePrompt — anthropic 默认 (system cache)", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "", photos: [], force: false, provider: "anthropic", model: "claude-opus-4-8" });
  it("system 是一个带 ephemeral 缓存的块", () => {
    expect(p.system).toHaveLength(1);
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
  it("system 文本含 SYSTEM + style 尾巴（无个人文风时用默认 DNA）", () => {
    expect(p.system[0].text).toContain("你是这段录音的录制者");
    expect(p.system[0].text).toContain("<style>");
    expect(p.system[0].text).toContain("胸有成竹"); // DEFAULT_STYLE
  });
  it("user content 是 transcript", () => {
    expect(p.messages[0].role).toBe("user");
    expect(p.messages[0].content).toBe(`<transcript>\n${T}\n</transcript>`);
  });
  it("非 force 带 json_schema output_config", () => {
    expect(p.output_config.format.type).toBe("json_schema");
    expect(p.max_tokens).toBe(8000);
  });
});

describe("buildMinePrompt — 个人文风顶替默认", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "我的专属文风XYZ", photos: [], force: false, provider: "anthropic", model: "m" });
  it("style 槽用传入文风、不再含默认 DNA", () => {
    expect(p.system[0].text).toContain("我的专属文风XYZ");
    expect(p.system[0].text).not.toContain("胸有成竹");
  });
});

describe("buildMinePrompt — force 兜底", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "x", photos: [], force: true, provider: "anthropic", model: "m" });
  it("用 SYSTEM_FORCE、无 style、无 schema、max_tokens 2000", () => {
    expect(p.system[0].text).toContain("把下面的口述转写整理成一篇短文");
    expect(p.system[0].text).not.toContain("<style>");
    expect(p.output_config).toBeUndefined();
    expect(p.max_tokens).toBe(2000);
  });
});

describe("buildMinePrompt — 带照片", () => {
  const photos = [{ relKey: "photos/2026/a.jpg", label: "10:00:00", b64: "QUJD" }];
  const p = buildMinePrompt({ transcript: T, styleText: "", photos, force: false, provider: "anthropic", model: "m" });
  it("system 追加 PHOTO_INSTR", () => {
    expect(p.system[0].text).toContain("[[photo:<key>]]");
  });
  it("user content 含 image 块 + photo 标签", () => {
    const c = p.messages[0].content;
    expect(Array.isArray(c)).toBe(true);
    expect(c.some(b => b.type === "image" && b.source?.data === "QUJD")).toBe(true);
    expect(c.some(b => b.type === "text" && b.text.includes('<photo key="photos/2026/a.jpg"'))).toBe(true);
  });
});

describe("buildMinePrompt — transcript cache 模式（restyle）", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "风格A", photos: [], force: false, cacheMode: "transcript", provider: "anthropic", model: "m" });
  it("system 块不含 style 尾巴（移到 user 末尾）", () => {
    // MINE_SYSTEM itself mentions "<style>" in its instructions, so we check for
    // the specific styleTail format (\n\n<style>\n…) rather than the bare tag.
    expect(p.system[0].text).not.toContain("\n\n<style>\n");
  });
  it("transcript 块带缓存断点、style 尾巴在其后", () => {
    const c = p.messages[0].content;
    expect(c[0].cache_control).toEqual({ type: "ephemeral" });
    expect(c[c.length - 1].text).toContain("<style>");
    expect(c[c.length - 1].text).toContain("风格A");
  });
});

describe("buildMinePrompt — openai-compat", () => {
  const p = buildMinePrompt({ transcript: T, styleText: "", photos: [], force: false, provider: "openai-compat", model: "deepseek" });
  it("system 是字符串、user 是字符串、带 json_object", () => {
    expect(p.messages[0].role).toBe("system");
    expect(typeof p.messages[0].content).toBe("string");
    expect(p.messages[1].content).toBe(`<transcript>\n${T}\n</transcript>`);
    expect(p.response_format).toEqual({ type: "json_object" });
  });
});

describe("buildMinePrompt — 候选 prompt 可注入", () => {
  it("systemPrompt 参数顶替默认 SYSTEM", () => {
    const p = buildMinePrompt({ transcript: T, styleText: "", photos: [], force: false, provider: "anthropic", model: "m", systemPrompt: "候选版本PROMPT" });
    expect(p.system[0].text).toContain("候选版本PROMPT");
    expect(p.system[0].text).not.toContain("你是这段录音的录制者");
  });
});
