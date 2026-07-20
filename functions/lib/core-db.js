// functions/lib/core-db.js — voicedrop-core D1 库的唯一访问层（2026-07-20 存储迁移 P1）。
// Pages Functions 与 voicedrop-agent worker 共用这一份（binding 都叫 env.CORE）。
//
// 迁移约定（R2 → D1 过渡期）：
//   · 写路径【双写】：R2 原对象照写，D1 同步落行——任何一边失败不打断另一边。
//   · 读路径【D1 优先、R2 兜底】：D1 报错/无绑定 → 返回 null，调用方走原 R2 路径；
//     「查无此行」返回 false / 空集，与 null 严格区分（null = 后端不可用，不是没数据）。
//   · 本文件所有函数绝不 throw——存储迁移不能成为业务主路径的新故障点。
// 表结构见 agent/migrations-core/0001_core.sql。

const db = (env) => env.CORE || null;

// ── refhits（归因 IP 指纹；原 refhits/<fp>/<ts> 对象树）─────────────────────

export async function coreWriteRefhit(env, fingerprint, ts, owner, token) {
  const d = db(env);
  if (!d || !fingerprint || !owner) return false;
  try {
    await d.prepare(
      "INSERT OR REPLACE INTO refhits (fingerprint, ts, owner, token) VALUES (?,?,?,?)"
    ).bind(String(fingerprint), ts, owner, token || null).run();
    return true;
  } catch (e) { console.error("[core-db] writeRefhit:", e && e.message); return false; }
}

/// 该指纹 sinceTs 之后的全部命中。→ [{owner,token,ts}]；D1 不可用 → null。
export async function coreRefhitRows(env, fingerprint, sinceTs) {
  const d = db(env);
  if (!d) return null;
  try {
    const r = await d.prepare(
      "SELECT owner, token, ts FROM refhits WHERE fingerprint=? AND ts>=? ORDER BY ts DESC LIMIT 500"
    ).bind(String(fingerprint), sinceTs).all();
    return r.results || [];
  } catch (e) { console.error("[core-db] refhitRows:", e && e.message); return null; }
}

/// 全表（admin 一览用，量级：2 天窗口内几百行）。→ rows | null。
export async function coreAllRefhits(env, limit = 5000) {
  const d = db(env);
  if (!d) return null;
  try {
    const r = await d.prepare(
      "SELECT fingerprint, ts, owner, token FROM refhits ORDER BY ts DESC LIMIT ?"
    ).bind(limit).all();
    return r.results || [];
  } catch (e) { console.error("[core-db] allRefhits:", e && e.message); return null; }
}

/// 过期清理（对齐原 R2 lifecycle 2 天）。worker cron 调，best-effort。
export async function coreCleanupRefhits(env, cutoffTs) {
  const d = db(env);
  if (!d) return;
  try { await d.prepare("DELETE FROM refhits WHERE ts<?").bind(cutoffTs).run(); }
  catch (e) { console.error("[core-db] cleanupRefhits:", e && e.message); }
}

// ── invites（邀请码；原 invites/<CODE> 对象）─────────────────────────────────

/// → {owner,name,ts}；查无 → false；D1 不可用 → null。
export async function coreGetInvite(env, code) {
  const d = db(env);
  if (!d) return null;
  try {
    const row = await d.prepare(
      "SELECT owner, name, ts FROM invites WHERE code=?"
    ).bind(String(code).toUpperCase()).first();
    return row || false;
  } catch (e) { console.error("[core-db] getInvite:", e && e.message); return null; }
}

export async function corePutInvite(env, code, owner, name, ts) {
  const d = db(env);
  if (!d) return false;
  try {
    await d.prepare(
      "INSERT INTO invites (code, owner, name, ts) VALUES (?,?,?,?) " +
      "ON CONFLICT(code) DO UPDATE SET owner=excluded.owner, name=excluded.name, ts=excluded.ts"
    ).bind(String(code).toUpperCase(), owner, String(name || ""), ts).run();
    return true;
  } catch (e) { console.error("[core-db] putInvite:", e && e.message); return false; }
}

// ── share_stats（分享码导入计数；shares/<code> 正文仍在 R2）────────────────

/// 原子 +1（这正是 R2 RMW 丢计数的修复点）。→ 新计数 | null。
export async function coreBumpImportCount(env, code) {
  const d = db(env);
  if (!d) return null;
  try {
    const row = await d.prepare(
      "INSERT INTO share_stats (code, import_count, updated_at) VALUES (?,1,?) " +
      "ON CONFLICT(code) DO UPDATE SET import_count=import_count+1, updated_at=excluded.updated_at " +
      "RETURNING import_count"
    ).bind(String(code), Date.now()).first();
    return row ? row.import_count : null;
  } catch (e) { console.error("[core-db] bumpImportCount:", e && e.message); return null; }
}

/// → 计数 number；无行 → false；D1 不可用 → null。
export async function coreImportCount(env, code) {
  const d = db(env);
  if (!d) return null;
  try {
    const row = await d.prepare("SELECT import_count FROM share_stats WHERE code=?").bind(String(code)).first();
    return row ? row.import_count : false;
  } catch (e) { console.error("[core-db] importCount:", e && e.message); return null; }
}

/// 计数种子（backfill / 读时自愈用）：只在无行或落后时抬升，绝不回退已有计数。
export async function coreSeedImportCount(env, code, count) {
  const d = db(env);
  if (!d || !(count > 0)) return;
  try {
    await d.prepare(
      "INSERT INTO share_stats (code, import_count, updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(code) DO UPDATE SET import_count=MAX(import_count, excluded.import_count), updated_at=excluded.updated_at"
    ).bind(String(code), count, Date.now()).run();
  } catch (e) { console.error("[core-db] seedImportCount:", e && e.message); }
}

// ── prompt_shares（提示词分享码 owner 索引；原 users/<sub>/prompt-shares.json）──

/// → {byItem:{itemId:{code,createdAt}}}；D1 不可用 → null。空对象 = 确实没有。
export async function coreLoadPromptShares(env, scope) {
  const d = db(env);
  if (!d) return null;
  try {
    const r = await d.prepare(
      "SELECT item_id, code, created_at FROM prompt_shares WHERE user_sub=?"
    ).bind(scope).all();
    const byItem = {};
    for (const row of r.results || []) byItem[row.item_id] = { code: row.code, createdAt: row.created_at };
    return { byItem };
  } catch (e) { console.error("[core-db] loadPromptShares:", e && e.message); return null; }
}

export async function coreUpsertPromptShare(env, scope, itemId, code, createdAt) {
  const d = db(env);
  if (!d) return false;
  try {
    await d.prepare(
      "INSERT INTO prompt_shares (user_sub, item_id, code, created_at) VALUES (?,?,?,?) " +
      "ON CONFLICT(user_sub, item_id) DO UPDATE SET code=excluded.code, created_at=excluded.created_at"
    ).bind(scope, itemId, String(code), createdAt).run();
    return true;
  } catch (e) { console.error("[core-db] upsertPromptShare:", e && e.message); return false; }
}

/// fork re-key：byItem 的 key 从旧 id 挪到新 id（码与 createdAt 不动）。
/// 目标 id 已占则不动（与 R2 版 rekeyForkedShares 同语义）。
export async function coreRekeyPromptShare(env, scope, fromItemId, toItemId) {
  const d = db(env);
  if (!d) return false;
  try {
    await d.prepare(
      "UPDATE OR IGNORE prompt_shares SET item_id=? WHERE user_sub=? AND item_id=? " +
      "AND NOT EXISTS (SELECT 1 FROM prompt_shares WHERE user_sub=? AND item_id=?)"
    ).bind(toItemId, scope, fromItemId, scope, toItemId).run();
    return true;
  } catch (e) { console.error("[core-db] rekeyPromptShare:", e && e.message); return false; }
}

/// 当日已铸码数（每日上限用）。todayPrefix = "YYYY-MM-DD"。→ number | null。
export async function coreMintedToday(env, scope, todayPrefix) {
  const d = db(env);
  if (!d) return null;
  try {
    const row = await d.prepare(
      "SELECT COUNT(*) AS n FROM prompt_shares WHERE user_sub=? AND created_at LIKE ?"
    ).bind(scope, `${todayPrefix}%`).first();
    return row ? row.n : 0;
  } catch (e) { console.error("[core-db] mintedToday:", e && e.message); return null; }
}

// ── articles 摘要索引（P2；原 users/<sub>/articles-index.json）──────────────
// entry 原样存 R2 索引的 entry JSON 字符串——列表返回给客户端的对象逐字节不变。
// created_ms 由调用方用 articleTime() 归一后传入（core-db 不 import article-store，
// 避免环）。flags 与 entry 独立维护，UPSERT 互不覆盖。

export async function coreUpsertArticleEntry(env, scope, stem, entryJson, fp, createdMs) {
  const d = db(env);
  if (!d) return false;
  try {
    await d.prepare(
      "INSERT INTO articles (user_sub, stem, entry, fp, created_ms) VALUES (?,?,?,?,?) " +
      "ON CONFLICT(user_sub, stem) DO UPDATE SET entry=excluded.entry, fp=excluded.fp, created_ms=excluded.created_ms"
    ).bind(scope, stem, entryJson, fp || null, createdMs || 0).run();
    return true;
  } catch (e) { console.error("[core-db] upsertArticleEntry:", e && e.message); return false; }
}

export async function coreSetArticleFlag(env, scope, stem, flag, on) {
  const d = db(env);
  if (!d) return false;
  const col = { empty: "flag_empty", blocked: "flag_blocked", tags: "flag_tags" }[flag];
  if (!col) return false;
  try {
    if (on) {
      await d.prepare(
        `INSERT INTO articles (user_sub, stem, ${col}) VALUES (?,?,1) ` +
        `ON CONFLICT(user_sub, stem) DO UPDATE SET ${col}=1`
      ).bind(scope, stem).run();
    } else {
      await d.batch([
        d.prepare(`UPDATE articles SET ${col}=0 WHERE user_sub=? AND stem=?`).bind(scope, stem),
        // 与 R2 版同语义：既无摘要也无任何标记 → 整行摘掉
        d.prepare(
          "DELETE FROM articles WHERE user_sub=? AND stem=? AND entry IS NULL " +
          "AND flag_empty=0 AND flag_blocked=0 AND flag_tags=0"
        ).bind(scope, stem),
      ]);
    }
    return true;
  } catch (e) { console.error("[core-db] setArticleFlag:", e && e.message); return false; }
}

export async function coreDeleteArticle(env, scope, stem) {
  const d = db(env);
  if (!d) return false;
  try {
    await d.prepare("DELETE FROM articles WHERE user_sub=? AND stem=?").bind(scope, stem).run();
    return true;
  } catch (e) { console.error("[core-db] deleteArticle:", e && e.message); return false; }
}

/// → [{stem, entry(字符串|null), empty, blocked, tags}]（created_ms 倒序）| null。
export async function coreListArticles(env, scope) {
  const d = db(env);
  if (!d) return null;
  try {
    const r = await d.prepare(
      "SELECT stem, entry, flag_empty, flag_blocked, flag_tags FROM articles WHERE user_sub=? ORDER BY created_ms DESC"
    ).bind(scope).all();
    return (r.results || []).map((row) => ({
      stem: row.stem, entry: row.entry,
      empty: !!row.flag_empty, blocked: !!row.flag_blocked, tags: !!row.flag_tags,
    }));
  } catch (e) { console.error("[core-db] listArticles:", e && e.message); return null; }
}

/// 对账整体回写（reconcile 修 R2 索引的同时把 D1 拉齐；batch = 单事务，无撕裂态）。
/// rows: [{stem, entryJson|null, fp, createdMs, empty, blocked, tags}]
export async function coreReplaceArticles(env, scope, rows) {
  const d = db(env);
  if (!d) return false;
  try {
    const stmts = [d.prepare("DELETE FROM articles WHERE user_sub=?").bind(scope)];
    for (const r of rows) {
      stmts.push(d.prepare(
        "INSERT INTO articles (user_sub, stem, entry, fp, created_ms, flag_empty, flag_blocked, flag_tags) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(scope, r.stem, r.entryJson || null, r.fp || null, r.createdMs || 0,
        r.empty ? 1 : 0, r.blocked ? 1 : 0, r.tags ? 1 : 0));
    }
    await d.batch(stmts);
    return true;
  } catch (e) { console.error("[core-db] replaceArticles:", e && e.message); return false; }
}

export async function coreCountArticles(env, scope) {
  const d = db(env);
  if (!d) return null;
  try {
    const row = await d.prepare("SELECT COUNT(*) AS n FROM articles WHERE user_sub=?").bind(scope).first();
    return row ? row.n : 0;
  } catch (e) { console.error("[core-db] countArticles:", e && e.message); return null; }
}

// ── recordings 录音索引（P2；原 users/<sub>/recordings-index.json）───────────

export async function coreUpsertRecording(env, scope, leaf, uploaded) {
  const d = db(env);
  if (!d) return false;
  try {
    await d.prepare(
      "INSERT INTO recordings (user_sub, leaf, uploaded) VALUES (?,?,?) " +
      "ON CONFLICT(user_sub, leaf) DO UPDATE SET uploaded=excluded.uploaded"
    ).bind(scope, leaf, String(uploaded || "")).run();
    return true;
  } catch (e) { console.error("[core-db] upsertRecording:", e && e.message); return false; }
}

export async function coreDeleteRecording(env, scope, leaf) {
  const d = db(env);
  if (!d) return false;
  try {
    await d.prepare("DELETE FROM recordings WHERE user_sub=? AND leaf=?").bind(scope, leaf).run();
    return true;
  } catch (e) { console.error("[core-db] deleteRecording:", e && e.message); return false; }
}

/// → { "<leaf>.m4a": {uploaded} } | null。
export async function coreListRecordings(env, scope) {
  const d = db(env);
  if (!d) return null;
  try {
    const r = await d.prepare("SELECT leaf, uploaded FROM recordings WHERE user_sub=?").bind(scope).all();
    const items = {};
    for (const row of r.results || []) items[row.leaf] = { uploaded: row.uploaded };
    return items;
  } catch (e) { console.error("[core-db] listRecordings:", e && e.message); return null; }
}

export async function coreReplaceRecordings(env, scope, items) {
  const d = db(env);
  if (!d) return false;
  try {
    const stmts = [d.prepare("DELETE FROM recordings WHERE user_sub=?").bind(scope)];
    for (const [leaf, meta] of Object.entries(items)) {
      stmts.push(d.prepare("INSERT INTO recordings (user_sub, leaf, uploaded) VALUES (?,?,?)")
        .bind(scope, leaf, String((meta && meta.uploaded) || "")));
    }
    await d.batch(stmts);
    return true;
  } catch (e) { console.error("[core-db] replaceRecordings:", e && e.message); return false; }
}

export async function coreCountRecordings(env, scope) {
  const d = db(env);
  if (!d) return null;
  try {
    const row = await d.prepare("SELECT COUNT(*) AS n FROM recordings WHERE user_sub=?").bind(scope).first();
    return row ? row.n : 0;
  } catch (e) { console.error("[core-db] countRecordings:", e && e.message); return null; }
}

// ── 销号清理（account/delete 主路径之外的 best-effort 补充）────────────────

export async function coreDeleteUserData(env, scope) {
  const d = db(env);
  if (!d) return;
  try {
    const codes = await d.prepare("SELECT code FROM prompt_shares WHERE user_sub=?").bind(scope).all();
    const stmts = [
      d.prepare("DELETE FROM prompt_shares WHERE user_sub=?").bind(scope),
      d.prepare("DELETE FROM invites WHERE owner=?").bind(scope),
      d.prepare("DELETE FROM refhits WHERE owner=?").bind(scope),
      d.prepare("DELETE FROM articles WHERE user_sub=?").bind(scope),
      d.prepare("DELETE FROM recordings WHERE user_sub=?").bind(scope),
    ];
    for (const row of codes.results || []) stmts.push(d.prepare("DELETE FROM share_stats WHERE code=?").bind(row.code));
    await d.batch(stmts);
  } catch (e) { console.error("[core-db] deleteUserData:", e && e.message); }
}
