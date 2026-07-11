// src/paint-size.js — 把 "宽x高" 尺寸吸附到 paint.jianshuo.dev 能接受的形状。
// paint 的 CLI 强制宽高必须是 16 的倍数；而 new_photo 的 size 是模型自己填的，
// 模型为凑任意比例（如 4:3 按 1024 高算出 1365）会给出非 16 倍数的宽高，
// 只验格式不对齐就会被 paint 拒（invalid value '1365x1024'）。这里确定性地
// 把每个维度四舍五入到最近的 16 倍数并夹到合理上下限，格式不合法则回退缺省。
const STEP = 16;
const MIN = 256;
const MAX = 4096;

function snapDim(n) {
  const v = Math.round(Number(n) / STEP) * STEP;
  return Math.max(MIN, Math.min(MAX, v)); // MIN/MAX 都是 16 的倍数，夹紧后仍对齐
}

export function snapSize(size, fallback = "1024x1024") {
  const m = typeof size === "string" && size.match(/^(\d{2,4})x(\d{2,4})$/);
  if (!m) return fallback;
  return `${snapDim(m[1])}x${snapDim(m[2])}`;
}

// JPEG SOF 头解析：顺着段结构找 SOFn 取宽高，不解码像素。给 edit_photo 用——
// 相册导入的图不再是方的（App b07ad15 起），输出写死 1024x1024 会把横竖图
// 重画成方形；按原图比例出尺寸才对。非 JPEG / 结构异常返回 null，调用方回退方图。
export function jpegDims(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }                              // padding
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; } // 无长度段
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8];
      return w > 0 && h > 0 ? { w, h } : null;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

// 按原图宽高比出目标尺寸：长边缩到 longSide，两边吸附 16 倍数并夹紧上下限。
export function fitSize(w, h, longSide = 1024) {
  if (!(w > 0 && h > 0)) return null;
  const k = longSide / Math.max(w, h);
  return `${snapDim(w * k)}x${snapDim(h * k)}`;
}
