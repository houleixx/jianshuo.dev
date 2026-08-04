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

import { coreUpsertArticleEntry, coreSetArticleFlag, coreDeleteArticle } from "./core-db.js";


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

// ── 文章摘要索引（D1 articles 表）─────────────────────────────────────────────
// GET /articles 的快路径直接拿这份索引出列表（慢的大头是 R2 listing 本身，
// 几百个对象一页 ~1s），所以每个写入口在下面的 putArticleDoc 里同步维护它。
// 索引只是加速层：R2 listing 仍是权威，list 路由每次响应后在 waitUntil 里全量
// 对账——写-写并发的 lost update、绕过 API 的直写（如 agent 的 style-intro
// 文章）都在下一次打开时收敛。索引写失败绝不打断文章写主路径。

// 列表条目的唯一出处——list 路由的对账和写入口的同步维护都用它，字段不漂。
export function indexEntryFor(stem, doc) {
  const currentArticles = resolveArticles(doc);
  const entry = {
    stem,
    title: currentArticles[0]?.title || TITLE_FALLBACK,
    head: doc.head || 1,
    createdAt: doc.createdAt || 0,
    updatedAt: doc.updatedAt || 0,
    count: currentArticles.length,
  };
  if (Array.isArray(doc.tags) && doc.tags.length) entry.tags = doc.tags;
  return entry;
}

// key = users/<sub>/articles/<stem>.json → { scope, stem }；不匹配 → null
function scopeStemFromKey(key) {
  const m = /^(.*\/)articles\/([^/]+)\.json$/.exec(key || "");
  return m ? { scope: m[1], stem: m[2] } : null;
}

// fp 与 list 路由的指纹同源：R2 put 返回的 etag 就是之后 listing 里的 etag。
// 拿不到时置 null → 下次对账判 stale 重读一次该 doc，自愈。
async function upsertIndexEntry(env, key, doc, putResult) {
  const loc = scopeStemFromKey(key);
  if (!loc) return;
  try {
    const entry = indexEntryFor(loc.stem, doc);
    await coreUpsertArticleEntry(env, loc.scope, loc.stem, JSON.stringify(entry),
      (putResult && putResult.etag) || null, articleTime(entry.createdAt));
  } catch { /* 索引是加速层，绝不打断写主路径 */ }
}

// sidecar 标记（empty / blocked / tags）：articles/<stem>.<flag> 三种标记文件的
// 存在性也进索引——recordings 轻量接口全靠它拿录音状态，免扫 articles/ 前缀。
// 写标记的路由（/empty、/blocked、.tags 上传、对应删除）同步调它；历史数据与
// 漂移由 list/recordings 的后台对账按 listing 权威重建。
export async function setIndexFlag(env, scope, stem, flag, on = true) {
  try {
    await coreSetArticleFlag(env, scope, stem, flag, on);
  } catch { /* 同上：加速层，绝不打断写主路径 */ }
}

// 删文章时把索引条目一并摘掉（DELETE /articles/<stem> 路由调）。
export async function removeIndexEntry(env, key) {
  const loc = scopeStemFromKey(key);
  if (!loc) return;
  try {
    await coreDeleteArticle(env, loc.scope, loc.stem);
  } catch {}
}

// 文章 doc 的唯一落盘出口：写 doc + 维护摘要索引。opts.deferIndex（可选）：把索引
// 维护交给调用方后台执行（(fn)=>void，fn 返回 promise）——语音编辑的交互路径上索引
// 是纯加速层且有 list/recordings 后台对账兜底（fp 不符即按 listing 权威重建），丢了
// 自愈，不值得让用户为它等两次 R2 往返 + 一次 D1。不传照旧同步。
async function putArticleDoc(env, key, doc, opts = {}) {
  const put = await env.FILES.put(key, JSON.stringify(doc), { httpMetadata: { contentType: "application/json" } });
  const idx = () => upsertIndexEntry(env, key, doc, put);
  if (opts.deferIndex) opts.deferIndex(idx);
  else await idx();
  return put;
}

// newDoc – the new version's content in `articles`, plus any metadata fields to set.
//          A PARTIAL doc is fine: anything it omits is carried over from the stored doc.
// source – "mine" | "agent" | "wechat"
// opts.current – 调用方手里已有的存量 doc（含 versions/head），传入即免一次 R2 重读。
//          语义与重读等价减一个竞态窗口的宽度——本来读写之间就没有 CAS，编辑队列
//          按文章串行，这里的重读从来不是并发保护。显式传 null = 确认是首写。
// opts.deferIndex – 透传给 putArticleDoc（索引维护转后台，见其注释）。
export async function writeArticleDoc(env, key, newDoc, source = "unknown", opts = {}) {
  // opts.current 是调用方从 R2 直读的 RAW doc（没过 readArticleDoc 的 migrateToV3）
  // ——老 schema-2 doc 不迁移的话下面会走「首写」分支把版本链重置成 v1。这里补迁移，
  // 已是 v3 的原样返回，零开销。
  const current = opts.current !== undefined
    ? (opts.current ? migrateToV3(opts.current) : null)
    : await readArticleDoc(env, key);

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

  // Strip old schema fields, then MERGE onto the stored doc — never replace it.
  // Not every writer sends a full doc: the MCP write_article tool sends only
  // { articles }, so a plain spread of newDoc silently wiped transcript, srt,
  // createdAt, sourceAudio, photos, status and model off any recording-backed
  // article an agent touched. iOS and the miner always send the whole doc, so
  // their fields still win — this only stops a partial write from deleting the
  // fields it never mentioned.
  const { articles: _a, history: _h, version: _v, _source: _s, ...rest } = newDoc;
  // current 一侧做同样的字段清洗：opts.current 可能与 newDoc 是同一个对象（agent
  // 直写路径），只清 rest 不清 current 的话，顶层 articles/history 会经 current
  // 展开泄漏进存量 doc——schema-3 的正文只活在 versions[head]；泄漏的顶层 articles
  // 在 undo（head 后移）之后就是一份过期正文，raw /download 和 DO 连接快照的
  // withTopLevelArticles 见顶层字段直接原样返回，会把它当权威内容发给客户端。
  const { articles: _ca, history: _ch, version: _cv, _source: _cs, ...curRest } = current || {};
  const doc = { ...curRest, ...rest, head, versions, updatedAt: Date.now() };
  // An article minted by a partial writer has no createdAt at all, and the list
  // sorts it to 1970. Stamp it once, on the write that creates the doc.
  if (!doc.createdAt) doc.createdAt = new Date().toISOString();
  await putArticleDoc(env, key, doc, { deferIndex: opts.deferIndex });
  return doc;
}

// Move the head pointer only — no new version is written.
// Returns the updated doc, or null if key not found or newHead out of range.
export async function setHead(env, key, newHead) {
  const current = await readArticleDoc(env, key);
  if (!current || !Array.isArray(current.versions)) return null;
  if (!current.versions.find((e) => e.v === newHead)) return null;
  const doc = { ...current, head: newHead, updatedAt: Date.now() };
  await putArticleDoc(env, key, doc);
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
  await putArticleDoc(env, key, doc);
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
  await putArticleDoc(env, key, doc);
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
