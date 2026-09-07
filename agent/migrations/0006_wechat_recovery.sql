-- Ambiguous legacy partial grants cannot be repaired by guessing the newest bucket.
CREATE TABLE IF NOT EXISTS wechat_recovery_preflight (ok INTEGER CHECK(ok=1));
INSERT INTO wechat_recovery_preflight SELECT CASE WHEN EXISTS(
 SELECT 1 FROM wechat_txn t WHERE
 (t.bucket_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ledger l WHERE l.reason='subscription' AND json_extract(l.detail,'$.provider')='wechat' AND json_extract(l.detail,'$.out_trade_no')=t.out_trade_no))
 OR (t.bucket_id IS NULL AND EXISTS(SELECT 1 FROM ledger l WHERE l.reason='subscription' AND json_extract(l.detail,'$.provider')='wechat' AND json_extract(l.detail,'$.out_trade_no')=t.out_trade_no))
 OR (t.status!='paid' AND EXISTS(SELECT 1 FROM bucket b WHERE b.user_sub=t.user_sub AND b.source='subscription'
 AND NOT EXISTS(SELECT 1 FROM wechat_txn w WHERE w.bucket_id=b.id)
 AND NOT EXISTS(SELECT 1 FROM iap_txn i WHERE i.bucket_id=b.id)))
) THEN 0 ELSE 1 END;
DROP TABLE wechat_recovery_preflight;
-- Stop and reconcile historical duplicates before applying this migration; never delete paid history.
CREATE UNIQUE INDEX idx_wechat_one_live_contract ON wechat_sub(user_sub) WHERE status IN ('pending','active');
CREATE UNIQUE INDEX idx_wechat_user_cycle ON wechat_txn(user_sub,period_start_at);
ALTER TABLE wechat_txn ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE wechat_txn ADD COLUMN entitlement_start_at INTEGER;
ALTER TABLE wechat_txn ADD COLUMN entitlement_end_at INTEGER;
ALTER TABLE bucket ADD COLUMN wechat_order TEXT;
CREATE UNIQUE INDEX idx_bucket_wechat_order ON bucket(wechat_order) WHERE wechat_order IS NOT NULL;
CREATE UNIQUE INDEX idx_ledger_wechat_order ON ledger(json_extract(detail,'$.out_trade_no'))
 WHERE reason='subscription' AND json_extract(detail,'$.provider')='wechat';
UPDATE bucket SET wechat_order=(SELECT out_trade_no FROM wechat_txn WHERE bucket_id=bucket.id)
 WHERE id IN (SELECT bucket_id FROM wechat_txn WHERE bucket_id IS NOT NULL);
UPDATE wechat_txn SET status='paid' WHERE bucket_id IS NOT NULL;
UPDATE wechat_txn SET entitlement_start_at=period_start_at,entitlement_end_at=period_end_at WHERE status='paid';
-- wechat_txn is the logical user billing cycle; attempts are immutable merchant orders.
CREATE TABLE wechat_attempt (
 out_trade_no TEXT PRIMARY KEY,
 cycle_no TEXT NOT NULL,
 contract_code TEXT NOT NULL,
 contract_id TEXT NOT NULL,
 status TEXT NOT NULL, -- sending|unknown|accepted|failed|paid|refunded
 attempt_no INTEGER NOT NULL,
 resubmit_count INTEGER NOT NULL DEFAULT 0,
 next_query_at INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(cycle_no,attempt_no)
);
CREATE INDEX idx_wechat_attempt_query ON wechat_attempt(status,next_query_at);
CREATE UNIQUE INDEX idx_wechat_attempt_open ON wechat_attempt(cycle_no) WHERE status IN ('sending','unknown','accepted','paid','refunded');
-- Old failures may have reached WeChat. Treat all submitted non-paid orders as unknown until queried.
INSERT INTO wechat_attempt(out_trade_no,cycle_no,contract_code,contract_id,status,attempt_no,next_query_at,created_at,updated_at)
 SELECT t.out_trade_no,t.out_trade_no,t.contract_code,s.contract_id,
 CASE WHEN t.status='paid' THEN 'paid' ELSE 'unknown' END,
 MAX(t.attempt_count,1),CASE WHEN t.status='paid' THEN NULL ELSE 0 END,t.created_at,t.updated_at
 FROM wechat_txn t JOIN wechat_sub s ON s.contract_code=t.contract_code
 WHERE t.status IN ('charging','settling','paid') OR t.attempt_count>0;
UPDATE wechat_txn SET status='charging',next_try_at=NULL WHERE status!='paid' AND out_trade_no IN (SELECT cycle_no FROM wechat_attempt);

-- Recovered legacy grants also restore the paid coverage snapshot without reactivating a cancelled agreement.
UPDATE wechat_sub SET
 period_start_at=(SELECT MAX(entitlement_start_at) FROM wechat_txn WHERE contract_code=wechat_sub.contract_code AND status='paid'),
 period_end_at=(SELECT MAX(entitlement_end_at) FROM wechat_txn WHERE contract_code=wechat_sub.contract_code AND status='paid'),
 next_charge_at=CASE WHEN status='active' THEN MAX(0, CAST(((SELECT MAX(entitlement_end_at) FROM wechat_txn WHERE contract_code=wechat_sub.contract_code AND status='paid')+28800000)/86400000 AS INTEGER)*86400000-28800000-3*86400000+7200000) ELSE NULL END
 WHERE EXISTS(SELECT 1 FROM wechat_txn WHERE contract_code=wechat_sub.contract_code AND status='paid');
