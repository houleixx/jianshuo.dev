// src/prompt-routes.js — /agent/prompts* 的 HTTP 外壳（纯逻辑在 prompts.js，存储在 prompt-store.js）。
// spec: voicedrop repo docs/superpowers/specs/2026-07-13-prompt-manager-redesign.md
//
// 存储：users/<sub>/prompts.json = { schema:1, items:[…] }（ref 或实体，两级封顶）。
// 【没有这个文件 = 全跟随模板】——GET 绝不为新用户落盘，否则就把他冻结了。
//
// 写操作只有【整树 PUT】：新建/删除/改名/改词/排序/分组/fork 全走它。客户端本来就
// 整棵树拿在手里，所以不存在局部更新竞态。
import { loadPromptTemplate } from "./prompt-template.js";
import { resolveList, validateList, restoreDefaults } from "./prompts.js";
import { loadUserPrompts, saveUserPrompts } from "./prompt-store.js";

const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

const resolved = (tpl, items) => J({ schema: 1, items: resolveList(tpl, { schema: 1, items }) });

export async function handlePromptsRoute(request, env, scope, url) {
  const tpl = await loadPromptTemplate(env);

  // POST /agent/prompts/restore-defaults —— 补回模板里缺的（后悔药 + 拿新 prompt）
  if (url.pathname === "/agent/prompts/restore-defaults") {
    if (request.method !== "POST") return J({ error: "method not allowed" }, 405);
    const doc = await loadUserPrompts(env, scope);
    // 还没有自己的文件 = 本来就全跟随模板，恢复默认是 no-op，也不落盘。
    if (!doc) return J({ schema: 1, items: resolveList(tpl, null) });
    const next = restoreDefaults(tpl, doc.items);
    // 防御性纵深：restoreDefaults 的输出理论上总能过 validateList，但这个端点会落盘——
    // 绝不允许一份没过校验的文档被写进 R2。校验失败就当没发生过（不落盘），报 500
    // 好过悄悄写坏数据；这条分支不该被真实触发，触发了就是 restoreDefaults 自己的 bug。
    const err = validateList(tpl, next);
    if (err) {
      console.error("[prompts] restoreDefaults produced invalid list:", err);
      return J({ error: "internal error: restore-defaults produced an invalid list" }, 500);
    }
    await saveUserPrompts(env, scope, next);
    return resolved(tpl, next);
  }

  if (request.method === "GET") {
    const doc = await loadUserPrompts(env, scope);
    return J({ schema: 1, items: resolveList(tpl, doc) });   // doc=null → 模板全量，【不落盘】
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.items)) {
      return J({ error: "expected {items: [...]}" }, 400);
    }
    const err = validateList(tpl, body.items);
    if (err) return J({ error: err }, 400);
    await saveUserPrompts(env, scope, body.items);
    return resolved(tpl, body.items);
  }

  return J({ error: "method not allowed" }, 405);
}
