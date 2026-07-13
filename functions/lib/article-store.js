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
// 文章无标题时的统一显示值 —— 单一真源（曾漂移出 "（无题）"/"无题" 两个变体）。
export const TITLE_FALLBACK = "(无题)";


export const MAX_VERSIONS = 10;

// doc.createdAt 有两种形态，必须都认：
//   - ISO 字符串 —— miner 写的就是 new Date().toISOString()，生产里绝大多数是这个
//   - epoch 毫秒数字 —— 少量历史文档
// 直接拿它做减法（`b.createdAt - a.createdAt`）会得到 NaN，比较器返回 NaN 时
// 排序静默失效，列表退化成 R2 的 key 字典序（= 最老在前）。踩过一次，别再踩。
// 排序一律走这个函数，别在调用处自己 `|| 0`。
export function articleTime(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

// 按 createdAt 倒序（最新在前）。时间缺失/不可解析的沉底。
export function byNewestFirst(a, b) {
  return articleTime(b.createdAt) - articleTime(a.createdAt);
}

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
    : (doc.body ? [{ title: doc.title || TITLE_FALLBACK, body: doc.body }] : []);
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

// ── 追问 sidecar ────────────────────────────────────────────────────────────────
// doc.questions = [{id, articleIndex, text, status: pending|answered|skipped,
// createdAt}] —— 非版本化元数据，与 transcript/tags 同级。正文、versions[]、
// 发布/分享/社区/小红书各出口都不含追问；undo/redo 也不会让它起死回生。
// 改状态 = 元数据写，不铸版本（同 setHead 的道理）。
export async function setQuestionStatus(env, key, id, status) {
  if (!["pending", "answered", "skipped"].includes(status)) return null;
  const current = await readArticleDoc(env, key);
  if (!current || !Array.isArray(current.questions)) return null;
  if (!current.questions.some((q) => q && q.id === id)) return null;
  const questions = current.questions.map((q) =>
    q && q.id === id ? { ...q, status, ...(status === "answered" ? { answeredAt: Date.now() } : {}) } : q);
  const doc = { ...current, questions, updatedAt: Date.now() };
  await env.FILES.put(key, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return doc;
}

// 追加追问（语音「再追问我几个」→ agent 的 add_followups 工具）：同样是元数据写，
// 不铸版本。与已有问题按文本去重——问过的（含已答/已跳过）不再问。
// texts 每次最多收 3 条；返回 { doc, added } 或 null（文章不存在）。
export async function appendQuestions(env, key, texts, articleIndex = 0) {
  const current = await readArticleDoc(env, key);
  if (!current) return null;
  const existing = Array.isArray(current.questions) ? current.questions : [];
  const seen = new Set(existing.map((q) => String((q && q.text) || "").trim()));
  const now = Date.now();
  const added = [];
  for (const t of (texts || []).slice(0, 3)) {
    const text = String(t || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    added.push({ id: `q${now}-${articleIndex}-${existing.length + added.length}`, articleIndex, text, status: "pending", createdAt: now });
  }
  if (!added.length) return { doc: current, added: 0 };
  const doc = { ...current, questions: [...existing, ...added], updatedAt: now };
  await env.FILES.put(key, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  return { doc, added: added.length };
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
  if (doc.body) return [{ title: doc.title || TITLE_FALLBACK, body: doc.body }];
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
