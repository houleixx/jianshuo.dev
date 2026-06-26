CREATE TABLE IF NOT EXISTS engagement (
  share_id   TEXT NOT NULL,
  user_sub   TEXT NOT NULL,
  action     TEXT NOT NULL,          -- 'view' | 'finish' | 'like'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, user_sub, action)
);
CREATE INDEX IF NOT EXISTS idx_engagement_share ON engagement(share_id);
