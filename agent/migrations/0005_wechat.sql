-- migrations/0005_wechat.sql — 微信支付：V2 首期支付并签约及订阅生命周期
-- 空库按 0001–0005 顺序初始化；本脚本不用于升级已执行过旧版微信迁移的数据库。
-- 钱仍由 bucket/ledger 统一记账；复用 V2 字段，仅为 APP 支付并签约增加四个订单字段。

CREATE TABLE IF NOT EXISTS wechat_sub (
  contract_code     TEXT PRIMARY KEY,       -- 商户生成、签约前先落库的唯一标识
  contract_id       TEXT UNIQUE,            -- 微信签约成功后回调的委托代扣协议号
  user_sub          TEXT NOT NULL,
  plan_id           TEXT NOT NULL,          -- 微信审核通过的委托代扣模板 ID
  openid            TEXT,
  status            TEXT NOT NULL,          -- pending|active|cancelled|expired
  period_start_at   INTEGER,                -- 当前（已付款）周期起点，ms epoch
  period_end_at     INTEGER,                -- 当前周期终点，按自然月计算，ms epoch
  next_charge_at    INTEGER,                -- 下一次发起扣费申请的时间（到期前三个北京时间自然日 02:00）
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
  out_trade_no       TEXT PRIMARY KEY,      -- 逻辑周期编号；跨协议保持同一用户周期唯一
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
  max_attempts       INTEGER NOT NULL DEFAULT 3,
  entitlement_start_at INTEGER,
  entitlement_end_at INTEGER,
  failure_code       TEXT,
  last_error_at      INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  payment_kind       TEXT NOT NULL DEFAULT 'deduct', -- app 首期支付；deduct 后续代扣
  prepay_id          TEXT,                  -- APP 调起支付的预支付标识
  checkout_expires_at INTEGER,              -- 首期支付订单过期时间，ms epoch
  request_serial     TEXT,                  -- 支付并签约请求序号
  UNIQUE(contract_code, period_start_at)
);
CREATE INDEX IF NOT EXISTS idx_wechat_txn_due ON wechat_txn(status, next_try_at);
CREATE INDEX IF NOT EXISTS idx_wechat_txn_contract ON wechat_txn(contract_code, period_start_at);
-- 保留处理状态索引，便于审计与故障排查。
CREATE INDEX IF NOT EXISTS idx_wechat_txn_settling ON wechat_txn(status, processing_at);

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

-- 功能首次上线即采用最终表结构，不需要兼容历史微信订单。
CREATE UNIQUE INDEX idx_wechat_one_live_contract ON wechat_sub(user_sub) WHERE status IN ('pending','active');
-- 已明确失败的周期允许重新签约后重建；仍在处理和已付款周期保持唯一。
CREATE UNIQUE INDEX idx_wechat_user_cycle ON wechat_txn(user_sub,period_start_at) WHERE status != 'failed';
ALTER TABLE bucket ADD COLUMN wechat_order TEXT;
CREATE UNIQUE INDEX idx_bucket_wechat_order ON bucket(wechat_order) WHERE wechat_order IS NOT NULL;
CREATE UNIQUE INDEX idx_ledger_wechat_order ON ledger(json_extract(detail,'$.out_trade_no'))
 WHERE reason='subscription' AND json_extract(detail,'$.provider')='wechat';
-- wechat_txn is the logical user billing cycle; attempts are immutable merchant orders.
CREATE TABLE wechat_attempt (
 out_trade_no TEXT PRIMARY KEY,
 cycle_no TEXT NOT NULL,
 contract_code TEXT NOT NULL,
 contract_id TEXT NOT NULL,
 status TEXT NOT NULL, -- sending|unknown|accepted|failed|paid|refunded
 attempt_no INTEGER NOT NULL,
 resubmit_count INTEGER NOT NULL DEFAULT 0,
 next_query_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(cycle_no,attempt_no)
);
CREATE INDEX idx_wechat_attempt_query ON wechat_attempt(status,next_query_at);
CREATE UNIQUE INDEX idx_wechat_attempt_open ON wechat_attempt(cycle_no) WHERE status IN ('sending','unknown','accepted','paid','refunded');
