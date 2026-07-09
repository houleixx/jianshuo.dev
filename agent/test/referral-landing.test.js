// test/referral-landing.test.js — 落地页 CTA 文案（实时价现算，带「约」）
import { describe, it, expect } from "vitest";
import { ctaHtml } from "../../functions/voicedrop/[token].js";

describe("ctaHtml", () => {
  it("with rate+cfg shows both amounts", () => {
    const h = ctaHtml({ suanliPerCoin: 200 }, { authorCoins: 12, newUserCoins: 6, enabled: true });
    expect(h).toContain("1200");   // 6×200 你约得
    expect(h).toContain("2400");   // 12×200 作者约得
    expect(h).toContain("约");
    expect(h).toContain("apps.apple.com");
    expect(h).toContain("navigator.clipboard");
  });
  it("without rate falls back to generic copy (no numbers)", () => {
    const h = ctaHtml(null, { authorCoins: 12, newUserCoins: 6, enabled: true });
    expect(h).toContain("apps.apple.com");
    expect(h).not.toMatch(/\d+<\/b> 算力/);
  });
  it("disabled → still a download CTA, no reward copy", () => {
    const h = ctaHtml({ suanliPerCoin: 200 }, { enabled: false });
    expect(h).not.toContain("算力");
    expect(h).toContain("apps.apple.com");
  });
  it("clipboard write still present when disabled (harmless)", () => {
    const h = ctaHtml(null, { enabled: false });
    expect(h).toContain("navigator.clipboard");
  });
});
