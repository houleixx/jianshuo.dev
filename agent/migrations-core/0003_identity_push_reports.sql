-- 存储迁移 P3：身份绑定 / 用户档案 / push token / 举报记录迁 D1。
-- 原 R2 对象：links/apple-*.json、links/wechat-*.json、users/<sub>/ACCOUNT.json、
-- users/<sub>/push-token.json、community/reports/<shareId>.json。

-- 身份 → 数据箱映射（原 links/<provider>-<extId>.json → {scope, linkedAt}）。
-- external_id = link key 里的 id 段（apple: sanitizeSeg(sub)；wechat: unionid-/openid- 前缀）。
-- first-write-wins：绑定后不改（登录只读它找回既有 scope）。
CREATE TABLE identities (
  provider TEXT NOT NULL,        -- 'apple' | 'wechat'
  external_id TEXT NOT NULL,
  user_sub TEXT NOT NULL,        -- users/<sub>/ scope
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, external_id)
);
CREATE INDEX idx_identities_user ON identities(user_sub);

-- 用户档案（原 ACCOUNT.json）。RMW 合并 → 行级列更新。
-- 社区写门槛 hasVerifiedBinding 读它（apple_sub/wechat_openid/wechat_unionid 任一非空）。
CREATE TABLE user_profiles (
  user_sub TEXT PRIMARY KEY,
  apple_sub TEXT,
  wechat_openid TEXT,
  wechat_unionid TEXT,
  email TEXT,
  name TEXT,
  avatar TEXT,
  linked_at INTEGER,
  wechat_linked_at INTEGER,
  last_seen_at INTEGER
);

-- APNs 设备 token（原 push-token.json）。sendPush 读；410 删。
CREATE TABLE push_tokens (
  user_sub TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  env TEXT,                      -- 'dev' | 'prod'
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 社区举报（原 community/reports/<shareId>.json）。行存在 = 帖被隐藏（Apple 1.2）。
-- reporters 是 [{by,at,reason}] JSON（去重追加）。community_posts.hidden 由 report
-- 增删同步维护，本表是举报明细的权威。
CREATE TABLE community_reports (
  share_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  first_at INTEGER NOT NULL,
  reporters TEXT NOT NULL DEFAULT '[]'
);
