import { describe, it, expect } from "vitest";
import { runTool } from "../src/tools.js";
import { fakeEnv } from "./fakes.js";

const ctx = (env) => ({ env, scope: "users/u/", articleKey: "users/u/articles/cur.json", token: "t", origin: "https://x" });

describe("use_my_prompt", () => {
  it("exact label match returns the full prompt with kind", async () => {
    const r = await runTool("use_my_prompt", { name: "水彩" }, ctx(fakeEnv({})));
    expect(r.label).toBe("水彩");
    expect(r.kind).toBe("image");
    expect(r.prompt).toContain("水彩画风格");
    expect(r.note).toContain("edit_photo");
  });

  it("fuzzy: spoken phrase containing the label still hits", async () => {
    const r = await runTool("use_my_prompt", { name: "白边贴纸那个" }, ctx(fakeEnv({})));
    expect(r.label).toBe("白边贴纸");
    expect(r.kind).toBe("image");
  });

  it("text-kind prompt keeps placeholders for the model to substitute", async () => {
    const r = await runTool("use_my_prompt", { name: "更简洁" }, ctx(fakeEnv({})));
    expect(r.kind).toBe("text");
    expect(r.prompt).toContain("{{LINE}}");
  });

  it("unknown name → not_found with the available catalog", async () => {
    const r = await runTool("use_my_prompt", { name: "不存在的名字" }, ctx(fakeEnv({})));
    expect(r.error).toBe("not_found");
    expect(r.available).toContain("图片风格｜水彩");
  });

  it("user's own tree wins over the template", async () => {
    const env = fakeEnv({
      "users/u/prompts.json": JSON.stringify({ schema: 1, items: [
        { id: "p1", type: "action", label: "招牌改法", prompt: "按我的招牌方式改第{{LINE}}行", appliesTo: ["text"] },
      ] }),
    });
    const r = await runTool("use_my_prompt", { name: "招牌改法" }, ctx(env));
    expect(r.prompt).toContain("招牌方式");
    // 模板项不在这棵树里了
    const miss = await runTool("use_my_prompt", { name: "水彩" }, ctx(env));
    expect(miss.error).toBe("not_found");
  });

  it("duplicated identical labels (historical re-imports) take the first, not ambiguous", async () => {
    const env = fakeEnv({
      "users/u/prompts.json": JSON.stringify({ schema: 1, items: [
        { id: "p1", type: "action", label: "手绘解释风", prompt: "A", appliesTo: ["image"], kind: "image" },
        { id: "p2", type: "action", label: "手绘解释风", prompt: "B", appliesTo: ["image"], kind: "image" },
      ] }),
    });
    const r = await runTool("use_my_prompt", { name: "手绘解释风" }, ctx(env));
    expect(r.prompt).toBe("A");
  });

  it("several near-name matches → ambiguous with candidates", async () => {
    const env = fakeEnv({
      "users/u/prompts.json": JSON.stringify({ schema: 1, items: [
        { id: "p1", type: "action", label: "手绘风", prompt: "A", appliesTo: ["image"], kind: "image" },
        { id: "p2", type: "action", label: "手绘卡通", prompt: "B", appliesTo: ["image"], kind: "image" },
      ] }),
    });
    const r = await runTool("use_my_prompt", { name: "手绘" }, ctx(env));
    expect(r.error).toBe("ambiguous");
    expect(r.candidates).toEqual(["手绘风", "手绘卡通"]);
  });

  it("group labels resolve in the full-path form", async () => {
    const r = await runTool("use_my_prompt", { name: "图片风格｜卡通" }, ctx(fakeEnv({})));
    expect(r.label).toBe("卡通");
    expect(r.group).toBe("图片风格");
  });
});
