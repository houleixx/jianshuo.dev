// src/prompts.js — 提示词列表的纯逻辑：解析（ref→fork）/ 校验 / 恢复默认。
// spec: voicedrop repo docs/superpowers/specs/2026-07-13-prompt-manager-redesign.md
//
// 用户列表里每一项只有两种形态：
//   {"ref":"sys_*"}  → 我没动过，整条读模板（模板一调优，用户立刻吃到最新）
//   完整实体          → 这条是我的，冻结
// 解析没有"合并"、没有"打补丁"——ref 是整条取模板，不是取底子再盖字段。
//
// 默认全是 ref，所以【不写 prompt 的大多数用户永远拿到最新最好的 prompt】；
// 新建/导入只是多一条实体，其余系统项仍是 ref、仍跟随（轻度触碰不冻结全局）。
import { templateIndex } from "./prompt-template.js";

/// 实体节点 → 对外的解析结果（origin 由 forkedFrom 推出）。
function fromEntity(node) {
  const out = {
    id: node.id, type: node.type, label: node.label,
    origin: node.forkedFrom ? "custom" : "user",
  };
  if (node.forkedFrom) out.forkedFrom = node.forkedFrom;
  if (node.type === "action") {
    out.prompt = node.prompt;
    out.appliesTo = Array.isArray(node.appliesTo) ? [...node.appliesTo] : node.appliesTo;
    if (node.kind !== undefined) out.kind = node.kind;
    if (node.imageParams !== undefined) out.imageParams = deepCloneParams(node.imageParams);
  }
  return out;
}

/// 深拷贝 imageParams：值可能带嵌套对象/数组，浅拷贝（{...obj}）只保护顶层键，
/// 嵌套值仍会与源对象（尤其是模块级 DEFAULT_PROMPT_TEMPLATE，活过整个 Worker isolate）共享引用。
function deepCloneParams(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (typeof structuredClone === "function") return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

/// 模板节点 → 对外的解析结果（origin=system；children 不在这里展开）。
// 防御性拷贝 appliesTo/imageParams：DEFAULT_PROMPT_TEMPLATE 是模块级字面量，
// 活过整个 Worker isolate 的所有请求——原样引用会让某次请求手滑改了输出，
// 就此污染后面每一个请求读到的模板。
function fromTemplate(node) {
  const out = { id: node.id, type: node.type, label: node.label, origin: "system" };
  if (node.type === "action") {
    out.prompt = node.prompt;
    out.appliesTo = Array.isArray(node.appliesTo) ? [...node.appliesTo] : node.appliesTo;
    if (node.kind !== undefined) out.kind = node.kind;
    if (node.imageParams !== undefined) out.imageParams = deepCloneParams(node.imageParams);
  }
  return out;
}

/// 一个列表节点（ref 或实体）→ 解析结果；悬空 ref（模板已删）→ null（调用方丢掉）。
function resolveNode(node, idx) {
  if (node.ref) {
    const t = idx.get(node.ref);
    return t ? fromTemplate(t) : null;
  }
  return fromEntity(node);
}

/// 模板全量 → 解析结果（用户还没有 prompts.json 时走这条）。
function resolveWholeTemplate(template) {
  return (template.items || []).map((item) => {
    const out = fromTemplate(item);
    if (item.type === "group") out.children = (item.children || []).map(fromTemplate);
    return out;
  });
}

export function resolveList(template, userDoc) {
  if (!userDoc || !Array.isArray(userDoc.items)) return resolveWholeTemplate(template);
  const idx = templateIndex(template);
  const out = [];
  for (const node of userDoc.items) {
    const resolved = resolveNode(node, idx);
    if (!resolved) continue;                       // 悬空 ref：模板删了这条
    if (resolved.type === "group") {
      resolved.children = (node.children || [])
        .map((c) => resolveNode(c, idx))
        .filter(Boolean);
    }
    out.push(resolved);
  }
  return out;
}

// ── 校验（PUT /agent/prompts 的守门人）────────────────────────────────────────
export const MAX_ITEMS = 200;
export const MAX_LABEL = 40;
export const MAX_PROMPT = 4000;
const USER_ID_RE = /^p_[a-z0-9]{6,}$/;
const APPLIES = new Set(["text", "image"]);

/// 返回错误信息字符串（→ 400 body）或 null（通过）。
export function validateList(template, items) {
  if (!Array.isArray(items)) return "items must be an array";

  const idx = templateIndex(template);
  const seen = new Set();
  let count = 0;

  // depth 0 = 顶层，1 = 组内。两级封顶 = depth 1 不许再出现 group。
  const walk = (node, depth) => {
    count++;
    if (count > MAX_ITEMS) return `too many items (max ${MAX_ITEMS})`;
    if (!node || typeof node !== "object") return "bad node";

    if (node.ref) {
      if (!idx.has(node.ref)) return `unknown ref: ${node.ref}`;
      if (seen.has(node.ref)) return `duplicate id: ${node.ref}`;
      seen.add(node.ref);
      const t = idx.get(node.ref);
      if (t.type === "group") {
        if (depth > 0) return "groups may only appear at the top level (two levels max)";
        for (const c of node.children || []) {
          const err = walk(c, 1);
          if (err) return err;
        }
      } else if (node.children !== undefined) {
        return "action must not carry children";
      }
      return null;
    }

    // 实体
    if (!USER_ID_RE.test(node.id || "")) return `bad id: ${node.id} (want ^p_[a-z0-9]{6,}$)`;
    if (seen.has(node.id)) return `duplicate id: ${node.id}`;
    seen.add(node.id);

    if (node.type !== "action" && node.type !== "group") return `bad type: ${node.type}`;
    const rawLabel = typeof node.label === "string" ? node.label : "";
    if (!rawLabel.trim()) return "label must not be empty";
    if (rawLabel.length > MAX_LABEL) return `label too long (max ${MAX_LABEL})`;
    if (node.forkedFrom !== undefined && !idx.has(node.forkedFrom)) return `unknown forkedFrom: ${node.forkedFrom}`;

    if (node.type === "group") {
      if (depth > 0) return "groups may only appear at the top level (two levels max)";
      if (node.prompt !== undefined) return "group must not carry a prompt";
      if (node.appliesTo !== undefined) return "group must not carry appliesTo";
      for (const c of node.children || []) {
        const err = walk(c, 1);
        if (err) return err;
      }
      return null;
    }

    // action
    if (node.children !== undefined) return "action must not carry children";
    if (typeof node.prompt !== "string" || !node.prompt.trim()) return "prompt must not be empty";
    if (node.prompt.length > MAX_PROMPT) return `prompt too long (max ${MAX_PROMPT})`;
    if (!Array.isArray(node.appliesTo) || node.appliesTo.length === 0) return "appliesTo must be a non-empty array";
    for (const a of node.appliesTo) if (!APPLIES.has(a)) return `bad appliesTo value: ${a}`;
    return null;
  };

  for (const node of items) {
    const err = walk(node, 0);
    if (err) return err;
  }
  return null;
}
