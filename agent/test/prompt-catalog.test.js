import { describe, it, expect } from "vitest";
import { PROMPT_DEFAULTS, PROMPT_META } from "../src/prompts/catalog.js";
import { MINE_SYSTEM } from "../src/prompts/mine.js";

describe("prompt catalog", () => {
  it("每个 id 都有非空默认串和 tier", () => {
    for (const [id, meta] of Object.entries(PROMPT_META)) {
      expect(typeof PROMPT_DEFAULTS[id]).toBe("string");
      expect(PROMPT_DEFAULTS[id].length).toBeGreaterThan(0);
      expect(["global", "locked"]).toContain(meta.tier);
    }
  });
  it("默认值与源常量同字节（不得漂移）", () => {
    expect(PROMPT_DEFAULTS["mine.system"]).toBe(MINE_SYSTEM);
  });
  it("required 里的串必须真的出现在默认值中", () => {
    for (const [id, meta] of Object.entries(PROMPT_META)) {
      for (const tok of meta.required || []) expect(PROMPT_DEFAULTS[id]).toContain(tok);
    }
  });
});
