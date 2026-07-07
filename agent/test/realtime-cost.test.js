import { describe, it, expect } from "vitest";
import { realtimeCostUY, REALTIME_PRICE, reasonZH, uyToSuanli } from "../src/usage.js";

describe("realtimeCostUY", () => {
  it("1M audio_out token = $64 → UY = ceil(64*7.3*1e6)", () => {
    expect(realtimeCostUY({ audio_out: 1_000_000 })).toBe(Math.ceil(64 * 7.3 * 1e6));
  });
  it("1M text_in token = $4 → UY = ceil(4*7.3*1e6)", () => {
    expect(realtimeCostUY({ text_in: 1_000_000 })).toBe(Math.ceil(4 * 7.3 * 1e6));
  });
  it("分档累加：audio_in + audio_out", () => {
    const uy = realtimeCostUY({ audio_in: 500_000, audio_out: 250_000 });
    const usd = 500_000 * REALTIME_PRICE.audio_in + 250_000 * REALTIME_PRICE.audio_out;
    expect(uy).toBe(Math.ceil(usd * 7.3 * 1e6));
  });
  it("1 USD ≈ 167.9 算力（口径自洽）", () => {
    // $1 = 1e6 text_in tokens? 不——直接构造 $1：text_out 1/24*1e6 太绕，改用已知 UY
    expect(Math.round(uyToSuanli(Math.ceil(1 * 7.3 * 1e6)) * 10) / 10).toBe(167.9);
  });
  it("缺字段/非法值当 0，不抛", () => {
    expect(realtimeCostUY({})).toBe(0);
    expect(realtimeCostUY({ audio_in: -5, text_out: "x" })).toBe(0);
  });
  it("reasonZH 认得 realtime", () => {
    expect(reasonZH("realtime")).toBe("AI 采访");
  });
});
