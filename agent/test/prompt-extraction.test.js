import { describe, it, expect } from "vitest";
import { MINE_SYSTEM, MINE_SYSTEM_FORCE, PHOTO_INSTR, MINE_DEFAULT_STYLE } from "../src/prompts/mine.js";

describe("prompts/mine.js 文本外置", () => {
  it("MINE_SYSTEM 开头不变", () => {
    expect(MINE_SYSTEM.startsWith("你是这段录音的录制者，在写自己的公众号文章。")).toBe(true);
    expect(MINE_SYSTEM).toContain("只用转写里出现的事实，绝不编造、不脑补");
    expect(MINE_SYSTEM).toContain('{"articles": [{"title": "标题", "body": "正文 markdown", "questions": ["问题", …]}]}');
    expect(MINE_SYSTEM).toContain("永远只产出 1 篇");
    expect(MINE_SYSTEM).toContain("绝不写进 body 正文");
    expect(MINE_SYSTEM).not.toContain('{"articles": [{"title": "标题", "body": "正文 markdown"}, ...]}');
  });
  it("MINE_SYSTEM_FORCE 不变", () => {
    expect(MINE_SYSTEM_FORCE.startsWith("把下面的口述转写整理成一篇短文")).toBe(true);
  });
  it("PHOTO_INSTR 含照片标记说明", () => {
    expect(PHOTO_INSTR).toContain("[[photo:<key>]]");
  });
  it("MINE_DEFAULT_STYLE 含商业十条 DNA", () => {
    expect(MINE_DEFAULT_STYLE).toContain("先想清楚再写");
    expect(MINE_DEFAULT_STYLE).toContain("Show, don't tell");
  });
});
