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

// ── jpegDims + fitSize：edit_photo 输出尺寸对齐原图比例 ─────────────────────
import { jpegDims, fitSize } from "../src/paint-size.js";

function fakeJpeg(w, h, { exif = false } = {}) {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0,0,0, 0,0,0, 0,0,0];
  const app1 = exif ? [0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66] : []; // 假 EXIF 段，必须被跳过
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

describe("jpegDims", () => {
  it("reads width/height from SOF0", () => {
    expect(jpegDims(fakeJpeg(4000, 3000))).toEqual({ w: 4000, h: 3000 });
  });
  it("skips APP1 (EXIF) segments before SOF", () => {
    expect(jpegDims(fakeJpeg(1080, 1440, { exif: true }))).toEqual({ w: 1080, h: 1440 });
  });
  it("returns null for non-JPEG bytes", () => {
    expect(jpegDims(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG magic
    expect(jpegDims(new Uint8Array([]))).toBeNull();
  });
});

describe("fitSize", () => {
  it("4:3 横图 → 1024x768", () => expect(fitSize(4000, 3000)).toBe("1024x768"));
  it("3:4 竖图 → 768x1024", () => expect(fitSize(3000, 4000)).toBe("768x1024"));
  it("方图 → 1024x1024", () => expect(fitSize(3024, 3024)).toBe("1024x1024"));
  it("非法输入 → null", () => expect(fitSize(0, 100)).toBeNull());
  it("极端全景短边夹到下限且对齐 16", () => {
    const m = fitSize(8000, 1000).match(/^(\d+)x(\d+)$/);
    expect(Number(m[1]) % 16).toBe(0);
    expect(Number(m[2])).toBeGreaterThanOrEqual(256);
  });
});
