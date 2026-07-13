import { describe, it, expect } from "vitest";
import { DEFAULT_PROMPT_TEMPLATE, loadPromptTemplate, templateIndex } from "../src/prompt-template.js";

describe("DEFAULT_PROMPT_TEMPLATE（spec 2026-07-13-prompt-manager-redesign.md §3）", () => {
  const idx = templateIndex(DEFAULT_PROMPT_TEMPLATE);

  it("schema 1；12 个 action + 3 个 group", () => {
    expect(DEFAULT_PROMPT_TEMPLATE.schema).toBe(1);
    const all = [...idx.values()];
    expect(all.filter((n) => n.type === "action").length).toBe(12);
    expect(all.filter((n) => n.type === "group").length).toBe(3);
  });

  it("id 全部 sys_ 前缀，且不编码菜单归属（不含 image./text. 路径段）", () => {
    for (const id of idx.keys()) {
      expect(id).toMatch(/^sys_[a-z0-9_]+$/);
      expect(id).not.toContain("longpress");
    }
  });

  it("六个图片风格：appliesTo=[image]、kind=image、prompt 带 [[photo:{{KEY}}]]", () => {
    for (const id of ["sys_cartoon", "sys_ad", "sys_watercolor", "sys_sketch", "sys_oil", "sys_film"]) {
      const n = idx.get(id);
      expect(n.appliesTo).toEqual(["image"]);
      expect(n.kind).toBe("image");
      expect(n.prompt).toContain("[[photo:{{KEY}}]]");
    }
    expect(idx.get("sys_cartoon").prompt).toContain("宫崎骏");
    expect(idx.get("sys_ad").prompt).toContain("商品广告");
  });

  it("四个改写：appliesTo=[text]、带 {{LINE}}+{{QUOTE}}、无 kind", () => {
    for (const id of ["sys_concise", "sys_casual", "sys_formal", "sys_expand"]) {
      const n = idx.get(id);
      expect(n.appliesTo).toEqual(["text"]);
      expect(n.prompt).toContain("{{LINE}}");
      expect(n.prompt).toContain("{{QUOTE}}");
      expect(n.kind).toBeUndefined();
    }
  });

  it("插入图片两项：appliesTo=[text]（在长按文字里出现）但 kind=image（产出是图）", () => {
    for (const id of ["sys_wechat_cover", "sys_cartoon_explainer"]) {
      const n = idx.get(id);
      expect(n.appliesTo).toEqual(["text"]);
      expect(n.kind).toBe("image");
      expect(n.prompt).not.toContain("{{LINE}}");
    }
    expect(idx.get("sys_wechat_cover").prompt).toContain("2.45:1");
  });

  it("group 无 prompt / appliesTo，children 只装 action（两级封顶）", () => {
    for (const g of [...idx.values()].filter((n) => n.type === "group")) {
      expect(g.prompt).toBeUndefined();
      expect(g.appliesTo).toBeUndefined();
      expect(g.children.length).toBeGreaterThan(0);
      for (const c of g.children) expect(c.type).toBe("action");
    }
  });
});

describe("loadPromptTemplate — R2 整体覆盖，坏数据回退内置", () => {
  const envWith = (text) => ({
    FILES: { get: async (k) => (k === "config/prompt-template.json" && text != null ? { text: async () => text } : null) },
  });

  it("R2 缺失 → 内置", async () => {
    expect(await loadPromptTemplate(envWith(null))).toEqual(DEFAULT_PROMPT_TEMPLATE);
  });

  it("R2 合法 → 整体覆盖", async () => {
    const override = { schema: 1, items: [{ id: "sys_x", type: "action", label: "X", prompt: "p", appliesTo: ["text"] }] };
    expect(await loadPromptTemplate(envWith(JSON.stringify(override)))).toEqual(override);
  });

  it("R2 坏 JSON / 非对象 / 缺 schema / items 非数组 → 内置", async () => {
    expect(await loadPromptTemplate(envWith("{oops"))).toEqual(DEFAULT_PROMPT_TEMPLATE);
    expect(await loadPromptTemplate(envWith('"str"'))).toEqual(DEFAULT_PROMPT_TEMPLATE);
    expect(await loadPromptTemplate(envWith(JSON.stringify({ items: [] })))).toEqual(DEFAULT_PROMPT_TEMPLATE);
    expect(await loadPromptTemplate(envWith(JSON.stringify({ schema: 1 })))).toEqual(DEFAULT_PROMPT_TEMPLATE);
  });
});
