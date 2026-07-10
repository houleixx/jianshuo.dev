import { describe, it, expect } from "vitest";
import { snapSize } from "../src/paint-size.js";

describe("snapSize", () => {
  it("把非 16 倍数的宽吸附到最近的 16 倍数（模型算 4:3 的 bug 复现）", () => {
    expect(snapSize("1365x1024")).toBe("1360x1024"); // 1365 → round(85.31)*16 = 1360
  });
  it("已经是 16 倍数的尺寸原样保留", () => {
    expect(snapSize("1568x640")).toBe("1568x640");
    expect(snapSize("1024x1536")).toBe("1024x1536");
    expect(snapSize("1024x1024")).toBe("1024x1024");
  });
  it("越界的维度夹到 [256,4096]，且仍是 16 的倍数", () => {
    expect(snapSize("9999x100", "1024x1024")).toBe("4096x256");
  });
  it("360 这类非对齐值吸附到最近的 16 倍数", () => {
    expect(snapSize("640x360")).toBe("640x368"); // 360/16=22.5 → Math.round 上取 23 → 368
  });
  it("格式不合法或缺省 → 回退给定 fallback", () => {
    expect(snapSize(undefined, "1536x1024")).toBe("1536x1024");
    expect(snapSize("garbage", "1536x1024")).toBe("1536x1024");
    expect(snapSize("1024", "1024x1024")).toBe("1024x1024");
  });
});
