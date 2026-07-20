-- 存储迁移 P2：文章摘要索引 + 录音索引迁 D1（原 users/<sub>/articles-index.json
-- 与 recordings-index.json 两个 RMW 小 JSON）。
-- entry 列原样存 R2 索引里的 entry JSON（{stem,title,head,createdAt,updatedAt,count,tags?}），
-- 不拆字段——GET /articles 返回给客户端的 JSON 与老路径逐字节一致。
-- created_ms 仅作排序键（articleTime() 归一）。R2 listing 仍是权威：
-- reconcile 对账在修 R2 索引的同时整体回写这两张表。

CREATE TABLE articles (
  user_sub TEXT NOT NULL,        -- users/<sub>/ scope
  stem TEXT NOT NULL,
  entry TEXT,                    -- 摘要 entry JSON；NULL = 只有 sidecar 标记的条目
  fp TEXT,                       -- R2 etag 指纹（对账判 stale 用，与 R2 索引同源）
  created_ms INTEGER NOT NULL DEFAULT 0,
  flag_empty INTEGER NOT NULL DEFAULT 0,
  flag_blocked INTEGER NOT NULL DEFAULT 0,
  flag_tags INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_sub, stem)
);
CREATE INDEX idx_articles_user_created ON articles(user_sub, created_ms DESC);

CREATE TABLE recordings (
  user_sub TEXT NOT NULL,
  leaf TEXT NOT NULL,            -- "VoiceDrop-….m4a"
  uploaded TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_sub, leaf)
);
