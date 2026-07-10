// 图片生文（image-only）多遍流水线：观察 → 立意 → 写作 → 审稿。
// 分层：素材层（FactPack）→ 纯编排层（runImagePipeline，callModel 注入，
// vitest/eval 直接驱动）→ 生产包装层（mineImageOnly：fetch + llmlog + 算力 debit）。
// 任一阶段失败向上抛 —— miner.js 捕获后回退现行 IMAGE_ONLY_SYSTEM 单发（质量下限=旧行为）。
// 设计 spec：docs/superpowers/specs/2026-07-03-image-only-mine-pipeline-design.md

import { TITLE_FALLBACK, resolveArticles } from "../../functions/lib/article-store.js";
import { buildStagePayload, parseStageJson, QUALITY_GATE, MAX_RECENT_TITLES } from "./prompts/image-pipeline.js";
import { loadPrompts } from "./prompts/loader.js";
import { writeLlmLog } from "./llmlog.js";
import { callAnthropic } from "./anthropic.js";
import { claudeCostUY } from "./usage.js";
import { debit } from "./usage_store.js";

// ── 素材层（Stage 0 的免费事实）─────────────────────────────────────────────────
// 录音名约定（iOS RecordingName.make，单一真源在 App 侧 RecordingName.swift）：
//   VoiceDrop-yyyy-MM-dd-HHmmss-<dur>-<weekday>-<period>[-City[-District]]
// 地点只含 ASCII 字母（LocationTagger.asciiLetters）且总在末尾；Task* 任务尾标不是地点。

export function parsePlaceTag(stem) {
  const p = String(stem).split("-");
  if (p.length < 9 || p[0] !== "VoiceDrop") return null;
  const place = p.slice(8).filter((t) => /^[A-Za-z]+$/.test(t) && !/^Task[A-Z]/.test(t));
  return place.length ? place.join("-") : null;
}

export function parseSessionInfo(stem) {
  const p = String(stem).split("-");
  if (p.length < 5 || p[0] !== "VoiceDrop" || p[1].length !== 4) return null;
  const t6 = p[4] || "";
  return {
    date: `${p[1]}-${p[2]}-${p[3]}`,
    time: t6.length === 6 ? `${t6.slice(0, 2)}:${t6.slice(2, 4)}:${t6.slice(4)}` : t6,
    weekday: p[6] || null,
    period: p[7] || null,
  };
}

// 最近 N 篇历史文章标题：R2 直读 `${scope}articles/*.json`（key 含时间戳，字典序即时间序）。
// 只是立意的参考素材 —— 任何失败都静默降级为空列表，绝不挡住成文。
export async function fetchRecentTitles(env, scope, { excludeStem = "", max = MAX_RECENT_TITLES } = {}) {
  try {
    const listed = await env.FILES.list({ prefix: `${scope}articles/`, limit: 1000 });
    const keys = (listed.objects || []).map((o) => o.key)
      .filter((k) => k.endsWith(".json") && !k.endsWith(".asr.json") && !k.endsWith(`/${excludeStem}.json`))
      .sort().slice(-max);
    const docs = await Promise.all(keys.map(async (k) => {
      try { const obj = await env.FILES.get(k); return obj ? JSON.parse(await obj.text()) : null; }
      catch (_) { return null; }
    }));
    const titles = [];
    for (const d of docs) {
      if (!d) continue;
      try { for (const a of resolveArticles(d)) if (a && a.title) titles.push(a.title); } catch (_) {}
    }
    return titles.slice(-max);
  } catch (_) { return []; }
}

export async function buildFactPack(env, { scope, stem, photos }) {
  return {
    place: parsePlaceTag(stem),
    session: parseSessionInfo(stem),
    photos: photos.map((p) => ({ key: p.relKey, time: p.label })),
    recentTitles: await fetchRecentTitles(env, scope, { excludeStem: stem }),
  };
}

// ── 纯编排层（callModel 注入，无 env 依赖；vitest 与 eval 直接驱动）────────────────
// callModel 契约：async ({ stage, payload }) => 模型原始文本。

const normalizeArticles = (arts) => (arts || [])
  .filter((a) => a && typeof a === "object" && (a.body || "").trim())
  .map((a) => ({ title: (a.title || TITLE_FALLBACK).trim(), body: (a.body || "").trim() }));

// 写作 + 审稿一轮（plan 固定）。restyle 复用观察结果时也走这里——换文风不换立意。
export async function rewriteFromVision({ photos, factPack, vision, plan, styleText, provider = "anthropic", model, callModel, stageSystem }) {
  const run = async (stage, extra) =>
    parseStageJson(await callModel({ stage, payload: buildStagePayload({ stage, provider, model, stageSystem, ...extra }) }));
  const draft = await run("write", { factPack, observation: vision, storyPlan: plan, styleText });
  const draftArts = normalizeArticles(draft.articles);
  if (!draftArts.length) throw new Error("write-stage-empty");
  const review = await run("review", { photos, factPack, observation: vision, storyPlan: plan, draftArticles: draftArts });
  const arts = normalizeArticles(review.articles);
  return {
    articles: arts.length ? arts : draftArts,
    quality: review.quality || {},
    issues: Array.isArray(review.issues) ? review.issues : [],
  };
}

// 全流水线：观察 → (立意 → 写作 → 审稿)，质量门不过带 issues 从立意重跑一次，取分高一版。
export async function runImagePipeline({ photos, factPack, styleText, provider = "anthropic", model, callModel, log = () => {}, stageSystem }) {
  const run = async (stage, extra) =>
    parseStageJson(await callModel({ stage, payload: buildStagePayload({ stage, provider, model, stageSystem, ...extra }) }));

  const vision = await run("observe", { photos, factPack });
  log("观察完成", { images: (vision.images || []).length });

  const oneRound = async (previousIssues) => {
    const plan = await run("plan", { factPack, observation: vision, previousIssues });
    log("立意完成", { selected: plan.selected });
    const r = await rewriteFromVision({ photos, factPack, vision, plan, styleText, provider, model, callModel, stageSystem });
    return { plan, ...r };
  };

  const r1 = await oneRound(null);
  let final = r1;
  if (!((r1.quality.overall || 0) >= QUALITY_GATE)) {
    log("质量门未过,重跑一次", { overall: r1.quality.overall, issues: (r1.issues || []).slice(0, 5) });
    const r2 = await oneRound(r1.issues && r1.issues.length ? r1.issues : ["整体质量不达标"]);
    final = (r2.quality.overall || 0) >= (r1.quality.overall || 0) ? r2 : r1;
  }
  const lowQuality = !((final.quality.overall || 0) >= QUALITY_GATE);
  return { articles: final.articles, vision, plan: final.plan, quality: final.quality, lowQuality };
}

// ── 生产包装层：fetch + llmlog + 算力 debit ─────────────────────────────────────

// 日志用请求副本：图片 base64 可达 MB 级，换成占位符（同 miner.redactReqForLog 的逻辑，
// 但那边未导出且互相 import 会成环，这里保留一份轻量实现）。
function redactPayloadForLog(payload) {
  const tag = (s) => `[base64 image · ~${Math.round((String(s).length * 3) / 4 / 1024)}KB elided]`;
  const req = { ...payload };
  if (Array.isArray(req.messages)) {
    req.messages = req.messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      return { ...m, content: m.content.map((b) => {
        if (b && b.type === "image" && b.source && b.source.data) return { ...b, source: { ...b.source, data: tag(b.source.data) } };
        if (b && b.type === "image_url" && b.image_url && b.image_url.url) return { ...b, image_url: { ...b.image_url, url: tag(b.image_url.url) } };
        return b;
      }) };
    });
  }
  return req;
}

// 生产 callModel：provider 分发 + llmlog + 算力 debit，每阶段一次调用一条日志一笔账。
// Anthropic 走 callAnthropic（geo-403 时自动经美东中继 DO 重放，见 anthropic.js）。
export function makeStageCaller(env, { modelCfg, scope, stem, turnId, log = () => {} }) {
  return async ({ stage, payload }) => {
    const meta = { user_scope: scope, stem, stage, source: "image-pipeline" };
    const t0 = Date.now();
    let via;
    try {
      let text, rawResp, colo;
      if (modelCfg.provider === "openai-compat") {
        const resp = await fetch(`${modelCfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${modelCfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        rawResp = await resp.json();
        text = rawResp.choices?.[0]?.message?.content || "";
      } else {
        const r = await callAnthropic(env, payload, { apiKey: modelCfg.apiKey });
        via = r.via; colo = r.colo;
        if (!r.ok) throw new Error(`Claude ${r.status}: ${(r.errorText || "").slice(0, 200)}`);
        rawResp = r.json;
        text = (rawResp.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      }
      const latency = Date.now() - t0;
      await writeLlmLog(env, { ts: t0, source: "mine", ok: true, status: 200, model: modelCfg.model, latency_ms: latency, step: stage, turn_id: turnId, via, ...(colo ? { colo } : {}), meta, request: redactPayloadForLog(payload), response: rawResp });
      try {
        if (env.USAGE) {
          const u = rawResp?.usage || {};
          await debit(env.USAGE, scope, claudeCostUY(modelCfg.model, u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens),
            "mine", { model: modelCfg.model, stage, in_tok: u.input_tokens, out_tok: u.output_tokens, cache_w: u.cache_creation_input_tokens, cache_r: u.cache_read_input_tokens, stem, turn_id: turnId }, Date.now());
        }
      } catch (_) {}
      log(`阶段完成:${stage}`, { latency_ms: latency });
      return text;
    } catch (e) {
      await writeLlmLog(env, { ts: t0, source: "mine", ok: false, status: 0, model: modelCfg.model, latency_ms: Date.now() - t0, step: stage, turn_id: turnId, via, meta, error: String(e) });
      throw e;
    }
  };
}

// 生产入口：素材 → 流水线。任何异常向上抛，miner.js 捕获后回退现行单发。
export async function mineImageOnly(env, { scope, stem, photos, styleText, modelCfg, turnId, log = () => {} }) {
  const factPack = await buildFactPack(env, { scope, stem, photos });
  log("流水线开始", { photos: photos.length, place: factPack.place, titles: factPack.recentTitles.length });
  const callModel = makeStageCaller(env, { modelCfg, scope, stem, turnId, log });
  // 每次运行解析一次 prompt 覆盖，四个阶段共用同一份 map（不逐阶段重复解析 R2）。
  const _P = await loadPrompts(env);
  const stageSystem = { observe: _P["image.observe"], plan: _P["image.plan"], write: _P["image.write"], review: _P["image.review"] };
  return await runImagePipeline({ photos, factPack, styleText, provider: modelCfg.provider, model: modelCfg.model, callModel, log, stageSystem });
}
