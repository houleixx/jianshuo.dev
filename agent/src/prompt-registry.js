// src/prompt-registry.js — 线上 prompt 注册表：把 ui-config 里的叶子指令暴露成
// 可枚举、可回写的扁平列表，供 prompt.jianshuo.dev 及 jianshuo.dev/a/ 的调优桥接页用。
//
// GET  /agent/prompt-registry           → { prompts: [{id, label, instruction}] }
//      列表来自 loadUIConfig(env)（R2 覆盖优先），即「线上实际生效」的版本。
// PUT  /agent/prompt-registry           → body {id, instruction}
//      把生效配置中该叶子的 instruction 换掉后整体写回 R2 config/ui-config.json，
//      沿用 ui-config 的零部署覆盖机制，写完即上线。
//
// 两个方法都只认管理 token（Bearer FILES_TOKEN）。桥接页与 /agent 同源不需要
// CORS；prompt.jianshuo.dev 是独立源，故放行该 Origin 以便优化器直连。
import { bearerToken } from "../../functions/lib/auth.js";
import { loadUIConfig } from "./ui-config.js";

const ALLOWED_ORIGIN = "https://prompt.jianshuo.dev";

// 打平成 [{id, label, instruction}]。id 是层级路径（页.交互.节点[.父菜单].叶子），
// 与 ui-config 的形状一一对应，updatePrompt 按同一路径规则写回。
export function flattenPrompts(cfg) {
  const out = [];
  for (const [page, interactions] of Object.entries(cfg.pages || {})) {
    for (const [interaction, nodes] of Object.entries(interactions || {})) {
      for (const [node, spec] of Object.entries(nodes || {})) {
        const walk = (item, idPrefix, labelPrefix) => {
          const id = `${idPrefix}.${item.id}`;
          const label = labelPrefix ? `${labelPrefix} · ${item.label}` : item.label;
          if (typeof item.instruction === "string") out.push({ id, label, instruction: item.instruction });
          for (const child of item.children || []) walk(child, id, label);
        };
        for (const item of (spec.groups || []).flat()) walk(item, `${page}.${interaction}.${node}`, "");
      }
    }
  }
  return out;
}

// 返回替换了目标叶子 instruction 的深拷贝配置；id 找不到返回 null。
export function updatePrompt(cfg, id, instruction) {
  const next = JSON.parse(JSON.stringify(cfg));
  for (const [page, interactions] of Object.entries(next.pages || {})) {
    for (const [interaction, nodes] of Object.entries(interactions || {})) {
      for (const [node, spec] of Object.entries(nodes || {})) {
        const walk = (item, idPrefix) => {
          const itemId = `${idPrefix}.${item.id}`;
          if (itemId === id && typeof item.instruction === "string") { item.instruction = instruction; return true; }
          return (item.children || []).some((c) => walk(c, itemId));
        };
        if ((spec.groups || []).flat().some((item) => walk(item, `${page}.${interaction}.${node}`))) return next;
      }
    }
  }
  return null;
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const h = { "content-type": "application/json" };
  if (origin === ALLOWED_ORIGIN) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, PUT, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
  }
  return h;
}

export async function handlePromptRegistry(request, env) {
  const headers = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

  const tok = bearerToken(request);
  if (!env.FILES_TOKEN || tok !== env.FILES_TOKEN) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
  }

  if (request.method === "GET") {
    const cfg = await loadUIConfig(env);
    return new Response(JSON.stringify({ prompts: flattenPrompts(cfg) }), { headers });
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body.id !== "string" || typeof body.instruction !== "string" || !body.instruction.trim()) {
      return new Response(JSON.stringify({ error: "expected {id, instruction}" }), { status: 400, headers });
    }
    const cfg = await loadUIConfig(env);
    const next = updatePrompt(cfg, body.id, body.instruction);
    if (!next) return new Response(JSON.stringify({ error: "unknown prompt id" }), { status: 404, headers });
    await env.FILES.put("config/ui-config.json", JSON.stringify(next, null, 2));
    return new Response(JSON.stringify({ ok: true, id: body.id }), { headers });
  }

  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers });
}
