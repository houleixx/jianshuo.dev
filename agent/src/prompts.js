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
    out.appliesTo = node.appliesTo;
    if (node.kind !== undefined) out.kind = node.kind;
    if (node.imageParams !== undefined) out.imageParams = node.imageParams;
  }
  return out;
}

/// 模板节点 → 对外的解析结果（origin=system；children 不在这里展开）。
function fromTemplate(node) {
  const out = { id: node.id, type: node.type, label: node.label, origin: "system" };
  if (node.type === "action") {
    out.prompt = node.prompt;
    out.appliesTo = node.appliesTo;
    if (node.kind !== undefined) out.kind = node.kind;
    if (node.imageParams !== undefined) out.imageParams = node.imageParams;
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
