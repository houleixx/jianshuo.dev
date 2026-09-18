-- V3 首期支付并签约。后续代扣共用原有周期、订单及入账防重约束。
ALTER TABLE wechat_sub ADD COLUMN sign_mode TEXT NOT NULL DEFAULT 'pure';
ALTER TABLE wechat_txn ADD COLUMN payment_kind TEXT NOT NULL DEFAULT 'deduct';
ALTER TABLE wechat_txn ADD COLUMN prepay_id TEXT;
ALTER TABLE wechat_txn ADD COLUMN checkout_expires_at INTEGER;
ALTER TABLE wechat_txn ADD COLUMN request_serial TEXT;
