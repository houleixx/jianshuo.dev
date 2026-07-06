// src/ui-config-custom.js — 每用户的 ui-config 指令自定义（iOS 设置页的后端）。
//
// GET  /agent/ui-config/custom → { schema, items: [{id, label, default, override, customLabel, hidden}] }
//      label/default = 全局生效版（内置 ← 全局 R2 覆盖）的名称与指令；
//      override / customLabel / hidden = 该用户的自定义状态（null/false = 未自定义）。
// PUT  /agent/ui-config/custom → body {id, instruction?, label?, hidden?}
//      单条全量状态：instruction/label 空串或缺省 → 清掉该项（回落缺省）；
//      hidden 布尔（缺省 false）。全部清空时删除整个用户覆盖文件。
//      存储：users/<sub>/ui-config.json = { overrides: {id: {instruction?, label?}}, hidden: [id] }。
//
// 认证由 index.js 完成（用户 token → scope），这里只管业务。
import { loadUIConfig, loadUserOverrides } from "./ui-config.js";
import { flattenPrompts } from "./prompt-registry.js";

const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export async function handleUIConfigCustom(request, env, scope) {
  const key = `${scope}ui-config.json`;
  const base = await loadUIConfig(env);
  const flat = flattenPrompts(base);

  if (request.method === "GET") {
    const { overrides, hidden } = await loadUserOverrides(env, scope);
    const hide = new Set(hidden);
    return J({
      schema: 2,
      items: flat.map((p) => ({
        id: p.id,
        label: p.label,
        default: p.instruction,
        override: overrides[p.id]?.instruction ?? null,
        customLabel: overrides[p.id]?.label ?? null,
        hidden: hide.has(p.id),
      })),
    });
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body.id !== "string") return J({ error: "expected {id, instruction?, label?, hidden?}" }, 400);
    if (!flat.some((p) => p.id === body.id)) return J({ error: "unknown id" }, 404);

    const { overrides, hidden } = await loadUserOverrides(env, scope);
    const entry = {};
    if (typeof body.instruction === "string" && body.instruction.trim()) entry.instruction = body.instruction;
    if (typeof body.label === "string" && body.label.trim()) entry.label = body.label.trim().slice(0, 20);
    if (Object.keys(entry).length) overrides[body.id] = entry;
    else delete overrides[body.id];

    const hide = new Set(hidden);
    if (body.hidden === true) hide.add(body.id); else hide.delete(body.id);
    const nextHidden = [...hide];

    if (Object.keys(overrides).length || nextHidden.length) {
      await env.FILES.put(key, JSON.stringify({ overrides, hidden: nextHidden }, null, 2));
    } else {
      await env.FILES.delete(key);
    }
    return J({
      ok: true, id: body.id,
      override: overrides[body.id]?.instruction ?? null,
      customLabel: overrides[body.id]?.label ?? null,
      hidden: hide.has(body.id),
    });
  }

  return J({ error: "method not allowed" }, 405);
}
