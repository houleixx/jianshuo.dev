-- Link restored authorization to an actual paid order. Signing must never mint credit or extend coverage.
ALTER TABLE wechat_sub ADD COLUMN resume_order TEXT REFERENCES wechat_txn(out_trade_no);
ALTER TABLE wechat_sub ADD COLUMN renewal_amount_fen INTEGER CHECK (renewal_amount_fen > 0);
