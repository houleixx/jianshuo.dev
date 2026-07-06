// src/ui-config-custom.js — 每用户的 ui-config 指令自定义（iOS 设置页的后端）。
//
// GET  /agent/ui-config/custom → { schema, items: [{id, label, default, override}] }
//      default = 全局生效版（内置 ← 全局 R2 覆盖）里该叶子的指令；override = 该用户
//      的自定义（null = 未自定义，菜单用 default）。
// PUT  /agent/ui-config/custom → body {id, instruction}
//      instruction 非空 → 写入该用户的稀疏覆盖；空串/null → 删掉该条 = 恢复缺省。
//      存储：users/<sub>/ui-config.json = { overrides: { "<叶子路径id>": "…" } }。
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
    const overrides = await loadUserOverrides(env, scope);
    return J({
      schema: 1,
      items: flat.map((p) => ({ id: p.id, label: p.label, default: p.instruction, override: overrides[p.id] ?? null })),
    });
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body.id !== "string") return J({ error: "expected {id, instruction}" }, 400);
    if (!flat.some((p) => p.id === body.id)) return J({ error: "unknown id" }, 404);

    const overrides = await loadUserOverrides(env, scope);
    const ins = typeof body.instruction === "string" ? body.instruction : "";
    if (ins.trim()) overrides[body.id] = ins;
    else delete overrides[body.id];

    if (Object.keys(overrides).length) await env.FILES.put(key, JSON.stringify({ overrides }, null, 2));
    else await env.FILES.delete(key);
    return J({ ok: true, id: body.id, override: overrides[body.id] ?? null });
  }

  return J({ error: "method not allowed" }, 405);
}
