// 图片生文（image-only）多遍流水线：观察 → 立意 → 写作 → 审稿。
// 分层：素材层（FactPack）→ 纯编排层（runImagePipeline，callModel 注入，
// vitest/eval 直接驱动）→ 生产包装层（mineImageOnly：fetch + llmlog + 算力 debit）。
// 任一阶段失败向上抛 —— miner.js 捕获后回退现行 IMAGE_ONLY_SYSTEM 单发（质量下限=旧行为）。
// 设计 spec：docs/superpowers/specs/2026-07-03-image-only-mine-pipeline-design.md

import { resolveArticles } from "../../functions/lib/article-store.js";
import { buildStagePayload, parseStageJson, QUALITY_GATE, MAX_RECENT_TITLES } from "./prompts/image-pipeline.js";

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
  .map((a) => ({ title: (a.title || "(无题)").trim(), body: (a.body || "").trim() }));

// 写作 + 审稿一轮（plan 固定）。restyle 复用观察结果时也走这里——换文风不换立意。
export async function rewriteFromVision({ photos, factPack, vision, plan, styleText, provider = "anthropic", model, callModel }) {
  const run = async (stage, extra) =>
    parseStageJson(await callModel({ stage, payload: buildStagePayload({ stage, provider, model, ...extra }) }));
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
export async function runImagePipeline({ photos, factPack, styleText, provider = "anthropic", model, callModel, log = () => {} }) {
  const run = async (stage, extra) =>
    parseStageJson(await callModel({ stage, payload: buildStagePayload({ stage, provider, model, ...extra }) }));

  const vision = await run("observe", { photos, factPack });
  log("观察完成", { images: (vision.images || []).length });

  const oneRound = async (previousIssues) => {
    const plan = await run("plan", { factPack, observation: vision, previousIssues });
    log("立意完成", { selected: plan.selected });
    const r = await rewriteFromVision({ photos, factPack, vision, plan, styleText, provider, model, callModel });
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
