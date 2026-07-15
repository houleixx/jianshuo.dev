-- 提示词社区帖：帖子类型列。存量全部是文章帖，DEFAULT 'article' 零影响。
ALTER TABLE community_posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'article';
