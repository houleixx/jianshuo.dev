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

// 字段白名单（spec §3:「有 ref 就没有其他内容字段（children 除外）」）。
// 白名单外的字段一律拒绝——否则任意大小的载荷能从任何一个陌生键名混进存储。
const REF_ACTION_KEYS = new Set(["ref"]);
const REF_GROUP_KEYS = new Set(["ref", "children"]);
const ENTITY_ACTION_KEYS = new Set(["id", "type", "label", "prompt", "appliesTo", "kind", "imageParams", "forkedFrom"]);
const ENTITY_GROUP_KEYS = new Set(["id", "type", "label", "children", "forkedFrom"]);

/// node 里第一个不在 allowed 白名单里的键名，没有则 null。node 此时保证是 JSON.parse 产出的
/// 朴素对象（调用点已经过滤过 null/数组/原始值），Object.keys 不会抛。
function firstUnknownKey(node, allowed) {
  for (const k of Object.keys(node)) {
    if (!allowed.has(k)) return k;
  }
  return null;
}

/// 返回错误信息字符串（→ 400 body）或 null（通过）。整个函数是 total：接收任意
/// JSON.parse 产出的值（对象/数组/字符串/数字/布尔/null 的任意嵌套），只返回
/// string|null，绝不 throw——校验器炸了会把本该的 400 变成 500。
export function validateList(template, items) {
  try {
    return validateListUnsafe(template, items);
  } catch (e) {
    // belt-and-suspenders：万一上面漏了什么 hostile 形状，也绝不能把 400 变成 500。
    return `validation error: ${(e && e.message) || String(e)}`;
  }
}

function validateListUnsafe(template, items) {
  if (!Array.isArray(items)) return "items must be an array";

  const idx = templateIndex(template);
  const seen = new Set();
  let count = 0;

  // depth 0 = 顶层，1 = 组内。两级封顶 = depth 1 不许再出现 group。
  const walk = (node, depth) => {
    count++;
    if (count > MAX_ITEMS) return `too many items (max ${MAX_ITEMS})`;
    if (!node || typeof node !== "object" || Array.isArray(node)) return "bad node";

    if (node.ref) {
      if (!idx.has(node.ref)) return `unknown ref: ${node.ref}`;
      if (seen.has(node.ref)) return `duplicate id: ${node.ref}`;
      seen.add(node.ref);
      const t = idx.get(node.ref);
      const isGroup = t.type === "group";
      const badKey = firstUnknownKey(node, isGroup ? REF_GROUP_KEYS : REF_ACTION_KEYS);
      if (badKey) return `unexpected field on ref node: ${badKey}`;
      if (isGroup) {
        if (depth > 0) return "groups may only appear at the top level (two levels max)";
        if (node.children !== undefined && !Array.isArray(node.children)) return "children must be an array";
        for (const c of node.children || []) {
          const err = walk(c, 1);
          if (err) return err;
        }
      }
      return null;
    }

    // 实体
    if (!USER_ID_RE.test(node.id || "")) return `bad id: ${node.id} (want ^p_[a-z0-9]{6,}$)`;
    if (seen.has(node.id)) return `duplicate id: ${node.id}`;
    seen.add(node.id);

    if (node.type !== "action" && node.type !== "group") return `bad type: ${node.type}`;

    const isGroup = node.type === "group";
    const badKey = firstUnknownKey(node, isGroup ? ENTITY_GROUP_KEYS : ENTITY_ACTION_KEYS);
    if (badKey) return `${isGroup ? "group" : "action"} must not carry field: ${badKey}`;

    const rawLabel = typeof node.label === "string" ? node.label : "";
    if (!rawLabel.trim()) return "label must not be empty";
    if (rawLabel.length > MAX_LABEL) return `label too long (max ${MAX_LABEL})`;
    if (node.forkedFrom !== undefined && !idx.has(node.forkedFrom)) return `unknown forkedFrom: ${node.forkedFrom}`;

    if (isGroup) {
      if (depth > 0) return "groups may only appear at the top level (two levels max)";
      if (node.children !== undefined && !Array.isArray(node.children)) return "children must be an array";
      for (const c of node.children || []) {
        const err = walk(c, 1);
        if (err) return err;
      }
      return null;
    }

    // action
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
