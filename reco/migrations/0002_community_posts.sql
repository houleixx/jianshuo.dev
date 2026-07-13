-- 社区展示索引（2026-07-14）：R2 community/*.json 仍是真源，这张表只是可随时
-- 全量重建的物化索引（files API 在 share/unshare/report/详情打开时双写，
-- POST /files/api/community/reindex 全量重建）。/reco/feed 一条查询出整个列表页。
CREATE TABLE IF NOT EXISTS community_posts (
  share_id        TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,           -- users/<sub>/
  article_key     TEXT,                    -- schema-2 指针；legacy schema-1 为 NULL
  author          TEXT,
  title           TEXT,
  preview         TEXT,                    -- 正文前 ~60 字纯文本
  cover_photo_key TEXT,                    -- 第一张图完整 R2 key（owner 已拼）
  has_photo       INTEGER NOT NULL DEFAULT 0,
  article_count   INTEGER NOT NULL DEFAULT 1,
  first_shared_at INTEGER,
  updated_at      INTEGER,
  reply_to        TEXT,
  hidden          INTEGER NOT NULL DEFAULT 0   -- 被举报即隐藏（与 R2 report 标记同步）
);
CREATE INDEX IF NOT EXISTS idx_posts_feed  ON community_posts(hidden, first_shared_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_owner ON community_posts(owner);
