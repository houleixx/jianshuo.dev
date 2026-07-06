-- migrations/0003_mint.sql — 铸币事件表（投币等挣币玩法的业务事实源）
-- 钱不在这里：实际算力发放走 bucket/ledger（grantBucket），本表记事件 + 审计快照。
-- 价格分母 = 70 币永久底座 + 全表近 7 天 SUM(coins_uc)（所有 kind 共用一个池子一个价格）。
CREATE TABLE IF NOT EXISTS mint (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,              -- 'feed' | 未来: 'mp_like' | 'invite' | ...
  subject_key     TEXT NOT NULL,              -- 对象：feed = 文章 R2 key
  share_id        TEXT,                       -- feed 专用：社区 shareId（点亮态批查用）
  actor_sub       TEXT,                       -- 动作发起者 scope；外部玩法可 NULL
  beneficiary_sub TEXT NOT NULL,              -- 受益人（文章作者）scope
  coins_uc        INTEGER NOT NULL,           -- 本事件铸币总量（微金币，1 币 = 1e6 uc）
  price_uy        INTEGER NOT NULL,           -- 结算瞬间单币价格（微元/币，审计快照）
  actor_uy        INTEGER NOT NULL DEFAULT 0, -- 实付发起者（微元）
  beneficiary_uy  INTEGER NOT NULL,           -- 实付受益人（微元）
  detail          TEXT,                       -- 玩法私有字段 JSON（如 {"disc":0.7}）
  ts              INTEGER NOT NULL            -- ms epoch
);
-- 一人对一个对象一种玩法只能一次（UI「点亮」的真正执行层，防 API 重放/并发连点）。
-- SQLite 唯一索引里 NULL 互不相等：外部玩法（actor NULL）的去重靠 subject_key 自身
-- 构造承担，如 'mp_like:<url>:<date>'。
CREATE UNIQUE INDEX IF NOT EXISTS idx_mint_once  ON mint (kind, subject_key, actor_sub);
CREATE INDEX        IF NOT EXISTS idx_mint_ts    ON mint (ts);                          -- 7天窗口 + 当日保险丝
CREATE INDEX        IF NOT EXISTS idx_mint_pair  ON mint (beneficiary_sub, actor_sub);  -- 同对递减
CREATE INDEX        IF NOT EXISTS idx_mint_share ON mint (share_id);                    -- 点亮态批查
