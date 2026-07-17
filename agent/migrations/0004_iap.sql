-- 0004_iap.sql — 苹果订阅（P3）：交易幂等表 + 订阅链绑定表。
-- spec: docs/superpowers/specs/2026-06-30-voicedrop-subscription-credits-design.md §5.4
-- plan: docs/superpowers/plans/2026-07-17-voicedrop-subscription-p3p4.md

-- 每笔苹果交易（首购/每月续费各一个 transaction_id）只入账一次。
CREATE TABLE IF NOT EXISTS iap_txn (
  transaction_id  TEXT PRIMARY KEY,     -- 苹果每周期唯一 id（幂等键）
  original_txn_id TEXT,                 -- 同一订阅链固定
  user_sub        TEXT NOT NULL,
  product_id      TEXT,
  expires_date    INTEGER,              -- 苹果给的本周期到期时间 (ms)
  environment     TEXT,                 -- 'Production' | 'Sandbox'
  bucket_id       INTEGER,              -- 本次发放的桶（退款回收用；未发放为 NULL）
  processed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_iap_txn_orig ON iap_txn(original_txn_id);

-- 订阅链 ↔ VoiceDrop 账号绑定（first-claim-wins）+ 状态缓存（status 端点直读）。
CREATE TABLE IF NOT EXISTS iap_sub (
  original_txn_id TEXT PRIMARY KEY,
  user_sub        TEXT NOT NULL,
  product_id      TEXT,
  expires_date    INTEGER,              -- 最新已知到期时间 (ms)
  status          TEXT,                 -- 'active' | 'revoked'（展示用，过期靠时间判断）
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_iap_sub_user ON iap_sub(user_sub);
