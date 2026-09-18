-- Restore subscription scheduling independently of the payment API version.
-- Applied cleanup migrations remain immutable; payment/account history is untouched.
ALTER TABLE wechat_sub ADD COLUMN openid TEXT;
ALTER TABLE wechat_sub ADD COLUMN next_charge_at INTEGER;
ALTER TABLE wechat_sub ADD COLUMN cancel_requested_at INTEGER;
ALTER TABLE wechat_sub ADD COLUMN contract_query_at INTEGER;
ALTER TABLE wechat_txn ADD COLUMN charge_requested_at INTEGER;
ALTER TABLE wechat_txn ADD COLUMN processing_at INTEGER;
ALTER TABLE wechat_txn ADD COLUMN next_try_at INTEGER;
ALTER TABLE wechat_txn ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wechat_txn ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE wechat_txn ADD COLUMN last_error_at INTEGER;
ALTER TABLE wechat_attempt ADD COLUMN resubmit_count INTEGER NOT NULL DEFAULT 0;
UPDATE wechat_txn SET attempt_count=COALESCE((SELECT MAX(attempt_no) FROM wechat_attempt WHERE cycle_no=wechat_txn.out_trade_no),0);
-- Never automatically resume historical failed cycles whose retry policy was erased.
UPDATE wechat_attempt SET resubmit_count=3 WHERE status IN ('sending','unknown','accepted');
CREATE INDEX idx_wechat_sub_due ON wechat_sub(status,next_charge_at);
CREATE INDEX idx_wechat_contract_query ON wechat_sub(status,contract_query_at);
CREATE INDEX idx_wechat_txn_due ON wechat_txn(status,next_try_at);
