// One-time migration (2026-07-03): hoist the legacy `<!-- style: 风格 vN -->` body
// comment into the per-article `style` FIELD, and strip ALL `<!--…-->` comments from
// bodies — bodies must contain only user-visible content (a hidden comment line
// desynced the 第N行 numbering between app and agent). Idempotent: a body with no
// comments is untouched, so re-running is safe. Pure functions; unit-tested from
// agent/test/style-field.test.js; I/O lives in worker.js (run via wrangler dev --remote).

const STYLE_RE = /<!--\s*style\s*:\s*风格\s*v(\d+)\s*-->/i;
const ANY_COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Migrate one article: comment → style field, body de-commented. */
export function migrateArticle(a) {
  if (!a || typeof a !== "object" || !/<!--/.test(String(a.body ?? ""))) {
    return { article: a, changed: false };
  }
  const body = String(a.body ?? "");
  const m = body.match(STYLE_RE);
  const newBody = body.replace(ANY_COMMENT_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  const out = { ...a, body: newBody };
  if (m && out.style == null) out.style = Number(m[1]);
  return { article: out, changed: true };
}

/** Migrate a whole article doc: every version's articles (schema-3 versions[],
 *  schema-2 top-level articles[] + history[]). v1 docs (top-level body, pre-style)
 *  are left alone. Returns { doc, changed }. */
export function migrateDoc(doc) {
  if (!doc || typeof doc !== "object") return { doc, changed: false };
  let changed = false;
  const mapArts = (arts) => arts.map((a) => {
    const r = migrateArticle(a);
    if (r.changed) changed = true;
    return r.article;
  });
  const mapEntries = (entries) => entries.map((e) =>
    (e && Array.isArray(e.articles)) ? { ...e, articles: mapArts(e.articles) } : e);

  const out = { ...doc };
  if (Array.isArray(out.versions)) out.versions = mapEntries(out.versions);
  if (Array.isArray(out.history)) out.history = mapEntries(out.history);
  if (Array.isArray(out.articles)) out.articles = mapArts(out.articles);
  return { doc: out, changed };
}
