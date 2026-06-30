import { describe, it, expect } from "vitest";
import { runProxyChecks } from "../eval/lib/proxy-checks.mjs";

describe("runProxyChecks", () => {
  it("正常产出全过", () => {
    const r = runProxyChecks([{ title: "标题", body: "一段足够长的正文内容。".repeat(3) }], { transcript: "原始口述" });
    expect(r.pass).toBe(true);
    expect(r.checks.every(c => c.pass)).toBe(true);
  });
  it("空数组不过（articleCount）", () => {
    const r = runProxyChecks([], { transcript: "x" });
    expect(r.pass).toBe(false);
    expect(r.checks.find(c => c.name === "articleCount").pass).toBe(false);
  });
  it("缺标题不过", () => {
    const r = runProxyChecks([{ title: "", body: "正文正文正文" }], { transcript: "x" });
    expect(r.checks.find(c => c.name === "titlePresent").pass).toBe(false);
  });
  it("正文为空不过", () => {
    const r = runProxyChecks([{ title: "t", body: "   " }], { transcript: "x" });
    expect(r.checks.find(c => c.name === "bodyNonEmpty").pass).toBe(false);
  });
});
