-- voicedrop-core：把 R2 上「索引/计数/指针」类小 JSON 迁进 D1（P1 四件套）。
-- 原则：R2 仍是 blob 真源；这里只放本该是数据库行的状态。详见 2026-07-20 存储排查。

-- 归因 IP 指纹（原 refhits/<fp>/<ts> 对象树；一条 SELECT 取代 list+80 GET）。
-- fingerprint = ipHash() 输出（明文调试期是 IP，翻回后是 HMAC 截断，两者皆可存）。
-- 保留 2 天，由 worker cron 清理（对齐原 R2 lifecycle）。
CREATE TABLE refhits (
  fingerprint TEXT NOT NULL,
  ts INTEGER NOT NULL,
  owner TEXT NOT NULL,          -- users/<sub>/ scope
  token TEXT,                   -- 来源分享码/邀请码（≤16 字符）
  PRIMARY KEY (fingerprint, ts)
);
CREATE INDEX idx_refhits_ts ON refhits(ts);
CREATE INDEX idx_refhits_owner ON refhits(owner);

-- 邀请码（原 invites/<CODE> 对象）。
CREATE TABLE invites (
  code TEXT PRIMARY KEY,        -- 大写归一
  owner TEXT NOT NULL,          -- users/<sub>/ scope
  name TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX idx_invites_owner ON invites(owner);

-- 分享码计数（shares/<code> 正文仍在 R2；计数上移 D1 做原子自增，
-- 消灭 prompt-routes.js importCount RMW 丢计数）。
CREATE TABLE share_stats (
  code TEXT PRIMARY KEY,
  import_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 提示词分享码的 owner 索引（原 users/<sub>/prompt-shares.json 的 byItem+mintLog；
-- RMW 丢更新风险最高的一处）。每日铸码上限 = COUNT(created_at 当日)。
CREATE TABLE prompt_shares (
  user_sub TEXT NOT NULL,       -- users/<sub>/ scope
  item_id TEXT NOT NULL,
  code TEXT NOT NULL,           -- 7 位数字码
  created_at TEXT NOT NULL,     -- ISO 字符串（沿用原索引格式）
  PRIMARY KEY (user_sub, item_id)
);
CREATE UNIQUE INDEX idx_prompt_shares_code ON prompt_shares(code);
