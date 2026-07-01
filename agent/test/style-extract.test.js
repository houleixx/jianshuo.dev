import { describe, it, expect } from "vitest";
import { distillStyle, TOTAL_CORPUS_BUDGET } from "../src/style-extract.js";

describe("distillStyle", () => {
  it("大数据集（很多超长样本）拼出的语料被总量封顶，不会无界增长撑爆 Claude 上下文", async () => {
    // 30 篇样本，每篇远超单篇 4000 字上限 —— 若不做总量封顶，拼接后的语料会有 30*4000=120000+ 字。
    const samples = Array.from({ length: 30 }, (_, i) => ({
      title: `样本${i}`,
      text: "字".repeat(6000),
    }));
    let seenCorpusLength = null;
    const fakeClaude = async ({ messages }) => {
      seenCorpusLength = messages[0].content.length;
      return "风格描述";
    };
    await distillStyle(samples, fakeClaude);
    expect(seenCorpusLength).not.toBeNull();
    // 每个样本块最多 ~4020 字（4000 字文本 + 标题/编号开销），所以允许一点超出预算的余量
    // （最后一块可能把总量推过 budget，但不会不受控地累加全部 30 篇）。
    expect(seenCorpusLength).toBeLessThan(TOTAL_CORPUS_BUDGET + 4100);
    expect(seenCorpusLength).toBeGreaterThan(TOTAL_CORPUS_BUDGET - 4100);
  });

  it("把语料样本拼进提示词并从 Claude 返回里取风格文本", async () => {
    const samples = [{ title: "A", text: "我写东西偏口语。" }, { title: "B", text: "喜欢短句。" }];
    const fakeClaude = async ({ system, messages }) => {
      expect(system).toMatch(/文风/);              // Prompt B（文风蒸馏器 / Style Card）
      expect(system).toMatch(/五个字以内/);         // 第一行起名要求
      expect(messages[0].content).toContain("我写东西偏口语");
      return "偏口语、短句、少形容词。";
    };
    const style = await distillStyle(samples, fakeClaude);
    expect(style).toContain("短句");
  });

  it("空语料抛错", async () => {
    await expect(distillStyle([], async () => "")).rejects.toThrow(/empty/);
  });
});
