import { describe, it, expect } from "vitest";
import { loadPrompts } from "../src/prompts/loader.js";
import { buildMinePrompt } from "../src/miner.js";
import { fakeEnv } from "./fakes.js";

describe("mine prompt R2 override 组合", () => {
  it("R2 覆盖 mine.system 后，buildMinePrompt 的 system 反映覆盖值", async () => {
    const env = fakeEnv({ "config/prompts.json": JSON.stringify({ prompts: { "mine.system": "OVERRIDDEN-MINE" } }) });
    const P = await loadPrompts(env);
    const payload = buildMinePrompt({ transcript: "t", styleText: "s", photos: null, force: false, systemPrompt: P["mine.system"], forcePrompt: P["mine.force"] });
    expect(payload.system[0].text).toContain("OVERRIDDEN-MINE");
  });
});
