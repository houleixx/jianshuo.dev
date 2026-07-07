// agent/src/prompts/catalog.js — 核心提示词的默认值 + 元数据（本期接线子集）。
// tier: 'global' = 可被 R2 config/prompts.json 覆盖；'locked' = 只搬迁、永不配置。
// required: 覆盖时必须保留的子串（契约兜底）；本期核心 prompt 的 JSON 由 output_config
// schema 在代码侧强制，故 required 多为空，校验退化成「非空」。
import { MINE_SYSTEM, MINE_SYSTEM_FORCE, IMAGE_ONLY_SYSTEM } from "./mine.js";
import { OBSERVE_SYSTEM, PLAN_SYSTEM, WRITE_SYSTEM, REVIEW_SYSTEM } from "./image-pipeline.js";

export const PROMPT_DEFAULTS = {
  "mine.system": MINE_SYSTEM,
  "mine.force": MINE_SYSTEM_FORCE,
  "mine.imageOnly": IMAGE_ONLY_SYSTEM,
  "image.observe": OBSERVE_SYSTEM,
  "image.plan": PLAN_SYSTEM,
  "image.write": WRITE_SYSTEM,
  "image.review": REVIEW_SYSTEM,
};

export const PROMPT_META = {
  "mine.system":    { label: "挖矿成文 · 主 system", tier: "global", required: [] },
  "mine.force":     { label: "挖矿成文 · 强制兜底", tier: "global", required: [] },
  "mine.imageOnly": { label: "纯图成文（回退）",     tier: "locked", required: [] },
  "image.observe":  { label: "图片流水线 · 观察",   tier: "global", required: [] },
  "image.plan":     { label: "图片流水线 · 选题",   tier: "global", required: [] },
  "image.write":    { label: "图片流水线 · 写作",   tier: "global", required: [] },
  "image.review":   { label: "图片流水线 · 终审",   tier: "global", required: [] },
};
