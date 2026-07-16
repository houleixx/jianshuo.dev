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
  it("execCommand 剪贴板兜底（微信 webview 里 navigator.clipboard 常不可用）", () => {
    expect(ctaHtml(null, { enabled: false })).toContain("execCommand");
  });
  it("带 id 时内联第一方 beacon（反代下真实 IP 只能靠它）；不带 id 不内联", () => {
    const withId = ctaHtml({ suanliPerCoin: 200 }, { authorCoins: 9, newUserCoins: 9, enabled: true }, "Ab3xK9_p2Q");
    expect(withId).toContain("/agent/referral/hit");
    expect(withId).toContain("Ab3xK9_p2Q");
    expect(ctaHtml(null, { enabled: false })).not.toContain("/agent/referral/hit");
  });
});
