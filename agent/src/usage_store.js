// src/usage_store.js — D1 access for the usage ledger.
import { SIGNUP_GRANT_UY, SIGNUP_EXPIRE_DAYS, DAY_MS } from "./usage.js";

export async function ensureAccount(db, userSub, now) {
  const res = await db.prepare(
    "INSERT OR IGNORE INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)"
  ).bind(userSub, SIGNUP_GRANT_UY, SIGNUP_GRANT_UY, 0, now, now).run();

  // 只有真正新建该行的调用者（changes===1）发放 signup 桶，并发首触不会二次发。
  if (res && res.meta && res.meta.changes === 1) {
    const exp = now + SIGNUP_EXPIRE_DAYS * DAY_MS;
    await db.prepare(
      "INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)"
    ).bind(userSub, SIGNUP_GRANT_UY, SIGNUP_GRANT_UY, "signup", now, exp).run();
    await db.prepare(
      "INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)"
    ).bind(userSub, now, "grant", SIGNUP_GRANT_UY, "signup", null, SIGNUP_GRANT_UY).run();
  }
  return await balanceUY(db, userSub, now);
}

// 未过期桶余额（惰性过期）：expires_at NULL 视为永不过期。
export async function balanceUY(db, userSub, now) {
  const row = await db.prepare(
    "SELECT COALESCE(SUM(remaining_uy),0) AS bal FROM bucket WHERE user_sub=? AND (expires_at IS NULL OR expires_at > ?)"
  ).bind(userSub, now).first();
  return row ? row.bal : 0;
}

// 发放一个桶：写 bucket + 更新 account 统计/缓存 + 记 grant 流水。
// detail（可选）原样 JSON 进 ledger.detail——投币用它带 feed_id/share_id 供对账。
export async function grantBucket(db, userSub, amountUY, source, expiresAt, now, detail = null) {
  await ensureAccount(db, userSub, now);
  await db.prepare(
    "INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)"
  ).bind(userSub, amountUY, amountUY, source, now, expiresAt ?? null).run();
  const bal = await balanceUY(db, userSub, now);
  const up = db.prepare("UPDATE account SET granted_uy=granted_uy+?, balance_uy=?, updated_at=? WHERE user_sub=?")
    .bind(amountUY, bal, now, userSub);
  const led = db.prepare("INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)")
    .bind(userSub, now, "grant", amountUY, source, detail ? JSON.stringify(detail) : null, bal);
  // NOTE (known limitation): the bucket mutation above and this account+ledger write
  // are two separate D1 batches (balanceUY must be read between them). Balance stays
  // correct because buckets are the source of truth; a crash here can drop this
  // ledger/stats row. Accepted as a fast-follow per final review.
  await db.batch([up, led]);
}

export async function debit(db, userSub, amountUY, reason, detail, now) {
  if (!amountUY || amountUY <= 0) return;
  const live = (await db.prepare(
    "SELECT id, remaining_uy FROM bucket WHERE user_sub=? AND remaining_uy > 0 AND (expires_at IS NULL OR expires_at > ?) " +
    "ORDER BY (expires_at IS NULL) ASC, expires_at ASC, id ASC"
  ).bind(userSub, now).all()).results;

  let left = amountUY;
  let lastId = null;
  const stmts = [];
  for (const b of live) {
    if (left <= 0) break;
    const take = Math.min(b.remaining_uy, left);
    stmts.push(db.prepare("UPDATE bucket SET remaining_uy = remaining_uy - ? WHERE id=?").bind(take, b.id));
    left -= take;
    lastId = b.id;
  }
  if (left > 0) {
    if (lastId != null) {
      stmts.push(db.prepare("UPDATE bucket SET remaining_uy = remaining_uy - ? WHERE id=?").bind(left, lastId));
    } else {
      // 无任何活桶（gate 一般会拦在前面，仅多步操作中途可能命中）：建一个永不过期的负桶记欠款。
      stmts.push(db.prepare(
        "INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)"
      ).bind(userSub, 0, -left, "overdraft", now, null));
    }
  }
  if (stmts.length) await db.batch(stmts);

  const bal = await balanceUY(db, userSub, now);
  const up = db.prepare("UPDATE account SET spent_uy=spent_uy+?, balance_uy=?, updated_at=? WHERE user_sub=?")
    .bind(amountUY, bal, now, userSub);
  const led = db.prepare("INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)")
    .bind(userSub, now, "spend", amountUY, reason, detail ? JSON.stringify(detail) : null, bal);
  // NOTE (known limitation): the bucket mutation above and this account+ledger write
  // are two separate D1 batches (balanceUY must be read between them). Balance stays
  // correct because buckets are the source of truth; a crash here can drop this
  // ledger/stats row. Accepted as a fast-follow per final review.
  await db.batch([up, led]);
}


// 明细翻页：keyset 游标 (ts,id) 双键——ts 会撞（同毫秒多笔），OFFSET 会在新行插入时漂移。
// before = { ts, id }：只取严格早于该行的记录。
export async function getLedger(db, userSub, limit = 50, before = null) {
  let sql = "SELECT id,ts,kind,amount_uy,reason,detail,balance_uy FROM ledger WHERE user_sub=?";
  const binds = [userSub];
  if (before) {
    sql += " AND (ts < ? OR (ts = ? AND id < ?))";
    binds.push(before.ts, before.ts, before.id);
  }
  sql += " ORDER BY ts DESC, id DESC LIMIT ?";
  binds.push(limit);
  return (await db.prepare(sql).bind(...binds).all()).results;
}

// 算力页的「来源/花费」汇总：全量 ledger 按 kind+reason 聚合，一次拿全——
// 客户端在 50 条窗口里现算来源是错的（老 grant 早被挤出窗口）。金额微元，出口转算力。
export async function usageSummary(db, userSub) {
  const r = await db.prepare(
    "SELECT kind, reason, SUM(amount_uy) AS total_uy, COUNT(*) AS n FROM ledger WHERE user_sub=? GROUP BY kind, reason"
  ).bind(userSub).all();
  return r.results;
}

export async function editCount(db, userSub, stem) {
  const row = await db.prepare(
    "SELECT COUNT(DISTINCT json_extract(detail,'$.turn_id')) AS n FROM ledger WHERE user_sub=? AND reason='edit' AND json_extract(detail,'$.stem')=?"
  ).bind(userSub, stem).first();
  return row ? row.n : 0;
}

export async function allAccounts(db, now) {
  const r = await db.prepare(
    "SELECT a.user_sub, a.granted_uy, a.spent_uy, a.updated_at, " +
    "COALESCE((SELECT SUM(b.remaining_uy) FROM bucket b " +
    "          WHERE b.user_sub=a.user_sub AND (b.expires_at IS NULL OR b.expires_at > ?)),0) AS balance_uy " +
    "FROM account a ORDER BY a.spent_uy DESC"
  ).bind(now).all();
  return r.results;
}

// 投喂挖矿账本（admin）：mint 表是投币玩法的事件真源，这里做三张聚合——
//   summary  全站累计（挖出算力/币数/事件数）+ 今日池用量
//   board    每账户挖矿收益（作为作者收到 vs 主动投币奖励），按合计降序
//   events   最近 N 笔投喂流水（含文章标题快照与双边算力）
// 只聚合 kind='feed'（当前唯一玩法），将来新玩法可放宽。金额一律微元，出口再转算力。
export async function mintLedger(db, now, limit = 80) {
  const DAY = 86400000;
  const summary = await db.prepare(
    "SELECT COUNT(*) AS events, COALESCE(SUM(coins_uc),0) AS coins_uc, " +
    "COALESCE(SUM(actor_uy+beneficiary_uy),0) AS minted_uy, " +
    "COALESCE(SUM(beneficiary_uy),0) AS author_uy, COALESCE(SUM(actor_uy),0) AS feeder_uy " +
    "FROM mint WHERE kind='feed'"
  ).first();

  const day0 = now - (now % DAY);
  const today = await db.prepare(
    "SELECT COALESCE(SUM(actor_uy+beneficiary_uy),0) AS minted_uy, COUNT(*) AS events FROM mint WHERE ts>=?"
  ).bind(day0).first();

  // 近 7 天铸币量（币价分母用，与 /agent/feed/state 同口径）
  const sum7 = (await db.prepare(
    "SELECT COALESCE(SUM(coins_uc),0) AS s FROM mint WHERE ts>?"
  ).bind(now - 7 * DAY).first()).s;

  // 每账户收益：作者侧(beneficiary)与投币侧(actor)分别贡献行，再按账户合并——
  // 避免把一笔事件的算力双记；coins_uc 只算在作者侧那半，防重复。
  const board = (await db.prepare(
    "SELECT sub, SUM(author_uy) AS author_uy, SUM(feeder_uy) AS feeder_uy, " +
    "SUM(recv_cnt) AS recv_cnt, SUM(feed_cnt) AS feed_cnt FROM (" +
    "  SELECT beneficiary_sub AS sub, beneficiary_uy AS author_uy, 0 AS feeder_uy, 1 AS recv_cnt, 0 AS feed_cnt FROM mint WHERE kind='feed'" +
    "  UNION ALL" +
    "  SELECT actor_sub AS sub, 0, actor_uy, 0, 1 FROM mint WHERE kind='feed' AND actor_sub IS NOT NULL" +
    ") GROUP BY sub ORDER BY (author_uy+feeder_uy) DESC LIMIT 500"
  ).all()).results;

  const events = (await db.prepare(
    "SELECT share_id, actor_sub, beneficiary_sub, coins_uc, price_uy, actor_uy, beneficiary_uy, detail, ts " +
    "FROM mint WHERE kind='feed' ORDER BY ts DESC, id DESC LIMIT ?"
  ).bind(limit).all()).results;

  return { summary, today, sum7, board, events };
}

// 拉新账本（admin）：mint 表 kind='referral' 的三张聚合——
//   summary  累计拉新（人数/发出算力，邀请人侧 vs 新人侧）+ 今日人数
//   board    每邀请人拉新数与奖励（owner 日封顶 30，capped 后作者侧为 0 但人数照记）
//   events   最近 N 笔归因流水（via: link/clipboard=token 层，hello=IP 指纹层）
export async function referralLedger(db, now, limit = 50) {
  const DAY = 86400000;
  const summary = await db.prepare(
    "SELECT COUNT(*) AS events, COALESCE(SUM(actor_uy+beneficiary_uy),0) AS minted_uy, " +
    "COALESCE(SUM(beneficiary_uy),0) AS owner_uy, COALESCE(SUM(actor_uy),0) AS newuser_uy " +
    "FROM mint WHERE kind='referral'"
  ).first();

  const day0 = now - (now % DAY);
  const today = await db.prepare(
    "SELECT COUNT(*) AS events FROM mint WHERE kind='referral' AND ts>=?"
  ).bind(day0).first();

  const board = (await db.prepare(
    "SELECT beneficiary_sub AS sub, COUNT(*) AS invited_cnt, " +
    "COALESCE(SUM(beneficiary_uy),0) AS owner_uy, MAX(ts) AS last_ts " +
    "FROM mint WHERE kind='referral' GROUP BY beneficiary_sub " +
    "ORDER BY invited_cnt DESC, owner_uy DESC LIMIT 200"
  ).all()).results;

  const events = (await db.prepare(
    "SELECT share_id, actor_sub, beneficiary_sub, price_uy, actor_uy, beneficiary_uy, detail, ts " +
    "FROM mint WHERE kind='referral' ORDER BY ts DESC, id DESC LIMIT ?"
  ).bind(limit).all()).results;

  return { summary, today, board, events };
}
