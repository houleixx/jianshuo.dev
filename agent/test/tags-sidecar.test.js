import { describe, it, expect } from "vitest";
import { consumePendingTags } from "../src/miner.js";
import { affectedStems } from "../src/command-turn.js";

// 极简 env.FILES（内存 R2）——只要 get/delete。
function memFiles(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    _store: store,
    async get(k) { return store.has(k) ? { async text() { return store.get(k); } } : null; },
    async delete(k) { store.delete(k); },
  };
}

const AUDIO = "users/abc/VoiceDrop-2026-07-04-100000-1m0s-Fri-Morning.m4a";
const SIDECAR = "users/abc/articles/VoiceDrop-2026-07-04-100000-1m0s-Fri-Morning.tags";

describe("consumePendingTags（tag 页录音的 .tags 侧车）", () => {
  it("读出标签数组并删除侧车（只生效一次）", async () => {
    const env = { FILES: memFiles({ [SIDECAR]: JSON.stringify(["创业", "创业", "东京"]) }) };
    const tags = await consumePendingTags(AUDIO, env);
    expect(tags).toEqual(["创业", "东京"]);              // 去重
    expect(env.FILES._store.has(SIDECAR)).toBe(false);   // 消费即删
    expect(await consumePendingTags(AUDIO, env)).toEqual([]);   // 第二次是空
  });

  it("没有侧车 → []；侧车是坏 JSON → [] 且删掉", async () => {
    expect(await consumePendingTags(AUDIO, { FILES: memFiles() })).toEqual([]);
    const env = { FILES: memFiles({ [SIDECAR]: "not json" }) };
    expect(await consumePendingTags(AUDIO, env)).toEqual([]);
    expect(env.FILES._store.has(SIDECAR)).toBe(false);
  });
});

describe("affectedStems（updated 推送带受影响 stems）", () => {
  it("汇总成功工具调用的 stems/stem/newStem，去重，忽略失败的", () => {
    const runs = [
      { name: "tag_article", input: { stems: ["A", "B"], tag: "创业" }, result: { ok: true }, ok: true },
      { name: "restyle_article", input: { stem: "B" }, result: { ok: true }, ok: true },
      { name: "merge_articles", input: { stems: ["A"] }, result: { ok: true, newStem: "VoiceDrop-merged-1" }, ok: true },
      { name: "tag_article", input: { stems: ["C"] }, result: { error: "bad_stem" }, ok: false },  // 失败 → 不算
    ];
    expect(affectedStems(runs).sort()).toEqual(["A", "B", "VoiceDrop-merged-1"].sort());
  });

  it("空/缺省输入不炸", () => {
    expect(affectedStems()).toEqual([]);
    expect(affectedStems([{ ok: true }])).toEqual([]);
  });
});
