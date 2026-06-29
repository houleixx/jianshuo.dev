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

// ── Per-version body comment protocol: `<!-- key: value -->`, extensible. ─────────
// First key: `style`. The article reader shows meta.style on a chip and strips the
// comment from every rendered surface. These are the SINGLE source of the format, so
// generation (miner / restyle) and the reader's match never drift. Future per-version
// UI just adds another key (`<!-- model: opus -->` …).
export function styleLabel(v) { return `风格 v${v}`; }                          // "风格 v8"
export function styleComment(v) { return `<!-- style: ${styleLabel(v)} -->`; }  // "<!-- style: 风格 v8 -->"
export function prependStyleComment(body, v) { return `${styleComment(v)}\n\n${body}`; }

// Read the versioned CLAUDE.json doc (schema-3). Returns null if absent/corrupt.
export async function readStyleDoc(env, styleKey) {
  const obj = await env.FILES.get(styleKey);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
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
export async function readStyleText(env, styleKey, legacyKey) {
  const doc = await readStyleDoc(env, styleKey);
  if (doc) return resolveStyle(doc);
  const legacy = await env.FILES.get(legacyKey);
  if (legacy) return parseStyleMarkdown(await legacy.text());
  return "";
}

// Versioned write (mirrors writeArticleDoc). Bases the version chain on the
// existing CLAUDE.json only — a legacy CLAUDE.md is never folded into history, so
// the first JSON write starts a fresh v1. source: "app" | "agent" | "mine".
export async function writeStyleDoc(env, styleKey, style, source = "unknown") {
  const current = await readStyleDoc(env, styleKey);

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
  await env.FILES.put(styleKey, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}

// ── Profile (non-versioned identity fields: name, + future) ──────────────────
// Lives at doc.profile, OUTSIDE the version history: changing the name should NOT
// mint a new style version. Only the 文风 (style) is versioned.

// The current profile name, "" if none. SINGLE SOURCE OF TRUTH for "who is the
// author" — both the share endpoint and the miner import this (was duplicated
// inline regex). CLAUDE.json's profile.name wins; falls back to the legacy
// CLAUDE.md「# 我的名字」section so existing users keep their name.
export async function readProfileName(env, styleKey, legacyKey) {
  const doc = await readStyleDoc(env, styleKey);
  const n = doc && doc.profile && doc.profile.name;
  if (typeof n === "string" && n.trim()) return n.trim();
  const legacy = await env.FILES.get(legacyKey);
  if (legacy) {
    const m = (await legacy.text()).match(/#\s*我的名字\s*\n+([^\n#]+)/);
    if (m && m[1].trim()) return m[1].trim();
  }
  return "";
}

// Shallow-merge `patch` into doc.profile WITHOUT touching versions/head (so a name
// change creates no style version). Lazily creates a minimal doc if none exists.
export async function mergeProfile(env, styleKey, patch) {
  const base = (await readStyleDoc(env, styleKey)) ||
    { schema: 3, head: 0, versions: [], createdAt: Date.now() };
  const doc = { ...base, profile: { ...(base.profile || {}), ...patch }, updatedAt: Date.now() };
  await env.FILES.put(styleKey, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}

// Move the head pointer only — no new version written (undo/redo).
// Returns the updated doc, or null if key not found or newHead out of range.
export async function setStyleHead(env, styleKey, newHead) {
  const current = await readStyleDoc(env, styleKey);
  if (!current || !Array.isArray(current.versions)) return null;
  if (!current.versions.find((e) => e.v === newHead)) return null;
  const doc = { ...current, head: newHead, updatedAt: Date.now() };
  await env.FILES.put(styleKey, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}
