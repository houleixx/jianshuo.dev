// src/xhs.js — 「分享到小红书」内容包：把一篇文章转成小红书笔记（文案 + 图片 key 列表）。
// 发布动作不在这里：App 拿到包后写剪贴板 + 弹 ShareSheet，用户在小红书里粘贴发布。
import { callAnthropic } from "./anthropic.js";
import { writeLlmLog } from "./llmlog.js";
import { claudeCostUY } from "./usage.js";
import { ensureAccount, debit } from "./usage_store.js";
import { resolveArticles } from "../../functions/lib/article-store.js";
import { readStyleText } from "../../functions/lib/style-store.js";

const MODEL = "claude-sonnet-4-6";

export const XHS_SYSTEM = `你是这篇文章作者本人的小红书编辑。把给你的文章改写成一篇小红书笔记。

硬规则：
- 标题 ≤ 20 个字：有钩子但不标题党，不用「震惊/必看/干货」这类词，不堆感叹号。
- 正文 ≤ 1000 字：口语、分段短（每段 1–3 句），保持作者原有的平实语气，不客套、不营销腔；可以在个别段首用一个贴合内容的 emoji 点缀，不许堆砌。
- 正文里不写话题标签；标签单独给 3–5 个（不带 # 号），要具体、能被搜到，不要「生活/分享」这种空词。
- 原文里形如 [[photo:…]] 的照片标记全部删掉，文案里不出现。
- 保留原文最核心的观点和具体细节（真数字、真场景），宁短勿水。

只输出一个 JSON 对象：{"title": "…", "body": "…", "tags": ["…", "…"]}，不要输出任何其它文字。`;

export function extractPhotoKeys(body) {
  const keys = [];
  const re = /\[\[photo:([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(body || ""))) keys.push(m[1]);
  return keys;
}

function parsePackJson(text) {
  const raw = String(text || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j; try { j = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  const title = String(j.title || "").trim();
  const body = String(j.body || "").trim();
  if (!title || !body) return null;
  const tags = Array.isArray(j.tags) ? j.tags.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, 5) : [];
  return { title, body, tags };
}

// 生成一篇文章的小红书内容包。返回 {ok, title, body, tags, photoKeys} 或 {error}。
// 计费：按 token 实价扣算力（best-effort，同 style-extract 口径，失败不阻断响应）。
export async function xhsPack(env, scope, stem) {
  const obj = await env.FILES.get(`${scope}articles/${stem}.json`);
  if (!obj) return { error: "not_found" };
  let doc; try { doc = JSON.parse(await obj.text()); } catch { return { error: "bad_article" }; }
  const art = resolveArticles(doc)[0];
  if (!art || !(art.body || "").trim()) return { error: "empty_article" };

  const style = (await readStyleText(env, `${scope}CLAUDE.json`, `${scope}CLAUDE.md`).catch(() => "")) || "";
  const user = `${style ? `<style>\n${style}\n</style>\n\n` : ""}文章标题：${art.title || "(无题)"}\n\n文章正文：\n${art.body}`;

  const reqBody = { model: MODEL, max_tokens: 1600, system: XHS_SYSTEM, messages: [{ role: "user", content: user }] };
  const t0 = Date.now();
  const r = await callAnthropic(env, reqBody);
  await writeLlmLog(env, {
    ts: t0, source: "agent", user_scope: scope, model: MODEL,
    latency_ms: Date.now() - t0, http_status: r.status, ok: r.ok,
    via: r.via, ...(r.colo ? { colo: r.colo } : {}),
    step: 0, request: reqBody, response: r.ok ? r.json : undefined,
    error: r.ok ? undefined : r.errorText,
    meta: { kind: "xhs-pack", stem },
  });
  if (!r.ok) return { error: "llm_failed", detail: `HTTP ${r.status}` };

  const text = (r.json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const pack = parsePackJson(text);
  if (!pack) return { error: "bad_llm_output" };

  try {
    if (env.USAGE) {
      const u = r.json.usage || {};
      await ensureAccount(env.USAGE, scope, Date.now());
      const cost = claudeCostUY(MODEL, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens);
      await debit(env.USAGE, scope, cost, "xhs-pack", { stem }, Date.now());
    }
  } catch (_) {}

  return { ok: true, ...pack, photoKeys: extractPhotoKeys(art.body) };
}
