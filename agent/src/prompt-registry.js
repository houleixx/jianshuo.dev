// src/prompt-registry.js — 线上 prompt 注册表：把提示词模板（config/prompt-template.json）
// 与核心 global 提示词（config/prompts.json）暴露成可枚举、可回写的扁平列表，供
// prompt.jianshuo.dev 及 jianshuo.dev/a/ 的调优桥接页用。
//
// GET  /agent/prompt-registry           → { prompts: [{id, label, instruction}] }
//      列表 = loadPromptTemplate(env)（R2 覆盖优先，即「线上实际生效」的模板）打平出的
//      全部 action 叶子，加上核心 global 提示词。
// PUT  /agent/prompt-registry           → body {id, instruction}
//      id 命中模板叶子：把该叶子的 prompt 换掉后整棵模板写回 R2 config/prompt-template.json，
//      沿用零部署覆盖机制，写完即上线（还没 fork 过这条的用户立刻吃到）。
//      id 命中核心 global 提示词：走 config/prompts.json 的覆盖层（逻辑不变）。
//
// 两个方法都只认管理 token（Bearer FILES_TOKEN）。桥接页与 /agent 同源不需要
// CORS；prompt.jianshuo.dev 是独立源，故放行该 Origin 以便优化器直连。
import { bearerToken } from "../../functions/lib/auth.js";
import { loadPromptTemplate } from "./prompt-template.js";
import { loadPrompts, validateOverride } from "./prompts/loader.js";
import { PROMPT_META } from "./prompts/catalog.js";

const ALLOWED_ORIGIN = "https://prompt.jianshuo.dev";

// 打平成 [{id, label, instruction}] —— 只收 action（group 没有 instruction 不收）。
// label 带父组前缀（`图片风格 · 卡通`），和老的层级 label 一致：调优页靠它认人。
export function flattenTemplate(tpl) {
  const out = [];
  for (const item of tpl.items || []) {
    if (item.type === "action") {
      out.push({ id: item.id, label: item.label, instruction: item.prompt });
    }
    for (const c of item.children || []) {
      if (c.type === "action") {
        out.push({ id: c.id, label: `${item.label} · ${c.label}`, instruction: c.prompt });
      }
    }
  }
  return out;
}

// 返回替换了目标 action 的 prompt 的深拷贝；id 找不到 / 是 group → null。
export function updateTemplatePrompt(tpl, id, instruction) {
  const next = JSON.parse(JSON.stringify(tpl));
  for (const item of next.items || []) {
    if (item.id === id) return item.type === "action" ? ((item.prompt = instruction), next) : null;
    for (const c of item.children || []) {
      if (c.id === id) return c.type === "action" ? ((c.prompt = instruction), next) : null;
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
    const tpl = await loadPromptTemplate(env);
    const core = await loadPrompts(env);
    const corePrompts = Object.entries(PROMPT_META)
      .filter(([, m]) => m.tier === "global")
      .map(([id, m]) => ({ id, label: m.label, instruction: core[id] }));
    return new Response(JSON.stringify({ prompts: [...flattenTemplate(tpl), ...corePrompts] }), { headers });
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body.id !== "string" || typeof body.instruction !== "string" || !body.instruction.trim()) {
      return new Response(JSON.stringify({ error: "expected {id, instruction}" }), { status: 400, headers });
    }

    if (PROMPT_META[body.id]) {
      const err = validateOverride(body.id, body.instruction);
      if (err) return new Response(JSON.stringify({ error: err }), { status: 400, headers });
      let doc = {};
      const cur = await env.FILES.get("config/prompts.json");
      if (cur) { try { doc = JSON.parse(await cur.text()); } catch { doc = {}; } }
      if (!doc.prompts || typeof doc.prompts !== "object") doc.prompts = {};
      doc.prompts[body.id] = body.instruction;
      await env.FILES.put("config/prompts.json", JSON.stringify(doc, null, 2));
      return new Response(JSON.stringify({ ok: true, id: body.id }), { headers });
    }

    const tpl = await loadPromptTemplate(env);
    const next = updateTemplatePrompt(tpl, body.id, body.instruction);
    if (!next) return new Response(JSON.stringify({ error: "unknown prompt id" }), { status: 404, headers });
    await env.FILES.put("config/prompt-template.json", JSON.stringify(next, null, 2));
    return new Response(JSON.stringify({ ok: true, id: body.id }), { headers });
  }

  return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers });
}
