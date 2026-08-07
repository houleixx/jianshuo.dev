import { describe, it, expect } from "vitest";
import { sniffImageType, sniffB64ImageType } from "../src/image-type.js";
import { buildMinePrompt } from "../src/miner.js";

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PNG  = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF  = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
// HEIC: ....ftypheic — 模型不收，必须嗅成 null
const HEIC = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

const b64 = (u8) => btoa(String.fromCharCode(...u8));

describe("sniffImageType — magic bytes 认格式", () => {
  it("四种支持格式各归其位", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });
  it("HEIC / 乱字节 / 空 → null", () => {
    expect(sniffImageType(HEIC)).toBeNull();
    expect(sniffImageType(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
  it("RIFF 但不是 WEBP（如 WAV）→ null", () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffImageType(wav)).toBeNull();
  });
  it("ArrayBuffer 入参也行", () => {
    expect(sniffImageType(JPEG.buffer)).toBe("image/jpeg");
  });
});

describe("sniffB64ImageType — base64 头部嗅探", () => {
  it("认 png、认 jpeg", () => {
    expect(sniffB64ImageType(b64(PNG))).toBe("image/png");
    expect(sniffB64ImageType(b64(JPEG))).toBe("image/jpeg");
  });
  it("HEIC / 非法 base64 → null", () => {
    expect(sniffB64ImageType(b64(HEIC))).toBeNull();
    expect(sniffB64ImageType("!!!not-base64!!!")).toBeNull();
  });
});

describe("buildMinePrompt — image 块用照片的真实 media_type", () => {
  const photos = [
    { relKey: "photos/1/a.jpg", label: "10:00:00", b64: "QUJD", mediaType: "image/png" },
    { relKey: "photos/1/b.jpg", label: "10:00:01", b64: "REVG" },   // 无 mediaType → 默认 jpeg
  ];
  const p = buildMinePrompt({ transcript: "t", styleText: "", photos, force: false, model: "m" });
  it("嗅出来什么就报什么，缺省回退 jpeg", () => {
    const imgs = p.messages[0].content.filter((b) => b.type === "image");
    expect(imgs.map((b) => b.source.media_type)).toEqual(["image/png", "image/jpeg"]);
  });
});
