// Versioned read/write for articles/<stem>.json.
// Shared by the Files API (functions/files/api/[[path]].js) and tests.
//
// Every write increments `version` and prepends the previous articles[] to
// `history` (newest-first, max MAX_HISTORY entries). Callers are unaware of
// versioning — they just pass the doc they want to persist.

export const MAX_HISTORY = 10;

export async function readArticleDoc(env, key) {
  const obj = await env.FILES.get(key);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}

// newDoc  – the full doc the caller wants to persist (articles[] already set)
// source  – label: "mine" | "mine-wechat" | "agent" | "wechat" | "revert"
export async function writeArticleDoc(env, key, newDoc, source = "unknown") {
  const current = await readArticleDoc(env, key);

  let version = 1;
  let history = [];

  if (current && Array.isArray(current.articles)) {
    version = (current.version || 0) + 1;
    const entry = {
      v: current.version || 1,
      savedAt: current.updatedAt || current.createdAt || Date.now(),
      source: current._source || "unknown",
      articles: current.articles,
    };
    history = [entry, ...(current.history || [])].slice(0, MAX_HISTORY);
  }

  const doc = { ...newDoc, version, _source: source, updatedAt: Date.now(), history };
  await env.FILES.put(key, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}
