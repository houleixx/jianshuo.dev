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
