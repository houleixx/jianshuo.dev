// Shared helpers for the VoiceDrop web pages — SINGLE SOURCE OF TRUTH.
//
// Loaded via <script src="/voicedrop/shared.js"></script> BEFORE each page's
// inline <script>, so these become globals the pages reuse. Change here once and
// every page (admin, llm, mine, article reader) updates together. Do not
// re-inline copies in the pages.

// HTML-escape for safe text interpolation.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// querySelector shorthand (optional scope root).
function $(sel, root) { return (root || document).querySelector(sel); }

// Current article list from an article doc, regardless of schema version. Mirrors
// the server's resolveArticles (functions/lib/article-store.js): schema-3 →
// versions[head]; schema-2 → top-level articles; v1 → a single title/body.
function resolveArticles(doc) {
  if (Array.isArray(doc.versions) && doc.versions.length) {
    const cur = doc.versions.find((v) => v.v === doc.head) || doc.versions[doc.versions.length - 1];
    if (cur && Array.isArray(cur.articles) && cur.articles.length) return cur.articles;
  }
  if (Array.isArray(doc.articles) && doc.articles.length) return doc.articles;
  if (doc.body) return [{ title: doc.title, body: doc.body }];
  return [];
}
