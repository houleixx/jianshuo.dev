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

// Prompt-caching pricing multipliers (Anthropic): a cache WRITE (5-min ephemeral)
// bills at 1.25x base input, a cache READ at 0.1x. `input_tokens` from the API is
// already the UNcached remainder, so total input = inTok·1 + cacheWrite·1.25 +
// cacheRead·0.1. cacheWrite/cacheRead default to 0 → old two/three-arg callers and
// non-cached models are unchanged.
export const CACHE_WRITE_MULT = 1.25;
export const CACHE_READ_MULT  = 0.1;
export function claudeCostUY(model, inTok, outTok, cacheWriteTok = 0, cacheReadTok = 0) {
  const p = PRICE[model];
  if (!p) return 0;
  const usd = (inTok || 0) * p.in
            + (cacheWriteTok || 0) * p.in * CACHE_WRITE_MULT
            + (cacheReadTok || 0) * p.in * CACHE_READ_MULT
            + (outTok || 0) * p.out;
  return Math.ceil(usd * FX * 1e6);
}
export function asrCostUY(seconds) {
  return Math.ceil(((seconds || 0) / 3600) * ASR_RMB_PER_HOUR * 1e6);
}

// OpenAI Realtime (gpt-realtime-2.1) 官方费率，USD per token。跟官方更新只改这里。
export const REALTIME_PRICE = {
  audio_in:        32 / 1e6,
  audio_in_cached: 0.40 / 1e6,
  audio_out:       64 / 1e6,
  text_in:         4 / 1e6,
  text_in_cached:  0.40 / 1e6,
  text_out:        24 / 1e6,
};

// usage: { audio_in, audio_in_cached, audio_out, text_in, text_in_cached, text_out }（token 数）
// → 微元(UY)，与 claudeCostUY 同式：ceil(usd × FX × 1e6)。缺字段/非法 → 0。
export function realtimeCostUY(usage = {}) {
  const p = REALTIME_PRICE;
  const n = (k) => { const v = Number(usage && usage[k]); return Number.isFinite(v) && v > 0 ? v : 0; };
  const usd =
    n("audio_in") * p.audio_in + n("audio_in_cached") * p.audio_in_cached + n("audio_out") * p.audio_out +
    n("text_in") * p.text_in + n("text_in_cached") * p.text_in_cached + n("text_out") * p.text_out;
  return Math.ceil(usd * FX * 1e6);
}

// 图片编辑（gpt-image-2 via paint）单价：按算力计价，避免 FX 漂移。
export const IMAGE_SUANLI = 1.8;
export function imageCostUY() { return suanliToUY(IMAGE_SUANLI); }

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

// ── 过期 / 订阅常量（分桶账本）─────────────────────────────────────────────
export const DAY_MS = 86400000;
export const SIGNUP_EXPIRE_DAYS  = 365;   // 注册赠送 1 年
export const CAMPAIGN_EXPIRE_DAYS = 90;   // 活动赠送默认 3 个月
export const SUB_GRANT_SUANLI = 200;      // 包月发放（P3 用，先定义集中管理）
export const expiryAfterDays = (now, days) => now + days * DAY_MS;

// ── 账本 action 的中文名（单一真源）─────────────────────────────────────────
// DB 的 ledger.reason 永远存英文码（editCount 等按码查询，是稳定标识）；
// 翻译只发生在 /agent/usage/ledger 出口 → 新老 App、网页、skill 全部即刻中文。
export const REASON_ZH = {
  "signup":        "注册赠送",
  "asr":           "语音转写",
  "mine":          "挖文章",
  "edit":          "语音修改",
  "image-edit":    "图片编辑",
  "style-extract": "文风蒸馏",
  "xhs-pack":      "小红书分享",
  "xhs-tags":      "小红书分享",
  "feed_author":   "收到投币",
  "feed_curator":  "投币奖励",
  "subscription":  "包月发放",
  "monthly":       "包月发放",
  "migrated":      "余额迁移",
  "overdraft":     "透支",
  "realtime":      "AI 采访",
  "referral_author": "邀请奖励",
  "referral_new":    "受邀赠送",
};
export function reasonZH(reason) {
  if (!reason) return reason;
  if (REASON_ZH[reason]) return REASON_ZH[reason];
  if (reason.startsWith("campaign:")) return "活动赠送";
  return reason; // 未知码原样透出，别让新玩法悄悄显示成错误中文
}

// ── 投币 / 铸币（社区互助扩散池）───────────────────────────────────────────
// 固定池 + 相对份额：payout_uy = coins_uc × POOL_7D_UY ÷ (SEED + 近7天铸币 + 本次)。
// SEED 70 币是价格分母的永久底座（不随 7 天窗口滑出）：冷启动/低活跃期价格
// 天然封顶在 14000/70 = 200 算力/币，无需另做结算任务，即时到账数学上安全。
export const DAILY_POOL_SUANLI = 2000;                          // 每日注入池子
export const DAILY_POOL_UY     = suanliToUY(DAILY_POOL_SUANLI);
export const POOL_7D_UY        = suanliToUY(DAILY_POOL_SUANLI * 7);
export const SEED_COINS_UC     = 70e6;    // 70 币底座（微金币，1 币 = 1e6 uc）
export const FEED_AUTHOR_UC    = 2e6;     // 一次投币：文章作者得 2 币
export const FEED_FEEDER_UC    = 0.5e6;   // 投币者得 0.5 币
export const FEED_GRANT_EXPIRE_DAYS = 90; // 投币所得算力 90 天过期（白送的钱不留永久负债）
export const FUSE_MULT         = 5;       // 保险丝：当日发放 > 5×日池 → 暂停投币
export const ucToCoins = (uc) => uc / 1e6;
// 同对递减（防「多产垃圾文章刷币」）：同一投币者→同一作者，第2次×0.7，第3次起×0.5。
export const pairDiscount = (prior) => (prior <= 0 ? 1 : prior === 1 ? 0.7 : 0.5);

// ── 邀请奖励（referral，币记价，与投币同池同价）────────────────────────────
// R2 config/referral.json 整体覆盖这些默认值（零部署调价/关闸）。
export const REFERRAL_DEFAULTS = {
  enabled: true,
  authorCoins: 9,         // 作者（分享 owner）得币
  newUserCoins: 9,        // 新装用户得币
  dailyCapPerOwner: 30,   // owner 每日被奖励安装数上限（超出只发新人侧）
  requireDeviceCheck: true,
};
