import { describe, it, expect } from "vitest";
import { distillStyle } from "../src/style-extract.js";

describe("distillStyle", () => {
  it("把语料样本拼进提示词并从 Claude 返回里取风格文本", async () => {
    const samples = [{ title: "A", text: "我写东西偏口语。" }, { title: "B", text: "喜欢短句。" }];
    const fakeClaude = async ({ system, messages }) => {
      expect(system).toMatch(/风格/);
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
