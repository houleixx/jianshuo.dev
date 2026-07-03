// image-mine 素材层与编排层测试。
// 文件名约定（iOS RecordingName.make）：
//   VoiceDrop-yyyy-MM-dd-HHmmss-<dur>-<weekday>-<period>[-City[-District]]
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { parsePlaceTag, parseSessionInfo, fetchRecentTitles, buildFactPack, runImagePipeline, rewriteFromVision } from "../src/image-mine.js";

const SCOPE = "users/anon-abc/";

describe("parsePlaceTag", () => {
  it("城市+区都在：取尾部 ASCII 段", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai-Xuhui")).toBe("Shanghai-Xuhui");
  });
  it("只有城市", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai")).toBe("Shanghai");
  });
  it("无地点标签 → null", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-01-101010-1s-周三-上午")).toBeNull();
  });
  it("Task 类型尾标不是地点（英文 weekday 场景）", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-02-100000-0m0s-Thu-Morning-TaskStyleExtract")).toBeNull();
  });
  it("地点后跟 Task 尾标：只取地点", () => {
    expect(parsePlaceTag("VoiceDrop-2026-07-01-101010-1s-Thu-Morning-Shanghai-TaskStyleExtract")).toBe("Shanghai");
  });
  it("非 VoiceDrop 命名 → null", () => {
    expect(parsePlaceTag("random-file-name")).toBeNull();
  });
});

describe("parseSessionInfo", () => {
  it("解析日期/时刻/星期/时段", () => {
    expect(parseSessionInfo("VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai")).toEqual({
      date: "2026-07-01", time: "10:10:10", weekday: "周三", period: "上午",
    });
  });
  it("非法名 → null", () => {
    expect(parseSessionInfo("nope")).toBeNull();
  });
});

describe("fetchRecentTitles / buildFactPack", () => {
  const docJson = (title) => JSON.stringify({ schema: 2, articles: [{ title, body: "x" }] });
  it("按 key 时间序取尾部标题，排除自身与 .asr.json", async () => {
    const env = fakeEnv({
      [`${SCOPE}articles/VoiceDrop-2026-06-01-000000-1s-a-b.json`]: docJson("一"),
      [`${SCOPE}articles/VoiceDrop-2026-06-02-000000-1s-a-b.json`]: docJson("二"),
      [`${SCOPE}articles/VoiceDrop-2026-06-03-000000-1s-a-b.asr.json`]: "{}",
      [`${SCOPE}articles/SELF.json`]: docJson("自己"),
    });
    const titles = await fetchRecentTitles(env, SCOPE, { excludeStem: "SELF", max: 10 });
    expect(titles).toEqual(["一", "二"]);
  });
  it("超过 max 只留最近的", async () => {
    const seed = {};
    for (let d = 1; d <= 9; d++) seed[`${SCOPE}articles/VoiceDrop-2026-06-0${d}-000000-1s-a-b.json`] = docJson(`t${d}`);
    const titles = await fetchRecentTitles(fakeEnv(seed), SCOPE, { max: 3 });
    expect(titles).toEqual(["t7", "t8", "t9"]);
  });
  it("R2 挂了 → 空列表不抛", async () => {
    const env = { FILES: { list: async () => { throw new Error("boom"); } } };
    expect(await fetchRecentTitles(env, SCOPE)).toEqual([]);
  });
  it("buildFactPack 汇总四类素材", async () => {
    const env = fakeEnv({ [`${SCOPE}articles/VoiceDrop-2026-06-01-000000-1s-a-b.json`]: docJson("旧文") });
    const photos = [{ b64: "AA", label: "10:10:10", relKey: "photos/2026-07-01-101010/0-x.jpg" }];
    const fp = await buildFactPack(env, { scope: SCOPE, stem: "VoiceDrop-2026-07-01-101010-1s-周三-上午-Shanghai-Xuhui", photos });
    expect(fp.place).toBe("Shanghai-Xuhui");
    expect(fp.session.date).toBe("2026-07-01");
    expect(fp.photos).toEqual([{ key: photos[0].relKey, time: "10:10:10" }]);
    expect(fp.recentTitles).toEqual(["旧文"]);
  });
});

// ── 纯编排层 ──────────────────────────────────────────────────────────────────

const REL = "photos/2026-07-01-101010/0-x.jpg";
const PHOTOS2 = [{ b64: "AA", label: "10:10:10", relKey: REL }];
const FACTS2 = { place: "Shanghai", session: { date: "2026-07-01" }, photos: [{ key: REL, time: "10:10:10" }], recentTitles: [] };
const CANNED = {
  observe: { images: [{ key: REL, caption: "拿铁", confidence: 0.9, importance: 0.9, role_guess: "opening" }], timeline: "", clusters: [], repeated_entities: [] },
  plan: { candidates: [{ theme: "A", evidence_keys: [REL], score: 90, reason: "r" }], selected: "A", rejected_because: "", thesis: "主旨", title_options: ["题"], sections: [{ purpose: "p", image_keys: [REL], key_points: [] }], image_role_map: { [REL]: "opening" } },
  write: { articles: [{ title: "初稿题", body: `初稿。\n\n[[photo:${REL}]]` }] },
  review: { articles: [{ title: "终稿题", body: `终稿。\n\n[[photo:${REL}]]` }], quality: { faithfulness: 95, on_theme: 90, structure: 88, overall: 92 }, issues: [] },
};
const scripted = (overrides = {}) => {
  const calls = [];
  const fn = async ({ stage, payload }) => {
    calls.push({ stage, payload });
    const seq = overrides[stage];
    const body = Array.isArray(seq) ? seq[calls.filter((c) => c.stage === stage).length - 1] : (seq || CANNED[stage]);
    if (body instanceof Error) throw body;
    return JSON.stringify(body);
  };
  fn.calls = calls;
  return fn;
};

describe("runImagePipeline", () => {
  it("四阶段顺序执行，照片只出现在 observe/review 的 payload", async () => {
    const cm = scripted();
    const r = await runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm });
    expect(cm.calls.map((c) => c.stage)).toEqual(["observe", "plan", "write", "review"]);
    for (const c of cm.calls) {
      const hasImage = JSON.stringify(c.payload).includes('"type":"image"');
      expect(hasImage).toBe(c.stage === "observe" || c.stage === "review");
    }
    expect(r.articles).toEqual([{ title: "终稿题", body: `终稿。\n\n[[photo:${REL}]]` }]);
    expect(r.vision.images[0].key).toBe(REL);
    expect(r.plan.thesis).toBe("主旨");
    expect(r.quality.overall).toBe(92);
    expect(r.lowQuality).toBe(false);
  });
  it("质量门不过 → 带 issues 重跑一次并取分高一版", async () => {
    const low  = { articles: [{ title: "低", body: `低。\n\n[[photo:${REL}]]` }], quality: { faithfulness: 40, on_theme: 50, structure: 50, overall: 45 }, issues: ["误读了招牌"] };
    const high = { articles: [{ title: "高", body: `高。\n\n[[photo:${REL}]]` }], quality: { faithfulness: 90, on_theme: 85, structure: 85, overall: 88 }, issues: [] };
    const cm = scripted({ review: [low, high] });
    const r = await runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm });
    expect(cm.calls.map((c) => c.stage)).toEqual(["observe", "plan", "write", "review", "plan", "write", "review"]);
    const secondPlan = cm.calls[4];
    expect(JSON.stringify(secondPlan.payload)).toContain("误读了招牌");
    expect(r.articles[0].title).toBe("高");
    expect(r.lowQuality).toBe(false);
  });
  it("两轮都不过 → 交付分高一版且 lowQuality=true", async () => {
    const l1 = { articles: [{ title: "一", body: "x" }], quality: { faithfulness: 40, on_theme: 40, structure: 40, overall: 40 }, issues: ["i"] };
    const l2 = { articles: [{ title: "二", body: "y" }], quality: { faithfulness: 50, on_theme: 50, structure: 50, overall: 50 }, issues: [] };
    const r = await runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: scripted({ review: [l1, l2] }) });
    expect(r.articles[0].title).toBe("二");
    expect(r.lowQuality).toBe(true);
  });
  it("阶段输出坏 JSON → 抛错（由调用方回退单发）", async () => {
    const cm = async ({ stage }) => (stage === "plan" ? "not json" : JSON.stringify(CANNED[stage]));
    await expect(runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm })).rejects.toThrow();
  });
  it("write 出空文章 → 抛错", async () => {
    const cm = scripted({ write: { articles: [] } });
    await expect(runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm })).rejects.toThrow("write-stage-empty");
  });
  it("review 文章为空时保底用初稿", async () => {
    const cm = scripted({ review: { articles: [], quality: { faithfulness: 90, on_theme: 90, structure: 90, overall: 90 }, issues: [] } });
    const r = await runImagePipeline({ photos: PHOTOS2, factPack: FACTS2, styleText: "s", model: "m", callModel: cm });
    expect(r.articles[0].title).toBe("初稿题");
  });
});

describe("rewriteFromVision", () => {
  it("只跑 write+review，plan 固定", async () => {
    const cm = scripted();
    const r = await rewriteFromVision({ photos: PHOTOS2, factPack: FACTS2, vision: CANNED.observe, plan: CANNED.plan, styleText: "新文风", model: "m", callModel: cm });
    expect(cm.calls.map((c) => c.stage)).toEqual(["write", "review"]);
    expect(JSON.stringify(cm.calls[0].payload)).toContain("新文风");
    expect(r.articles[0].title).toBe("终稿题");
    expect(r.quality.overall).toBe(92);
  });
});
