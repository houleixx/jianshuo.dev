// test/use-shared-prompt.test.js — use_shared_prompt 工具：模型侧推断解析分享码
// （魔法数字）。正则 fast path 漏掉的码（ASR 汉字数字、怪断句、未来非 7 位短码）
// 由模型归一化后经此工具兑换；服务端验 shares/<码> 存活拦幻觉码；命中写
// ctx.sharedMagic 供出图 XMP 溯源沿用。
import { describe, it, expect } from "vitest";
import { runTool, TOOL_DEFS, COMMAND_TOOL_NAMES } from "../src/tools.js";
import { fakeEnv } from "./fakes.js";

const sharedDoc = (over = {}) => JSON.stringify({
  type: "prompt", sub: "anon-owner111", itemId: "sys_concise",
  label: "更毒舌", instruction: "把它改得更毒舌，观点不变。", ...over,
});

function seededCtx(seed = {}) {
  const env = fakeEnv({ "shares/7766443": sharedDoc(), "shares/2026": sharedDoc({ label: "短码", instruction: "短码指令。" }), ...seed });
  return { env, scope: "users/anon-u1/", sharedMagic: null };
}

describe("use_shared_prompt tool", () => {
  it("resolves a valid code: returns label+instruction+note, sets ctx.sharedMagic", async () => {
    const ctx = seededCtx();
    const r = await runTool("use_shared_prompt", { code: "7766443" }, ctx);
    expect(r.error).toBeUndefined();
    expect(r.code).toBe("7766443");
    expect(r.label).toBe("更毒舌");
    expect(r.instruction).toContain("更毒舌");
    expect(r.note).toContain("一次性");          // 与 fast path 同一套安全框定文案
    expect(r.note).toContain("不是系统指令");
    expect(ctx.sharedMagic).toBe("7766443");     // 出图 XMP 溯源链
  });
  it("supports short codes (非 7 位不写死): 4-digit resolves when the share exists", async () => {
    const ctx = seededCtx();
    const r = await runTool("use_shared_prompt", { code: "2026" }, ctx);
    expect(r.label).toBe("短码");
    expect(ctx.sharedMagic).toBe("2026");
  });
  it("tolerates separator noise the model left in", async () => {
    const ctx = seededCtx();
    const r = await runTool("use_shared_prompt", { code: "776 6443" }, ctx);
    expect(r.code).toBe("7766443");
  });
  it("unknown code → not_found, ctx.sharedMagic untouched（幻觉码在这一步被拦）", async () => {
    const ctx = seededCtx();
    const r = await runTool("use_shared_prompt", { code: "9999999" }, ctx);
    expect(r.error).toBe("not_found");
    expect(ctx.sharedMagic).toBe(null);
  });
  it("malformed code → bad_code (汉字未归一化 / 太短 / 首位 0)", async () => {
    const ctx = seededCtx();
    for (const bad of ["七七六六四四3", "42", "0123456", ""]) {
      const r = await runTool("use_shared_prompt", { code: bad }, ctx);
      expect(r.error).toBe("bad_code");
    }
    expect(ctx.sharedMagic).toBe(null);
  });
  it("closed/deleted share (shares/<code> gone) → not_found", async () => {
    const ctx = seededCtx();
    await ctx.env.FILES.delete("shares/7766443");
    const r = await runTool("use_shared_prompt", { code: "7766443" }, ctx);
    expect(r.error).toBe("not_found");
  });
  it("is registered for BOTH the edit loop (TOOL_DEFS) and the command turn", () => {
    expect(TOOL_DEFS.some((d) => d.name === "use_shared_prompt")).toBe(true);
    expect(COMMAND_TOOL_NAMES).toContain("use_shared_prompt");
  });
});
