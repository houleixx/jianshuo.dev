// src/usage.js — single source of truth for VoiceDrop usage pricing.
export const FX = 7.3;            // USD->RMB, fixed conservative
export const RATE = 23;           // 算力 per ¥ (23 算力 = ¥1)
export const ASR_RMB_PER_HOUR = 0.8;
export const PRICE = {            // USD per token
  "claude-opus-4-8":   { in: 5 / 1e6, out: 25 / 1e6 },
  "claude-sonnet-4-6": { in: 3 / 1e6, out: 15 / 1e6 },
  "claude-haiku-4-5":  { in: 1 / 1e6, out: 5 / 1e6 },
};
export const MAX_RECORDING_SEC = 3 * 3600;
export const MAX_EDITS_PER_ARTICLE = 100;

export const yuanToUY = (y) => Math.ceil(y * 1e6);          // 元 -> 微元 (ceil)
export const suanliToUY = (s) => Math.round((s / RATE) * 1e6); // 算力 -> 微元
export const uyToSuanli = (uy) => (uy * RATE) / 1e6;        // 微元 -> 算力
export const uyToYuan = (uy) => uy / 1e6;                   // 微元 -> 元

export const SIGNUP_GRANT_UY = suanliToUY(500);            // 一次性 500 算力

export function claudeCostUY(model, inTok, outTok) {
  const p = PRICE[model];
  if (!p) return 0;
  const usd = (inTok || 0) * p.in + (outTok || 0) * p.out;
  return Math.ceil(usd * FX * 1e6);
}
export function asrCostUY(seconds) {
  return Math.ceil(((seconds || 0) / 3600) * ASR_RMB_PER_HOUR * 1e6);
}
export function gateDecision(balanceUY, durationSec) {
  if ((durationSec || 0) > MAX_RECORDING_SEC) return "too-long";
  if (balanceUY <= 0) return "no-credit";
  return "ok";
}
export function editGate(balanceUY, editsSoFar) {
  if (balanceUY <= 0) return "no-credit";
  if ((editsSoFar || 0) >= MAX_EDITS_PER_ARTICLE) return "limit";
  return "ok";
}
