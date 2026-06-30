// src/usage_store.js — D1 access for the usage ledger.
import { SIGNUP_GRANT_UY, SIGNUP_EXPIRE_DAYS, DAY_MS } from "./usage.js";

export async function ensureAccount(db, userSub, now) {
  const row = await db.prepare("SELECT balance_uy FROM account WHERE user_sub=?").bind(userSub).first();
  if (row) return row.balance_uy;
  // Create. INSERT OR IGNORE makes the concurrent first-touch race safe:
  // only the caller whose insert actually creates the row (changes===1) records the signup grant.
  const res = await db.prepare(
    "INSERT OR IGNORE INTO account (user_sub,balance_uy,granted_uy,spent_uy,created_at,updated_at) VALUES (?,?,?,?,?,?)"
  ).bind(userSub, SIGNUP_GRANT_UY, SIGNUP_GRANT_UY, 0, now, now).run();
  if (res && res.meta && res.meta.changes === 0) {
    // Someone created it concurrently — return their balance, do NOT double-grant.
    const r2 = await db.prepare("SELECT balance_uy FROM account WHERE user_sub=?").bind(userSub).first();
    return r2 ? r2.balance_uy : SIGNUP_GRANT_UY;
  }
  await db.prepare(
    "INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)"
  ).bind(userSub, now, "grant", SIGNUP_GRANT_UY, "signup", null, SIGNUP_GRANT_UY).run();
  return SIGNUP_GRANT_UY;
}

// 未过期桶余额（惰性过期）：expires_at NULL 视为永不过期。
export async function balanceUY(db, userSub, now) {
  const row = await db.prepare(
    "SELECT COALESCE(SUM(remaining_uy),0) AS bal FROM bucket WHERE user_sub=? AND (expires_at IS NULL OR expires_at > ?)"
  ).bind(userSub, now).first();
  return row ? row.bal : 0;
}

// 发放一个桶：写 bucket + 更新 account 统计/缓存 + 记 grant 流水。
export async function grantBucket(db, userSub, amountUY, source, expiresAt, now) {
  await ensureAccount(db, userSub, now);
  await db.prepare(
    "INSERT INTO bucket (user_sub,amount_uy,remaining_uy,source,created_at,expires_at) VALUES (?,?,?,?,?,?)"
  ).bind(userSub, amountUY, amountUY, source, now, expiresAt ?? null).run();
  const bal = await balanceUY(db, userSub, now);
  const up = db.prepare("UPDATE account SET granted_uy=granted_uy+?, balance_uy=?, updated_at=? WHERE user_sub=?")
    .bind(amountUY, bal, now, userSub);
  const led = db.prepare("INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)")
    .bind(userSub, now, "grant", amountUY, source, null, bal);
  await db.batch([up, led]);
}

export async function getBalanceUY(db, userSub) {
  const row = await db.prepare("SELECT balance_uy FROM account WHERE user_sub=?").bind(userSub).first();
  return row ? row.balance_uy : null;
}

export async function debit(db, userSub, amountUY, reason, detail, now) {
  if (!amountUY || amountUY <= 0) return;
  const cur = await db.prepare("SELECT balance_uy FROM account WHERE user_sub=?").bind(userSub).first();
  const bal = (cur ? cur.balance_uy : 0) - amountUY;
  const updateStmt = db.prepare("UPDATE account SET balance_uy=?, spent_uy=spent_uy+?, updated_at=? WHERE user_sub=?")
    .bind(bal, amountUY, now, userSub);
  const insertStmt = db.prepare("INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)")
    .bind(userSub, now, "spend", amountUY, reason, detail ? JSON.stringify(detail) : null, bal);
  await db.batch([updateStmt, insertStmt]);
}

export async function grant(db, userSub, amountUY, reason, now) {
  await ensureAccount(db, userSub, now);
  const cur = await db.prepare("SELECT balance_uy FROM account WHERE user_sub=?").bind(userSub).first();
  const bal = cur.balance_uy + amountUY;
  const updateStmt = db.prepare("UPDATE account SET balance_uy=?, granted_uy=granted_uy+?, updated_at=? WHERE user_sub=?")
    .bind(bal, amountUY, now, userSub);
  const insertStmt = db.prepare("INSERT INTO ledger (user_sub,ts,kind,amount_uy,reason,detail,balance_uy) VALUES (?,?,?,?,?,?,?)")
    .bind(userSub, now, "grant", amountUY, reason, null, bal);
  await db.batch([updateStmt, insertStmt]);
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

export async function allAccounts(db) {
  const r = await db.prepare(
    "SELECT user_sub,balance_uy,granted_uy,spent_uy,updated_at FROM account ORDER BY spent_uy DESC"
  ).all();
  return r.results;
}
