// Versioned read/write for articles/<stem>.json.
// Shared by the Files API (functions/files/api/[[path]].js) and tests.
//
// Schema 3: { head, versions: [{v, savedAt, source, articles}], ...metadata }
// head = v-number of the currently active version (the git HEAD analogy).
// versions are oldest-first, always contiguous v numbers within the array,
// but the array may start at v>1 once MAX_VERSIONS oldest entries are pruned.
//
// Undo = move head to head-1 (setHead). No new version written.
// Redo = move head to head+1 (setHead). No new version written.
// New edit = truncate versions after head, append v=head+1, head++.

export const MAX_VERSIONS = 10;

// Upgrade a schema-2 doc (top-level `articles` + `history` array) to schema-3
// in memory. Called by readArticleDoc so callers are always schema-3.
function migrateToV3(doc) {
  if (Array.isArray(doc.versions)) return doc; // already schema-3

  const oldHistory = Array.isArray(doc.history) ? doc.history : [];
  // history was newest-first; reverse to get oldest-first for versions[]
  const olderVersions = [...oldHistory].reverse().map((e) => ({
    v: e.v,
    savedAt: e.savedAt || 0,
    source: e.source || "unknown",
    articles: e.articles || [],
  }));

  const latestV = olderVersions.length > 0
    ? olderVersions[olderVersions.length - 1].v + 1
    : (doc.version || 1);
  // v1 docs had no `articles[]` — content lived in a top-level `body`. Carry it
  // into the migrated version so reading/re-saving a v1 doc doesn't blank it out.
  // (Mirrors the v1 fallback in every resolveArticles across the Files/share/agent code.)
  const currentArticles = (Array.isArray(doc.articles) && doc.articles.length)
    ? doc.articles
    : (doc.body ? [{ title: doc.title || "(无题)", body: doc.body }] : []);
  const currentEntry = {
    v: latestV,
    savedAt: doc.updatedAt || 0,
    source: doc._source || "unknown",
    articles: currentArticles,
  };
  const versions = [...olderVersions, currentEntry];

  // strip v1 content remnants (body/title) too — they now live in versions[].articles
  const { articles: _a, history: _h, version: _v, _source: _s, body: _b, title: _t, ...rest } = doc;
  return { ...rest, head: latestV, versions };
}

export async function readArticleDoc(env, key) {
  const obj = await env.FILES.get(key);
  if (!obj) return null;
  try { return migrateToV3(JSON.parse(await obj.text())); } catch { return null; }
}

// newDoc – the full doc with all metadata fields; newDoc.articles = the new version's content.
// source – "mine" | "agent" | "wechat"
export async function writeArticleDoc(env, key, newDoc, source = "unknown") {
  const current = await readArticleDoc(env, key);

  let versions, head;
  if (current && Array.isArray(current.versions) && current.head) {
    // Truncate any "future" versions (after head, left over from undo), then append.
    const base = current.versions.filter((e) => e.v <= current.head);
    const newV = current.head + 1;
    const newArticles = Array.isArray(newDoc.articles) ? newDoc.articles : [];
    const entry = { v: newV, savedAt: Date.now(), source, articles: newArticles };
    versions = [...base, entry].slice(-MAX_VERSIONS);
    head = newV;
  } else {
    // First write for this article.
    const newArticles = Array.isArray(newDoc.articles) ? newDoc.articles : [];
    versions = [{ v: 1, savedAt: Date.now(), source, articles: newArticles }];
    head = 1;
  }

  // Strip old schema fields; preserve all metadata (transcript, photos, etc.)
  const { articles: _a, history: _h, version: _v, _source: _s, ...rest } = newDoc;
  const doc = { ...rest, head, versions, updatedAt: Date.now() };
  await env.FILES.put(key, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}

// Move the head pointer only — no new version is written.
// Returns the updated doc, or null if key not found or newHead out of range.
export async function setHead(env, key, newHead) {
  const current = await readArticleDoc(env, key);
  if (!current || !Array.isArray(current.versions)) return null;
  if (!current.versions.find((e) => e.v === newHead)) return null;
  const doc = { ...current, head: newHead, updatedAt: Date.now() };
  await env.FILES.put(key, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}

// ── Current-articles resolution — SINGLE SOURCE OF TRUTH ──────────────────────
// Every reader of an article doc must agree on "what is the current article
// list": the Files API (read/list/relay), the agent worker, the public share
// page, and old iOS builds that fetch the raw doc. Keep that logic HERE only and
// import it — change it once, every surface updates together. Do not re-inline.
//
// Schema-3: content lives in versions[head]; schema-2: top-level articles; v1: a
// single title/body.
export function resolveArticles(doc) {
  if (Array.isArray(doc.versions) && doc.head) {
    const cv = doc.versions.find((e) => e.v === doc.head);
    if (cv && Array.isArray(cv.articles) && cv.articles.length) return cv.articles;
  }
  if (Array.isArray(doc.articles) && doc.articles.length) return doc.articles;
  if (doc.body) return [{ title: doc.title || "(无题)", body: doc.body }];
  return [];
}

// A doc carrying a top-level `articles` field rebuilt from the current head
// version — backwards compat for any caller that reads the raw doc (old iOS
// builds via /download, the admin/share web pages). versions/head stay intact
// (purely additive), so version-aware readers are unaffected.
export function withTopLevelArticles(doc) {
  if (Array.isArray(doc.articles) && doc.articles.length) return doc;
  return { ...doc, articles: resolveArticles(doc) };
}
