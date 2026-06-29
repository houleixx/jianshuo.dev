import { describe, it, expect } from "vitest";
import {
  claudeCostUY, asrCostUY, uyToSuanli, SIGNUP_GRANT_UY,
  gateDecision, editGate, MAX_RECORDING_SEC, MAX_EDITS_PER_ARTICLE,
} from "../src/usage.js";

describe("usage pricing", () => {
  it("claudeCostUY: haiku 1000in/100out = 10950 微元", () => {
    expect(claudeCostUY("claude-haiku-4-5", 1000, 100)).toBe(10950);
  });
  it("claudeCostUY: unknown model = 0", () => {
    expect(claudeCostUY("gpt-x", 1000, 100)).toBe(0);
  });
  it("claudeCostUY: cache read = 0.1x base input (opus 1000 read = 3650)", () => {
    // plain 1000 opus input = 36500 微元; a cache read is 1/10 of that.
    expect(claudeCostUY("claude-opus-4-8", 1000, 0)).toBe(36500);
    expect(claudeCostUY("claude-opus-4-8", 0, 0, 0, 1000)).toBe(3650);
  });
  it("claudeCostUY: cache write = 1.25x base input (opus 1000 write = 45625)", () => {
    expect(claudeCostUY("claude-opus-4-8", 0, 0, 1000, 0)).toBe(45625);
  });
  it("asrCostUY: 1 hour = 800000 微元 = 18.4 算力", () => {
    expect(asrCostUY(3600)).toBe(800000);
    expect(uyToSuanli(800000)).toBeCloseTo(18.4, 5);
  });
  it("signup grant ≈ 500 算力", () => {
    expect(uyToSuanli(SIGNUP_GRANT_UY)).toBeCloseTo(500, 2);
  });
});

describe("usage gates", () => {
  it("gateDecision: too-long wins over balance", () => {
    expect(gateDecision(999999, MAX_RECORDING_SEC + 1)).toBe("too-long");
  });
  it("gateDecision: zero balance blocks", () => {
    expect(gateDecision(0, 60)).toBe("no-credit");
    expect(gateDecision(1, 60)).toBe("ok");
  });
  it("editGate: balance then limit", () => {
    expect(editGate(0, 0)).toBe("no-credit");
    expect(editGate(100, MAX_EDITS_PER_ARTICLE)).toBe("limit");
    expect(editGate(100, 0)).toBe("ok");
  });
});
