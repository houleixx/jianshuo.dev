import { describe, it, expect } from "vitest";
import { distillStyle, TOTAL_CORPUS_BUDGET, styleName, buildStyleIntroArticle, corpusChars, MIN_CORPUS_CHARS, buildInsufficientCorpusArticle } from "../src/style-extract.js";

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

  it("一次调用：从 风格名 标记抠出名字放第一行，警告放哪都不影响", async () => {
    const samples = [{ title: "A", text: "我写东西偏口语。" }, { title: "B", text: "喜欢短句。" }];
    let callCount = 0;
    const fakeClaude = async ({ system, messages }) => {
      callCount++;
      expect(system).toMatch(/文风/);       // Prompt B
      expect(system).toMatch(/风格名/);      // 起名标记指令
      expect(messages[0].content).toContain("我写东西偏口语");
      // 模型把「样本过少」警告放第一行、风格名标记放第二行 —— 仍能被正确抠出。
      return "样本少于 3 篇，指纹会不稳\n风格名：松弛体\n## 一句话画像\n偏口语、短句、少形容词。";
    };
    const style = await distillStyle(samples, fakeClaude);
    expect(callCount).toBe(1);                        // 只调用一次 Claude
    expect(style.split("\n")[0]).toBe("松弛体");      // 名字在第一行
    expect(style).toContain("短句");                  // Style Card 正文保留
    expect(style).not.toContain("风格名：");           // 标记行已删掉
  });

  it("空语料抛错", async () => {
    await expect(distillStyle([], async () => "")).rejects.toThrow(/empty/);
  });

  it("styleName 取第一行做名字（去引号、限长、空回退）", () => {
    expect(styleName("松弛体\n## 一句话画像\n更多内容")).toBe("松弛体");
    expect(styleName("「短句风」\n后续")).toBe("短句风");
    expect(styleName("")).toBe("你的文风");
  });

  it("buildStyleIntroArticle 模版插入风格名与样本数（数字入参，向后兼容）", () => {
    const { title, body } = buildStyleIntroArticle("松弛体\n画像…", 6);
    expect(title).toContain("松弛体");
    expect(body).toContain("松弛体");
    expect(body).toContain("6 份");
    expect(body).toContain("设置 → 写作风格");
  });

  it("buildStyleIntroArticle 传样本数组时列出素材清单（标题 + 来源，标题缺失退回来源）", () => {
    const samples = [
      { title: "上海咖啡馆漫游", source: "mp.weixin.qq.com" },
      { title: "", source: "example.com/post" },      // 无标题 → 用来源
      { sourceFile: "随笔.docx" },                      // 无 title/source → 用文件名
    ];
    const { body } = buildStyleIntroArticle("口语派\n画像…", samples);
    expect(body).toContain("3 份");
    expect(body).toContain("1. 上海咖啡馆漫游 — mp.weixin.qq.com");
    expect(body).toContain("2. example.com/post");     // 标题空 → 来源当标签
    expect(body).toContain("3. 随笔.docx");             // 退回 sourceFile
  });
});

describe("语料充足性硬闸（anon-15 回归）", () => {
  it("corpusChars 数的是去空白后的有效字数（code points），空/缺 text 记 0", () => {
    expect(corpusChars([])).toBe(0);
    expect(corpusChars([{ text: "  " }, {}, null])).toBe(0);
    expect(corpusChars([{ text: "《送你一颗子弹》" }])).toBe(8);
    expect(corpusChars([{ text: "abc" }, { text: "字".repeat(10) }])).toBe(13);
  });

  it("MIN_CORPUS_CHARS 拦得住书名级碎片，放得过几个真实段落", () => {
    expect(corpusChars([{ text: "《送你一颗子弹》" }])).toBeLessThan(MIN_CORPUS_CHARS);
    expect(corpusChars([{ text: "真实段落。".repeat(80) }])).toBeGreaterThanOrEqual(MIN_CORPUS_CHARS);
  });

  it("buildInsufficientCorpusArticle：说明没改风格 + 列出收到的素材 + 教怎么补", () => {
    const { title, body } = buildInsufficientCorpusArticle(
      [{ title: "送你一颗子弹", source: "weread" }], 8);
    expect(title).toBe("样本不足，风格没有更新");
    expect(body).toContain("8 个字");
    expect(body).toContain("1. 送你一颗子弹 — weread");
    expect(body).toContain("没有改动你的写作风格");
    expect(body).toContain("提取文章风格");
  });
});
