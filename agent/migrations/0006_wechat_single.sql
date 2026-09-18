-- Diagnostic one-time APP payments, isolated from subscription entitlements.
CREATE TABLE wechat_single_order (
  out_trade_no TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen=1),
  status TEXT NOT NULL CHECK(status IN ('creating','pending','unknown','paid','closed','failed')),
  prepay_id TEXT,
  transaction_id TEXT UNIQUE,
  paid_at INTEGER,
  confirmed_by TEXT,
  last_error_code TEXT,
  last_query_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_wechat_single_user ON wechat_single_order(user_sub,created_at);
CREATE UNIQUE INDEX idx_wechat_single_open ON wechat_single_order(user_sub)
  WHERE status IN ('creating','pending','unknown');
