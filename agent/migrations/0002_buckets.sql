-- migrations/0002_buckets.sql — 算力分桶账本
CREATE TABLE IF NOT EXISTS bucket (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_sub     TEXT NOT NULL,
  amount_uy    INTEGER NOT NULL,        -- 到账原始额度（微元）
  remaining_uy INTEGER NOT NULL,        -- 剩余，扣费递减；透支可为负
  source       TEXT NOT NULL,           -- 'signup'|'subscription'|'campaign:<id>'|'migrated'|'overdraft'
  created_at   INTEGER NOT NULL,        -- ms epoch
  expires_at   INTEGER                  -- ms epoch；NULL = 永不过期
);
CREATE INDEX IF NOT EXISTS idx_bucket_user_exp ON bucket(user_sub, expires_at);

-- 回填：把每个非零余额迁成一个永不过期的桶（不给既有余额追加过期日，避免意外清零）
INSERT INTO bucket (user_sub, amount_uy, remaining_uy, source, created_at, expires_at)
SELECT user_sub, balance_uy, balance_uy, 'migrated', updated_at, NULL
FROM account WHERE balance_uy <> 0;
