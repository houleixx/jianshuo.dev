// test/referral-landing.test.js — 落地页 footer 内联 CTA（实时价现算）
import { describe, it, expect } from "vitest";
import { ctaHtml } from "../../functions/voicedrop/[token].js";

describe("ctaHtml", () => {
  it("with rate+cfg shows both amounts inline", () => {
    const h = ctaHtml({ suanliPerCoin: 200 }, { authorCoins: 12, newUserCoins: 6, enabled: true });
    expect(h).toContain("下载");
    expect(h).toContain("你约得 1200 算力");   // 6×200
    expect(h).toContain("作者约得 2400 算力"); // 12×200
    expect(h).toContain("apps.apple.com");
    expect(h).toContain("navigator.clipboard");
    expect(h.startsWith("。")).toBe(true);     // 拼在「口述生成」后面
  });
  it("without rate falls back to plain 下载 (no numbers)", () => {
    const h = ctaHtml(null, { authorCoins: 12, newUserCoins: 6, enabled: true });
    expect(h).toContain("下载");
    expect(h).toContain("apps.apple.com");
    expect(h).not.toMatch(/\d+ 算力/);
  });
  it("disabled → plain 下载, no reward copy", () => {
    const h = ctaHtml({ suanliPerCoin: 200 }, { enabled: false });
    expect(h).not.toContain("算力");
    expect(h).toContain("apps.apple.com");
  });
  it("clipboard write present in all states", () => {
    expect(ctaHtml(null, { enabled: false })).toContain("navigator.clipboard");
  });
});
