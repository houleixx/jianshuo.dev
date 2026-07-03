// image-mine 素材层与编排层测试。
// 文件名约定（iOS RecordingName.make）：
//   VoiceDrop-yyyy-MM-dd-HHmmss-<dur>-<weekday>-<period>[-City[-District]]
import { describe, it, expect } from "vitest";
import { fakeEnv } from "./fakes.js";
import { parsePlaceTag, parseSessionInfo, fetchRecentTitles, buildFactPack } from "../src/image-mine.js";

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
