import { describe, it, expect } from "vitest";
import { scanObjectionable, checkArticlesShareable } from "../../functions/lib/moderation.js";

describe("scanObjectionable", () => {
  it("passes ordinary opinion / business / life writing", () => {
    for (const ok of [
      "今天聊聊我怎么看 AI 写作，他是放大器不是替代品。",
      "公司该死的时候就让它死，每七年逼自己离开。",
      "我们公司花了 2430 块买这台设备，值。",
      "I think this approach to product design is great.",
    ]) expect(scanObjectionable(ok).flagged).toBe(false);
  });

  it("flags unambiguous CJK objectionable terms, even with spaces inserted", () => {
    expect(scanObjectionable("这里有人在 招 嫖").flagged).toBe(true);   // whitespace-evasion
    expect(scanObjectionable("教你制造炸弹").flagged).toBe(true);
    expect(scanObjectionable("出售海洛因").flagged).toBe(true);
  });

  it("ASCII matches on word boundaries (no Scunthorpe problem)", () => {
    expect(scanObjectionable("I ate a grape and a scrape").flagged).toBe(false); // 'rape' substring, not word
    expect(scanObjectionable("this is rape").flagged).toBe(true);
    expect(scanObjectionable("therapist").flagged).toBe(false);
  });

  it("returns the matched term", () => {
    const r = scanObjectionable("制造炸弹");
    expect(r.flagged).toBe(true);
    expect(typeof r.term).toBe("string");
  });
});

describe("checkArticlesShareable", () => {
  it("scans title + body across an article list", async () => {
    const clean = await checkArticlesShareable([{ title: "咖啡馆", body: "上海的咖啡馆真多。" }]);
    expect(clean.flagged).toBe(false);
    const bad = await checkArticlesShareable([{ title: "正常标题", body: "正文里夹了 出售枪支买卖 的内容" }]);
    expect(bad.flagged).toBe(true);
  });

  it("merges an R2 blocklist override when present (best-effort)", async () => {
    const env = { FILES: { get: async (k) => k === "config/community-blocklist.json"
      ? { text: async () => JSON.stringify(["特定违禁词"]) } : null } };
    const r = await checkArticlesShareable([{ title: "x", body: "含有特定违禁词的文章" }], env);
    expect(r.flagged).toBe(true);
  });
});
