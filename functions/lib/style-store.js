// Versioned read/write for the user's writing style — users/<sub>/CLAUDE.json.
// Mirrors functions/lib/article-store.js (same schema-3 versioned envelope) so the
// 文风 doc gets the same history/undo as articles. Shared by the Files API
// (functions/files/api/[[path]].js), the agent worker (agent/src/*), and tests.
//
// Schema 3: { schema:3, head, versions:[{v, savedAt, source, style}], createdAt, updatedAt }
//   head    = v-number of the currently active version (git HEAD analogy)
//   versions are oldest-first, contiguous v numbers; the array may start at v>1
//             once the MAX_VERSIONS oldest entries are pruned.
//   style   = the 文风 text (the name lives elsewhere — legacy CLAUDE.md for now).
//
// Backward compat: the canonical store is CLAUDE.json. The old CLAUDE.md (which
// held「# 我的名字…# 我的文风…」) is still READ as a fallback by readStyleText —
// its 文风 section is parsed out. Writers only ever write CLAUDE.json, so an old
// CLAUDE.md is retired the first time a user saves.

export const STYLE_MAX_VERSIONS = 10;

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
