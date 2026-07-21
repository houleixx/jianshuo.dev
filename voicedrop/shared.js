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

// ── /voicedrop/admin 后台准入（白名单）──────────────────────────────────────────
// 后台页面不再让人粘 master token；改成粘自己的 session token，这里拿去 /voicedrop/
// admin/auth 校验白名单，命中才换回 FILES_TOKEN（页面照旧用它调 API）。返回 FILES_TOKEN
// 字符串；失败抛错，err.scope 带上你的 scope（未在白名单时）方便加名单。
async function vdAdminExchange(sessionToken) {
  const r = await fetch('/voicedrop/admin/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: String(sessionToken || '').trim() }),
  });
  if (r.status === 200) return (await r.json()).ft;
  let b = {};
  try { b = await r.json(); } catch {}
  let msg;
  if (r.status === 403) {
    msg = `你的身份不在白名单（名字：${b.name || '未设置'}，ID：${b.code || '?'}）。把它加入 ADMIN_NAMES 即可。`;
  } else if (r.status === 401) {
    msg = 'session token 无效或已过期，请重新登录后复制。';
  } else {
    msg = b.error || ('HTTP ' + r.status);
  }
  throw Object.assign(new Error(msg), { status: r.status, name: b.name, code: b.code, scope: b.scope });
}
