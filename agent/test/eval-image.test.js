// image eval：proxy checks 的确定性判定 + runImageEval 的 champion/candidate 双跑。
import { describe, it, expect } from "vitest";
import { runImageProxyChecks } from "../eval/lib/image-proxy-checks.mjs";
import { runImageEval, loadImageFixtures } from "../eval/run-image-eval.mjs";

const K = "photos/2026-07-01-101010/0-x.jpg";

describe("runImageProxyChecks", () => {
  it("每图恰好一次且独占一行 → pass", () => {
    const r = runImageProxyChecks([{ title: "t", body: `a\n\n[[photo:${K}]]\n\nb` }], { photoKeys: [K] });
    expect(r.pass).toBe(true);
  });
  it("漏图 / 重复 / 发明 key / 非独行 → 对应 failure", () => {
    expect(runImageProxyChecks([{ title: "t", body: "无图" }], { photoKeys: [K] }).failures).toContain(`missing-photo:${K}`);
    expect(runImageProxyChecks([{ title: "t", body: `[[photo:${K}]]\n[[photo:${K}]]` }], { photoKeys: [K] }).failures).toContain(`dup-photo:${K}`);
    expect(runImageProxyChecks([{ title: "t", body: `[[photo:ghost.jpg]]\n\n[[photo:${K}]]` }], { photoKeys: [K] }).failures).toContain("invented-photo:ghost.jpg");
    expect(runImageProxyChecks([{ title: "t", body: `文字[[photo:${K}]]同行` }], { photoKeys: [K] }).failures).toContain("marker-not-own-line");
    expect(runImageProxyChecks([], { photoKeys: [K] }).failures).toContain("no-article");
  });
});

describe("runImageEval", () => {
  const FX = [{ id: "fx1", stem: "VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai", photos: [{ b64: "AA", label: "10:10:10", relKey: K }], styleText: "" }];
  const CANNED = {
    single: { articles: [{ title: "单发", body: `s\n\n[[photo:${K}]]` }] },
    observe: { images: [{ key: K, caption: "c", confidence: 0.9 }], timeline: "", clusters: [], repeated_entities: [] },
    plan: { candidates: [], selected: "A", rejected_because: "", thesis: "t", title_options: [], sections: [], image_role_map: {} },
    write: { articles: [{ title: "初稿", body: `w\n\n[[photo:${K}]]` }] },
    review: { articles: [{ title: "流水线", body: `r\n\n[[photo:${K}]]` }], quality: { faithfulness: 90, on_theme: 90, structure: 90, overall: 90 }, issues: [] },
  };
  it("champion 走 IMAGE_ONLY 单发、candidate 走四阶段，各自带 proxy", async () => {
    const stages = [];
    const callModel = async ({ stage }) => { stages.push(stage); return JSON.stringify(CANNED[stage]); };
    const { results } = await runImageEval({ fixtures: FX, callModel, model: "m" });
    expect(stages).toEqual(["single", "observe", "plan", "write", "review"]);
    expect(results[0].champion.articles[0].title).toBe("单发");
    expect(results[0].candidate.articles[0].title).toBe("流水线");
    expect(results[0].champion.proxy.pass).toBe(true);
    expect(results[0].candidate.proxy.pass).toBe(true);
  });
  it("candidate 某阶段抛错 → candidate.error 记录且不影响 champion", async () => {
    const callModel = async ({ stage }) => { if (stage === "plan") throw new Error("boom"); return JSON.stringify(CANNED[stage] || CANNED.single); };
    const { results } = await runImageEval({ fixtures: FX, callModel, model: "m" });
    expect(results[0].champion.articles.length).toBe(1);
    expect(results[0].candidate.error).toContain("boom");
    expect(results[0].candidate.proxy.pass).toBe(false);
  });
});

describe("loadImageFixtures", () => {
  it("samples 目录可加载且结构齐全", () => {
    const fx = loadImageFixtures();
    expect(fx.length).toBeGreaterThan(0);
    expect(fx[0]).toHaveProperty("id");
    expect(fx[0].photos[0]).toHaveProperty("b64");
    expect(fx[0].photos[0]).toHaveProperty("relKey");
  });
});
