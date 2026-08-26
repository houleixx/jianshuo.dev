-- migrations/0005_wechat.sql — 微信委托代扣（自动续费）
-- 钱仍由 bucket/ledger 统一记账；本迁移只保存微信签约和每期扣费的可审计状态。

CREATE TABLE IF NOT EXISTS wechat_sub (
  contract_code     TEXT PRIMARY KEY,       -- 商户生成、签约前先落库的唯一标识
  contract_id       TEXT UNIQUE,            -- 微信签约成功后回调的委托代扣协议号
  user_sub          TEXT NOT NULL,
  plan_id           TEXT NOT NULL,          -- 微信审核通过的委托代扣模板 ID
  openid            TEXT,
  status            TEXT NOT NULL,          -- pending|active|cancelled|expired
  period_start_at   INTEGER,                -- 当前（已付款）周期起点，ms epoch
  period_end_at     INTEGER,                -- 当前周期终点，按自然月计算，ms epoch
  next_charge_at    INTEGER,                -- 下一次发起扣费申请的时间（周期结束前 24 小时）
  cancel_reason     TEXT,
  signed_at         INTEGER,
  cancelled_at      INTEGER,
  last_event_at     INTEGER,
  last_error_code   TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wechat_sub_user ON wechat_sub(user_sub);
CREATE INDEX IF NOT EXISTS idx_wechat_sub_due ON wechat_sub(status, next_charge_at);

CREATE TABLE IF NOT EXISTS wechat_txn (
  out_trade_no       TEXT PRIMARY KEY,      -- 商户订单号；同一期稳定不变，重试不重复下单
  contract_code      TEXT NOT NULL,
  user_sub           TEXT NOT NULL,
  plan_id            TEXT NOT NULL,
  period_start_at    INTEGER NOT NULL,
  period_end_at      INTEGER NOT NULL,
  amount_fen         INTEGER NOT NULL,
  status             TEXT NOT NULL,         -- pending|charging|settling|paid|failed
  wechat_txn_id      TEXT UNIQUE,           -- 微信支付订单号 transaction_id
  bucket_id          INTEGER,
  charge_requested_at INTEGER,
  paid_at            INTEGER,
  last_callback_at   INTEGER,
  processing_at      INTEGER,
  next_try_at        INTEGER,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  failure_code       TEXT,
  last_error_at      INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE(contract_code, period_start_at)
);
CREATE INDEX IF NOT EXISTS idx_wechat_txn_due ON wechat_txn(status, next_try_at);
CREATE INDEX IF NOT EXISTS idx_wechat_txn_contract ON wechat_txn(contract_code, period_start_at);

-- 不可变审计日志：协议/订单表只存当前快照；排错需要知道每一次回调、申请和状态转换。
-- payload 会在 Worker 写入前移除 sign、nonce 等敏感字段；详细错误文本也只存在这里。
CREATE TABLE IF NOT EXISTS wechat_event (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_code   TEXT,
  out_trade_no    TEXT,
  user_sub        TEXT,
  direction       TEXT NOT NULL,            -- inbound|outbound|internal
  event_type      TEXT NOT NULL,
  status_before   TEXT,
  status_after    TEXT,
  wechat_txn_id   TEXT,
  code            TEXT,
  message         TEXT,
  payload         TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wechat_event_contract ON wechat_event(contract_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wechat_event_trade ON wechat_event(out_trade_no, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wechat_event_user ON wechat_event(user_sub, created_at DESC);
