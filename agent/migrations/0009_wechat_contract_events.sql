-- Payment timestamps and agreement timestamps describe separate state machines.
-- Existing agreements remain unverified until a signed V3 agreement result arrives.
ALTER TABLE wechat_sub ADD COLUMN contract_event_at INTEGER;
ALTER TABLE wechat_sub ADD COLUMN contract_verified_at INTEGER;

-- A definitively failed checkout grants no cycle. A replacement may target the
-- same future coverage boundary; paid and unresolved cycles must remain unique.
-- Never release this constraint merely on a timeout or an unverified response.
DROP INDEX idx_wechat_user_cycle;
CREATE UNIQUE INDEX idx_wechat_user_cycle ON wechat_txn(user_sub,period_start_at)
  WHERE status != 'failed';
