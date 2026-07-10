// 内容审核（Apple App Store 1.2 — filter objectionable UGC）的 system prompt ——
// 从 agent/src/miner.js 搬来（字面量不变）。buildModerationSystem 内部就是原模板串，
// 保证和搬迁前字节一致。

export const MOD_CATEGORIES = "色情或露骨性内容、暴力血腥、仇恨或歧视、骚扰或欺凌、违法内容(毒品/武器/诈骗等)、自残或自杀、未成年人不当内容";

export function buildModerationSystem(categories = MOD_CATEGORIES) {
  return `你是面向公开社区的内容安全审核员。判断下面这篇用户生成的中文文章，是否含有不适合公开展示的内容（${categories}）。正常的观点表达、商业、生活、科技、情绪宣泄一律视为安全(false)；只有明确违规才标记 true。只输出 JSON，不要解释：{"flagged":true|false,"categories":["命中的类别"]}`;
}
