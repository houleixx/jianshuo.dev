import { describe, it, expect } from "vitest";
import { aggregate, renderReport } from "../eval/lib/aggregate.mjs";

const V = (id, winner) => ({ fixtureId: id, winner });

describe("aggregate", () => {
  it("胜率按 decisive（去掉 tie）计", () => {
    const s = aggregate([V("a","candidate"), V("b","candidate"), V("c","champion"), V("d","tie")], { threshold: 0.7 });
    expect(s.decisiveCount).toBe(3);
    expect(s.candidateWinRate).toBeCloseTo(2 / 3, 5);
    expect(s.ties).toBe(1);
  });
  it("胜率达标且无回退 → promote", () => {
    const s = aggregate([V("a","candidate"), V("b","candidate"), V("c","candidate"), V("d","champion")], { threshold: 0.7 });
    expect(s.candidateWinRate).toBeCloseTo(0.75, 5);
    expect(s.decision).toBe("promote");
  });
  it("有确定性回退 → 一律 hold", () => {
    const s = aggregate([V("a","candidate"), V("b","candidate"), V("c","candidate"), V("d","candidate")], { threshold: 0.7, proxyFails: ["a"] });
    expect(s.candidateWinRate).toBe(1);
    expect(s.regressions).toContain("a");
    expect(s.decision).toBe("hold");
  });
  it("胜率不达标 → hold", () => {
    const s = aggregate([V("a","candidate"), V("b","champion"), V("c","champion")], { threshold: 0.7 });
    expect(s.candidateWinRate).toBeCloseTo(1/3, 5);
    expect(s.decision).toBe("hold");
  });
  it("全平局 → winRate=0, decision=hold", () => {
    const s = aggregate([V("a","tie"), V("b","tie")], { threshold: 0.7 });
    expect(s.decisiveCount).toBe(0);
    expect(s.candidateWinRate).toBe(0);
    expect(s.decision).toBe("hold");
  });
  it("非法 winner 抛错", () => {
    expect(() => aggregate([{ fixtureId: "x", winner: "A" }], { threshold: 0.7 })).toThrow(/非法 winner/);
  });
});

describe("renderReport", () => {
  it("含胜率与判定", () => {
    const s = aggregate([V("a","candidate"), V("b","candidate"), V("c","champion")], { threshold: 0.7 });
    const md = renderReport(s, { champRef: "HEAD", candRef: "working" });
    expect(md).toContain("候选胜率");
    expect(md).toContain(s.decision === "promote" ? "晋级" : "保留");
  });
  it("renderReport hold 路径显示保留", () => {
    const s = aggregate([V("a","champion"), V("b","champion")], { threshold: 0.7 });
    const md = renderReport(s, { champRef: "HEAD", candRef: "working" });
    expect(md).toContain("保留");
    expect(md).not.toContain("晋级");
  });
});
