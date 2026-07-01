import { describe, it, expect } from "vitest";
import { distillStyle, TOTAL_CORPUS_BUDGET, styleName, buildStyleIntroArticle } from "../src/style-extract.js";

describe("distillStyle", () => {
  it("大数据集（很多超长样本）拼出的语料被总量封顶，不会无界增长撑爆 Claude 上下文", async () => {
    // 30 篇样本，每篇远超单篇 4000 字上限 —— 若不做总量封顶，拼接后的语料会有 30*4000=120000+ 字。
    const samples = Array.from({ length: 30 }, (_, i) => ({
      title: `样本${i}`,
      text: "字".repeat(6000),
    }));
    let seenCorpusLength = null;
    const fakeClaude = async ({ system, messages }) => {
      // distillStyle makes 2 calls (card + name); only the card call carries the corpus.
      if (system.includes("文风蒸馏器")) seenCorpusLength = messages[0].content.length;
      return "风格描述";
    };
    await distillStyle(samples, fakeClaude);
    expect(seenCorpusLength).not.toBeNull();
    // 每个样本块最多 ~4020 字（4000 字文本 + 标题/编号开销），所以允许一点超出预算的余量
    // （最后一块可能把总量推过 budget，但不会不受控地累加全部 30 篇）。
    expect(seenCorpusLength).toBeLessThan(TOTAL_CORPUS_BUDGET + 4100);
    expect(seenCorpusLength).toBeGreaterThan(TOTAL_CORPUS_BUDGET - 4100);
  });

  it("两步调用：Prompt B 出 Style Card + 专用起名，名字拼到第一行", async () => {
    const samples = [{ title: "A", text: "我写东西偏口语。" }, { title: "B", text: "喜欢短句。" }];
    const systems = [];
    const fakeClaude = async ({ system, messages }) => {
      systems.push(system);
      if (system.includes("文风蒸馏器")) {          // Prompt B（Style Card 调用）
        expect(messages[0].content).toContain("我写东西偏口语");
        return "样本少于 3 篇，指纹会不稳\n## 一句话画像\n偏口语、短句、少形容词。";
      }
      expect(system).toMatch(/五个字以内/);          // NAME_SYSTEM（起名调用）
      return "松弛体";                               // 模型只被要求起名时，干净返回
    };
    const style = await distillStyle(samples, fakeClaude);
    expect(systems.length).toBe(2);                  // card + name
    expect(style.split("\n")[0]).toBe("松弛体");     // 名字在第一行（即使 card 首行是「样本过少」提醒）
    expect(style).toContain("短句");                 // Style Card 正文保留
  });

  it("空语料抛错", async () => {
    await expect(distillStyle([], async () => "")).rejects.toThrow(/empty/);
  });

  it("styleName 取第一行做名字（去引号、限长、空回退）", () => {
    expect(styleName("松弛体\n## 一句话画像\n更多内容")).toBe("松弛体");
    expect(styleName("「短句风」\n后续")).toBe("短句风");
    expect(styleName("")).toBe("你的文风");
  });

  it("buildStyleIntroArticle 模版插入风格名与样本数", () => {
    const { title, body } = buildStyleIntroArticle("松弛体\n画像…", 6);
    expect(title).toContain("松弛体");
    expect(body).toContain("松弛体");
    expect(body).toContain("6 份");
    expect(body).toContain("设置 → 写作风格");
  });
});
