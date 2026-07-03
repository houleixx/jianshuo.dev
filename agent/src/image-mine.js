// 图片生文（image-only）多遍流水线：观察 → 立意 → 写作 → 审稿。
// 分层：素材层（FactPack）→ 纯编排层（runImagePipeline，callModel 注入，
// vitest/eval 直接驱动）→ 生产包装层（mineImageOnly：fetch + llmlog + 算力 debit）。
// 任一阶段失败向上抛 —— miner.js 捕获后回退现行 IMAGE_ONLY_SYSTEM 单发（质量下限=旧行为）。
// 设计 spec：docs/superpowers/specs/2026-07-03-image-only-mine-pipeline-design.md

import { resolveArticles } from "../../functions/lib/article-store.js";
import { MAX_RECENT_TITLES } from "./prompts/image-pipeline.js";

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
