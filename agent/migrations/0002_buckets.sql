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

-- 回填：把每个非零余额迁成一个「1 年后过期」的 migrated 桶。
-- 保留老用户既有余额，但时间盒子（符合新「万物有过期」模型），不留永久负债。
-- expires_at = 迁移时刻 + 365 天；SQLite strftime('%s','now') 是秒，*1000 转毫秒，31536000000 = 365*86400000。
INSERT INTO bucket (user_sub, amount_uy, remaining_uy, source, created_at, expires_at)
SELECT user_sub, balance_uy, balance_uy, 'migrated', updated_at,
       (CAST(strftime('%s','now') AS INTEGER) * 1000 + 31536000000)
FROM account WHERE balance_uy <> 0;
