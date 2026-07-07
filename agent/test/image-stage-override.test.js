import { describe, it, expect } from "vitest";
import { buildStagePayload } from "../src/prompts/image-pipeline.js";
import { loadPrompts } from "../src/prompts/loader.js";
import { fakeEnv } from "./fakes.js";

describe("image stage system override", () => {
  it("不传 stageSystem 时与内置一致（字节不变）", () => {
    const a = buildStagePayload({ stage: "observe", model: "m" });
    expect(a.system[0].text.length).toBeGreaterThan(0);
  });
  it("传入解析后的 stageSystem 覆盖 observe", async () => {
    const env = fakeEnv({ "config/prompts.json": JSON.stringify({ prompts: { "image.observe": "OBS-OVERRIDE" } }) });
    const P = await loadPrompts(env);
    const stageSystem = { observe: P["image.observe"], plan: P["image.plan"], write: P["image.write"], review: P["image.review"] };
    const payload = buildStagePayload({ stage: "observe", model: "m", stageSystem });
    expect(payload.system[0].text).toContain("OBS-OVERRIDE");
  });
});
