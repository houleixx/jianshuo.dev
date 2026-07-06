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


export async function getLedger(db, userSub, limit = 50) {
  const r = await db.prepare(
    "SELECT ts,kind,amount_uy,reason,detail,balance_uy FROM ledger WHERE user_sub=? ORDER BY ts DESC, id DESC LIMIT ?"
  ).bind(userSub, limit).all();
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
