import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval, loadFixtures } from "../eval/run-eval.mjs";

const fixtures = [
  { id: "f1", transcript: "甲乙丙", photos: [], tags: [] },
  { id: "f2", transcript: "丁戊己", photos: [], tags: [] },
];

// fake 模型：冠军 prompt 回一篇，候选 prompt 回两篇——靠 system 文本区分
function fakeCallModel(payload) {
  const sys = payload.system?.[0]?.text || "";
  if (sys.includes("CAND")) {
    return JSON.stringify({ articles: [{ title: "A", body: "这是一段足够长的正文内容用于测试" }, { title: "B", body: "这是一段足够长的正文内容用于测试" }] });
  }
  return JSON.stringify({ articles: [{ title: "C", body: "这是一段足够长的正文内容用于测试" }] });
}

describe("runEval（注入式）", () => {
  it("每条 fixture 跑出冠军/候选两份产出 + 代理检查", async () => {
    const r = await runEval({
      fixtures, champSystem: "CHAMP-PROMPT", candSystem: "CAND-PROMPT",
      callModel: fakeCallModel, model: "test-model",
    });
    expect(r.results).toHaveLength(2);
    const f1 = r.results.find(x => x.fixtureId === "f1");
    expect(f1.champion.articles).toHaveLength(1);
    expect(f1.candidate.articles).toHaveLength(2);
    expect(f1.champion.proxy.pass).toBe(true);
    expect(f1.candidate.proxy.pass).toBe(true);
  });
  it("候选 prompt 经 systemPrompt 注入（产出受候选影响）", async () => {
    const r = await runEval({
      fixtures: [fixtures[0]], champSystem: "X", candSystem: "CAND-PROMPT",
      callModel: fakeCallModel, model: "m",
    });
    expect(r.results[0].candidate.articles.map(a => a.title)).toEqual(["A", "B"]);
  });
});

describe("loadFixtures local/samples 回退", () => {
  it("有 local 时优先读 local，否则读 samples", () => {
    const base = mkdtempSync(join(tmpdir(), "fx-"));
    mkdirSync(join(base, "samples"), { recursive: true });
    writeFileSync(join(base, "samples", "s.json"), JSON.stringify({ id: "s", transcript: "x", photos: [], tags: [] }));
    // no local/ yet → reads samples
    expect(loadFixtures(base).map(f => f.id)).toEqual(["s"]);
    // add a local/ fixture → now prefers local
    mkdirSync(join(base, "local"), { recursive: true });
    writeFileSync(join(base, "local", "l.json"), JSON.stringify({ id: "l", transcript: "y", photos: [], tags: [] }));
    expect(loadFixtures(base).map(f => f.id)).toEqual(["l"]);
  });
});
