// Versioned read/write for the user's writing style — users/<sub>/CLAUDE.json.
// Mirrors functions/lib/article-store.js (same schema-3 versioned envelope) so the
// 文风 doc gets the same history/undo as articles. Shared by the Files API
// (functions/files/api/[[path]].js), the agent worker (agent/src/*), and tests.
//
// Schema 3: { schema:3, head, versions:[{v, savedAt, source, style}], createdAt, updatedAt, profile? }
//   head    = v-number of the currently active version (git HEAD analogy)
//   versions are oldest-first, contiguous v numbers; the array may start at v>1
//             once the MAX_VERSIONS oldest entries are pruned.
//   style   = the 文风 text — the ONLY versioned field (you iterate/undo it).
//   profile = { name, … } — non-versioned identity fields. Editing the name does
//             NOT mint a style version; it lives outside `versions` on purpose.
//             Future stable/identity fields (bio, facts, glossary…) go here too;
//             only fields you actually tune-and-undo belong in `versions`.
//
// Backward compat: the canonical store is CLAUDE.json. The old CLAUDE.md (which
// held「# 我的名字…# 我的文风…」) is still READ as a fallback by readStyleText —
// its 文风 section is parsed out. Writers only ever write CLAUDE.json, so an old
// CLAUDE.md is retired the first time a user saves.

export const STYLE_MAX_VERSIONS = 10;

// 存储键 —— 本模块的私有约定，调用方一律只传 scope（"users/<sub>/"），
// 永远不自己拼 CLAUDE.json / CLAUDE.md（readProfileName 同款封装原则）。
const styleKeyFor  = (scope) => scope + "CLAUDE.json";
const legacyKeyFor = (scope) => scope + "CLAUDE.md";

// The default 王建硕 writing style — canonical single source. Seeded as v1 of the
// 3-preset chain by ensureStyleSeeded() on first use, and re-exported by
// agent/src/prompts/mine.js as MINE_DEFAULT_STYLE (the generation-time fallback),
// so the seed text and the fallback text can never drift.
export const DEFAULT_STYLE = `胸有成竹地下断言，不绕弯、不加「我觉得可能也许」的缓冲。
不讲故事、不铺垫，直接给结论再给理由；开头一句就立住，绝不用小白式提问钩子。
第一人称用「我」，绝不用「笔者」。称呼 AI / Claude 一律用「他」，不用「它」。
多用「我 / 他」起句，少用「这里会有…」这类无人称、物称句。
细节能列就用表格 / 列表，不在叙述句里堆细节。
保留口语词（吧 / 呢 / 啊 / 了）、自造词、家常比喻——这是你的声音，别改成书面语。
不加 AI 味连接词（首先 / 其次 / 综上所述 / 值得注意的是），不加 emoji。`;

// 小红书笔记体预设（seedPresetDoc 的 v2）。
export const XHS_STYLE = `小红书笔记体：短句、口语、有网感，一段最多两三行，读着像跟朋友唠。
开头第一句就抛钩子——痛点、反差或一个具体数字，别铺垫。
每张卡 / 每段只讲一个点，多用「你」，像当面说话。
适度用 emoji 点睛（一段零到两个，别每行都堆），亲切但不发嗲、不喊「宝子家人们」。
能列点就分行列，别写成大段。
结尾带三到五个话题标签（#xxx），挑跟内容真相关的。
不写「首先/其次/综上」，不写书面腔。`;

// 微信公众号文章体预设（seedPresetDoc 的 v3）。
export const WECHAT_STYLE = `微信公众号文章体：比口语更完整、比论文更亲切，面向广泛读者，不特指某一个人的嗓音。
开头直接进入话题、给出这篇要解决的问题，第一段就立住价值，不用小白式提问钩子。
用清晰的小标题分段，每段有节奏，长短句交替，读着不累。
观点先行、例证跟上；细节能列表就列表，不在叙述句里堆。
结尾留一句有回味的话或一个可带走的要点，不强行升华、不喊口号。
不堆 AI 味连接词（首先/其次/综上所述/值得注意的是），emoji 克制或不用。`;

// 三预设有序表（新用户种子来源）。王建硕复用 DEFAULT_STYLE 单一真源。
export const PRESET_STYLES = [
  { name: "王建硕", style: DEFAULT_STYLE },
  { name: "小红书", style: XHS_STYLE },
  { name: "公众号", style: WECHAT_STYLE },
];

// 构造未编辑的三预设种子信封（纯函数，便于单测，不碰 IO）。head=1（开局王建硕）。
export function seedPresetDoc(now) {
  return {
    schema: 3,
    head: 1,
    versions: PRESET_STYLES.map((p, i) => ({ v: i + 1, savedAt: now, source: "preset", style: p.style })),
    createdAt: now,
    updatedAt: now,
  };
}

// Lazy-seed the default 王建硕 style as the user's own v1 the first time anyone
// touches their style (settings read or first mine). Idempotent: returns the
// existing doc untouched if a CLAUDE.json is already there. Returns null WITHOUT
// seeding when a legacy CLAUDE.md already holds 文风 (don't clobber an old user —
// callers fall back to their existing legacy-read path). Otherwise writes v1
// (source "default") and returns the new doc.
export async function ensureStyleSeeded(env, scope) {
  const doc = await readStyleDoc(env, scope);
  if (doc) return doc;
  const legacy = await readLegacyStyleMd(env, scope);
  if (legacy && parseStyleMarkdown(legacy).trim()) return null;
  const seeded = seedPresetDoc(Date.now());
  await env.FILES.put(styleKeyFor(scope), JSON.stringify(seeded), { httpMetadata: { contentType: "application/json" } });
  return seeded;
}

// True iff the doc is still the un-edited 3-preset seed: head=1 and exactly the three
// preset versions (v1/v2/v3, source "preset"). Any edit (a v4, a non-preset source, or
// a moved head) makes it false. SINGLE SOURCE for the GET /style `default` flag.
export function isDefaultSeed(doc) {
  if (!doc || doc.head !== 1 || !Array.isArray(doc.versions)) return false;
  if (doc.versions.length !== PRESET_STYLES.length) return false;
  return doc.versions.every((e, i) => e.v === i + 1 && e.source === "preset");
}

// ── 文风版本标签 ────────────────────────────────────────────────────────────────
// The 文风 version now lives as a per-article FIELD (`articles[i].style = N`), not a
// body comment — a hidden `<!--…-->` line desynced the 第N行 numbering between the
// app (strips comments before numbering) and the agent (didn't). Bodies must contain
// ONLY user-visible content. The old `<!-- style: 风格 vN -->` comments were migrated
// off by scripts/migrate-style-field (2026-07-03); readers keep a comment fallback
// for a transition window only.
export function styleLabel(v) { return `风格 v${v}`; }                          // "风格 v8"

// Read the versioned CLAUDE.json doc (schema-3). Returns null if absent/corrupt.
export async function readStyleDoc(env, scope) {
  const obj = await env.FILES.get(styleKeyFor(scope));
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}

// 原始 legacy CLAUDE.md 文本（null=没有）。给需要同时拿 文风+名字 的读者
// （如 Files API 的 legacy 显示分支）——键名仍不外泄。
export async function readLegacyStyleMd(env, scope) {
  const legacy = await env.FILES.get(legacyKeyFor(scope));
  return legacy ? await legacy.text() : null;
}

// The current 文风 text from a schema-3 doc, "" if none. SINGLE SOURCE OF TRUTH
// for "what is the active style" — every reader imports this, never re-inlines it.
export function resolveStyle(doc) {
  if (!doc) return "";
  if (Array.isArray(doc.versions) && doc.head) {
    const cv = doc.versions.find((e) => e.v === doc.head);
    if (cv && typeof cv.style === "string") return cv.style;
  }
  if (typeof doc.style === "string") return doc.style; // defensive (flat shape)
  return "";
}

// Extract the 文风 text from a legacy CLAUDE.md markdown blob: everything under
// 「# 我的文风」; if that header is absent, the whole trimmed text. Mirrors the
// iOS SettingsStore.parse fallback so legacy docs read back identically.
export function parseStyleMarkdown(md) {
  if (!md) return "";
  const i = md.indexOf("# 我的文风");
  if (i < 0) return md.trim();
  return md.slice(i + "# 我的文风".length).trim();
}

// Effective 文风 text for any reader: CLAUDE.json first, else the legacy
// CLAUDE.md's 文风 section. "" if neither exists.
export async function readStyleText(env, scope) {
  const doc = await readStyleDoc(env, scope);
  if (doc) return resolveStyle(doc);
  const legacy = await readLegacyStyleMd(env, scope);
  if (legacy) return parseStyleMarkdown(legacy);
  return "";
}

// Versioned write (mirrors writeArticleDoc). Bases the version chain on the
// existing CLAUDE.json only — a legacy CLAUDE.md is never folded into history, so
// the first JSON write starts a fresh v1. source: "app" | "agent" | "mine".
export async function writeStyleDoc(env, scope, style, source = "unknown") {
  const current = await readStyleDoc(env, scope);

  let versions, head, createdAt;
  if (current && Array.isArray(current.versions) && current.head) {
    // Truncate any "future" versions (after head, left from an undo), then append.
    const base = current.versions.filter((e) => e.v <= current.head);
    const newV = current.head + 1;
    versions = [...base, { v: newV, savedAt: Date.now(), source, style }].slice(-STYLE_MAX_VERSIONS);
    head = newV;
    createdAt = current.createdAt || Date.now();
  } else {
    versions = [{ v: 1, savedAt: Date.now(), source, style }];
    head = 1;
    createdAt = Date.now();
  }

  const doc = { schema: 3, head, versions, createdAt, updatedAt: Date.now() };
  // Carry forward non-versioned top-level fields (profile = name + future identity
  // fields). Writing a new STYLE version must never drop the profile.
  if (current && current.profile) doc.profile = current.profile;
  await env.FILES.put(styleKeyFor(scope), JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}

// ── Profile (non-versioned identity fields: name, + future) ──────────────────
// Lives at doc.profile, OUTSIDE the version history: changing the name should NOT
// mint a new style version. Only the 文风 (style) is versioned.

// The user's display name — SINGLE SOURCE OF TRUTH for "who is the author";
// the share endpoint, miner, and mint all import this. Takes the user scope
// ("users/<sub>/") only; storage keys (CLAUDE.json / legacy CLAUDE.md) and the
// no-name fallback are this module's private convention — callers never spell
// them out and never need a `|| "匿名"` of their own.
// 顺序：CLAUDE.json profile.name → legacy CLAUDE.md「# 我的名字」→ fallback 策略：
//   "id"（默认，miner/mint/社区帖用）：身份 ID 前 6 位大写（如 "AE209A"，来自
//     users/anon-<hash>/ 的 hash），穷举到空也兜底"匿名"——这里的 ID 短标签是
//     稳定身份约定，同一用户前后一致，适合账单/社区帖这类"总要有个代号"的场景。
//   "none"（魔法数字导入预览用）：无名 → 返回 ""，不编出一个看似真名的 ID 短标签。
//     该端点面向陌生人展示"来自 X"，一个没有信息量的机器代号（如"来自 ABC"）
//     反而比不显示更误导——调用方按 spec 用空串隐藏整行「来自」。
export async function readProfileName(env, scope, { fallback = "id" } = {}) {
  const doc = await readStyleDoc(env, scope);
  const n = doc && doc.profile && doc.profile.name;
  if (typeof n === "string" && n.trim()) return n.trim();
  const legacy = await readLegacyStyleMd(env, scope);
  if (legacy) {
    const m = legacy.match(/#\s*我的名字\s*\n+([^\n#]+)/);
    if (m && m[1].trim()) return m[1].trim();
  }
  if (fallback === "none") return "";
  const id = String(scope).replace(/^users\//, "").replace(/^anon-/, "").replace(/\/+$/, "");
  return id.slice(0, 6).toUpperCase() || "匿名";
}

// Shallow-merge `patch` into doc.profile WITHOUT touching versions/head (so a name
// change creates no style version). Lazily creates a minimal doc if none exists.
export async function mergeProfile(env, scope, patch) {
  const base = (await readStyleDoc(env, scope)) ||
    { schema: 3, head: 0, versions: [], createdAt: Date.now() };
  const doc = { ...base, profile: { ...(base.profile || {}), ...patch }, updatedAt: Date.now() };
  await env.FILES.put(styleKeyFor(scope), JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}

// Move the head pointer only — no new version written (undo/redo).
// Returns the updated doc, or null if key not found or newHead out of range.
export async function setStyleHead(env, scope, newHead) {
  const current = await readStyleDoc(env, scope);
  if (!current || !Array.isArray(current.versions)) return null;
  if (!current.versions.find((e) => e.v === newHead)) return null;
  const doc = { ...current, head: newHead, updatedAt: Date.now() };
  await env.FILES.put(styleKeyFor(scope), JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}
