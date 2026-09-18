-- V3-only cleanup. Deploy c3ea1bf (or a descendant) BEFORE applying this migration.
-- The compatible runtime works with both schemas. Older Workers that read/write
-- these retired fields must not be rolled back onto the migrated database.
-- Keep historical orders, agreement identifiers, payment kinds, audit events,
-- entitlement periods, and all credit/idempotency constraints intact.

DROP INDEX IF EXISTS idx_wechat_sub_due;
DROP INDEX IF EXISTS idx_wechat_txn_due;
DROP INDEX IF EXISTS idx_wechat_txn_settling;

ALTER TABLE wechat_sub DROP COLUMN openid;
ALTER TABLE wechat_sub DROP COLUMN next_charge_at;
ALTER TABLE wechat_txn DROP COLUMN charge_requested_at;
ALTER TABLE wechat_txn DROP COLUMN processing_at;
ALTER TABLE wechat_txn DROP COLUMN next_try_at;
ALTER TABLE wechat_txn DROP COLUMN attempt_count;
ALTER TABLE wechat_txn DROP COLUMN max_attempts;
ALTER TABLE wechat_txn DROP COLUMN last_error_at;
ALTER TABLE wechat_attempt DROP COLUMN resubmit_count;
