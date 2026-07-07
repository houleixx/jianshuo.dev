// agent/src/prompts/loader.js — 提示词解析：内置默认 ← 全局 R2 config/prompts.json（global 档）。
// 本期无 per-user 层。locked 档 / 未知 id / 空串 / 缺 required 串 一律忽略，坏文件回落默认。
import { PROMPT_DEFAULTS, PROMPT_META } from "./catalog.js";

const MAX_PROMPT_LEN = 40000;

export async function loadPrompts(env) {
  const resolved = { ...PROMPT_DEFAULTS };
  let doc = null;
  try {
    const o = await env?.FILES?.get?.("config/prompts.json");
    if (o) doc = JSON.parse(await o.text());
  } catch { doc = null; }
  const over = doc && typeof doc === "object" && doc.prompts && typeof doc.prompts === "object" ? doc.prompts : null;
  if (over) {
    for (const [id, val] of Object.entries(over)) {
      if (validateOverride(id, val) !== null) continue; // 未知/locked/空/缺串 → 跳过
      resolved[id] = val;
    }
  }
  return resolved;
}

export function validateOverride(id, instruction) {
  const meta = PROMPT_META[id];
  if (!meta || meta.tier !== "global") return "unknown or non-editable prompt id";
  if (typeof instruction !== "string" || !instruction.trim()) return "empty instruction";
  if (instruction.length > MAX_PROMPT_LEN) return `instruction too long (max ${MAX_PROMPT_LEN})`;
  for (const tok of meta.required || []) if (!instruction.includes(tok)) return `missing required token: ${tok}`;
  return null;
}
