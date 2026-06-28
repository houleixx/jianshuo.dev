-- migrations/0001_usage.sql
CREATE TABLE IF NOT EXISTS account (
  user_sub   TEXT PRIMARY KEY,
  balance_uy INTEGER NOT NULL DEFAULT 0,
  granted_uy INTEGER NOT NULL DEFAULT 0,
  spent_uy   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_sub   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,            -- 'grant' | 'spend'
  amount_uy  INTEGER NOT NULL,         -- positive magnitude; direction from kind
  reason     TEXT NOT NULL,            -- 'signup'|'campaign:<id>'|'mine'|'edit'|'asr'
  detail     TEXT,                     -- JSON
  balance_uy INTEGER NOT NULL          -- post-transaction snapshot
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_sub, ts);
