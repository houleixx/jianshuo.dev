// 图片流水线 payload 层测试：照片只进 observe/review；style 只进 write；
// previousIssues 只进 plan；温度/schema 按阶段配置。
import { describe, it, expect } from "vitest";
import {
  buildStagePayload, parseStageJson, STAGE_TEMPERATURE, QUALITY_GATE,
  OBSERVE_SYSTEM, PLAN_SYSTEM, WRITE_SYSTEM, REVIEW_SYSTEM,
} from "../src/prompts/image-pipeline.js";

const PHOTOS = [{ b64: "AAAA", label: "10:10:10", relKey: "photos/2026-07-01-101010/0-a1b.jpg" }];
const FACTS  = { place: "Shanghai-Xuhui", session: { date: "2026-07-01" }, photos: [{ key: PHOTOS[0].relKey, time: "10:10:10" }], recentTitles: ["旧文一"] };
const OBS    = { images: [{ key: PHOTOS[0].relKey, caption: "一杯拿铁", confidence: 0.9 }] };
const PLAN   = { thesis: "小店的确定性", sections: [], image_role_map: {} };
const DRAFT  = [{ title: "题", body: "正文" }];

const sysText = (p) => Array.isArray(p.system) ? p.system.map(b => b.text).join("") : p.system;
const userBlocks = (p) => p.messages[0].content;

describe("buildStagePayload (anthropic)", () => {
  it("observe：带照片、带 facts、温度 0.2、无 style", () => {
    const p = buildStagePayload({ stage: "observe", model: "m", photos: PHOTOS, factPack: FACTS });
    expect(p.temperature).toBe(0.2);
    expect(sysText(p)).toContain(OBSERVE_SYSTEM.slice(0, 20));
    expect(sysText(p)).not.toContain("<style>");
    const blocks = userBlocks(p);
    expect(blocks.some(b => b.type === "image")).toBe(true);
    expect(blocks.filter(b => b.type === "text").map(b => b.text).join("")).toContain(`key="${PHOTOS[0].relKey}"`);
    expect(blocks[0].text).toContain('"place":"Shanghai-Xuhui"');
  });
  it("plan：不带照片、带 observation + previousIssues", () => {
    const p = buildStagePayload({ stage: "plan", model: "m", factPack: FACTS, observation: OBS, previousIssues: ["跑题"] });
    expect(p.temperature).toBe(0.3);
    const c = p.messages[0].content;
    expect(typeof c === "string" ? c : c.map(b => b.text).join("")).toContain("<previous_issues>");
    expect(JSON.stringify(p)).not.toContain('"type":"image"');
  });
  it("write：带 <style>（空 styleText 回退默认文风）、带 plan、温度 0.7、articles schema", () => {
    const p = buildStagePayload({ stage: "write", model: "m", factPack: FACTS, observation: OBS, storyPlan: PLAN, styleText: "" });
    expect(p.temperature).toBe(0.7);
    expect(sysText(p)).toContain("<style>");
    expect(p.output_config.format.type).toBe("json_schema");
    expect(JSON.stringify(p)).not.toContain('"type":"image"');
    const c = p.messages[0].content;
    expect(typeof c === "string" ? c : c.map(b => b.text).join("")).toContain("<plan>");
  });
  it("review：带照片 + draft + quality schema、温度 0.1", () => {
    const p = buildStagePayload({ stage: "review", model: "m", photos: PHOTOS, factPack: FACTS, observation: OBS, storyPlan: PLAN, draftArticles: DRAFT });
    expect(p.temperature).toBe(0.1);
    expect(userBlocks(p).some(b => b.type === "image")).toBe(true);
    expect(JSON.stringify(p.output_config.format.schema.properties)).toContain("quality");
  });
  it("未知 stage 抛错", () => {
    expect(() => buildStagePayload({ stage: "nope", model: "m" })).toThrow();
  });
});

describe("buildStagePayload (openai-compat)", () => {
  it("observe：image_url 块 + response_format json_object", () => {
    const p = buildStagePayload({ stage: "observe", provider: "openai-compat", model: "m", photos: PHOTOS, factPack: FACTS });
    expect(p.response_format.type).toBe("json_object");
    expect(p.messages[0].role).toBe("system");
    expect(p.messages[1].content.some(b => b.type === "image_url")).toBe(true);
  });
});

describe("parseStageJson", () => {
  it("剥 ```json 围栏并解析", () => {
    expect(parseStageJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("坏 JSON 抛错", () => {
    expect(() => parseStageJson("not json")).toThrow();
  });
});

describe("prompts 内容底线", () => {
  it("write prompt 含硬底线关键词", () => {
    expect(WRITE_SYSTEM).toContain("绝不编造");
    expect(WRITE_SYSTEM).toContain("[[photo:<key>]]");
    expect(WRITE_SYSTEM).toContain("盘古之白");
  });
  it("review prompt 输出 quality 且 QUALITY_GATE=70", () => {
    expect(REVIEW_SYSTEM).toContain('"quality"');
    expect(QUALITY_GATE).toBe(70);
    expect(STAGE_TEMPERATURE.review).toBe(0.1);
  });
  it("observe/plan prompt 各自只做本阶段", () => {
    expect(OBSERVE_SYSTEM).toContain("只做观察");
    expect(PLAN_SYSTEM).toContain("候选");
  });
});
