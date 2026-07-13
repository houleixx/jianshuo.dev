// src/prompt-store.js — 用户提示词列表的存储层（叶子模块，无业务逻辑）。
// spec: voicedrop repo docs/superpowers/specs/2026-07-13-prompt-manager-redesign.md
//
// 独立成叶子模块（没有放进 prompt-routes.js）是为了避免 ESM 循环依赖：后续任务里
// prompt-share.js 需要 loadUserPrompts，而 prompt-routes.js 需要 prompt-share.js
// 的 resolvePromptShare——两边都放 prompt-routes.js 会成环。这里只放存储读写，
// 不 import prompts.js / prompt-template.js，保持叶子。
//
// 存储：users/<sub>/prompts.json = { schema:1, items:[…] }（ref 或实体，两级封顶）。
// 【没有这个文件 = 全跟随模板】——调用方（prompt-routes.js 的 GET）绝不能因为
// 读到 null 就替用户落盘，否则就把这个用户冻结在当前模板版本上了。

const docKey = (scope) => `${scope}prompts.json`;

/// 读用户列表；没有文件 / 文件损坏（JSON 解析失败或形状不对）→ null（= 全跟随模板）。
/// 绝不 throw：一份坏掉的 prompts.json 不能把上层路由的 200 变成 500。
export async function loadUserPrompts(env, scope) {
  try {
    const obj = await env.FILES.get(docKey(scope));
    if (!obj) return null;
    const doc = JSON.parse(await obj.text());
    if (doc && Array.isArray(doc.items)) return doc;
  } catch (e) {
    console.error("[prompt-store] bad prompts.json:", e && e.message);
  }
  return null;
}

/// 整树写回。调用方（PUT / restore-defaults）负责先过 validateList——这里不重复校验。
export async function saveUserPrompts(env, scope, items) {
  await env.FILES.put(docKey(scope), JSON.stringify({ schema: 1, items }, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });
}
