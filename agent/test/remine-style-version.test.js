import { describe, it, expect } from "vitest";
import { resolveStyleVersion } from "../src/miner.js";

describe("resolveStyleVersion — 重写用当前文风 head", () => {
  const doc = { head: 3, versions: [{ v: 1 }, { v: 2 }, { v: 3 }] };

  it("显式 styleV 优先", () => {
    expect(resolveStyleVersion(doc, 2)).toBe(2);
  });
  it("styleV 缺省(null) → 用 head", () => {
    expect(resolveStyleVersion(doc, null)).toBe(3);
  });
  it("styleV 缺省(undefined) → 用 head", () => {
    expect(resolveStyleVersion(doc, undefined)).toBe(3);
  });
  it("非整数 styleV(如字符串) → 用 head", () => {
    expect(resolveStyleVersion(doc, "3")).toBe(3);
  });
  it("文风 doc 缺失 → null", () => {
    expect(resolveStyleVersion(null, null)).toBe(null);
  });
  it("文风 doc 无 head → null", () => {
    expect(resolveStyleVersion({ versions: [] }, null)).toBe(null);
  });
});
