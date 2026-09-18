-- Prepare the original V2 columns before deploying the compact runtime.
-- No columns are removed here: the currently deployed runtime remains compatible.
UPDATE wechat_sub SET cancel_reason='user-request-pending',next_charge_at=NULL
 WHERE cancel_requested_at IS NOT NULL AND status IN ('pending','active');
UPDATE wechat_sub SET last_event_at=contract_query_at-900000 WHERE contract_query_at IS NOT NULL;

-- An authorization's agreed next-cycle amount belongs on its unpaid order.
-- Existing paid orders, attempts, balances and entitlement dates remain unchanged.
WITH pending AS (
 SELECT s.rowid AS sub_rowid,s.contract_code,s.user_sub,s.plan_id,s.period_end_at AS boundary,
        s.renewal_amount_fen AS amount_fen,s.next_charge_at,s.created_at,s.updated_at
 FROM wechat_sub s
 WHERE s.resume_order IS NOT NULL AND s.renewal_amount_fen>0 AND s.period_end_at IS NOT NULL
   AND s.status IN ('pending','active')
   AND EXISTS(SELECT 1 FROM wechat_txn p WHERE p.out_trade_no=s.resume_order AND p.user_sub=s.user_sub AND p.status='paid')
   AND NOT EXISTS(SELECT 1 FROM wechat_txn t WHERE t.contract_code=s.contract_code AND t.payment_kind='deduct')
)
INSERT OR IGNORE INTO wechat_txn(out_trade_no,contract_code,user_sub,plan_id,period_start_at,period_end_at,
 amount_fen,status,next_try_at,created_at,updated_at)
SELECT 'wdr'||printf('%029d',sub_rowid),contract_code,user_sub,plan_id,boundary,
 -- Match addCalendarMonth: clamp the day to the last day of the next UTC month, preserving time/milliseconds.
 CAST(strftime('%s',boundary/1000,'unixepoch','start of month','+1 month') AS INTEGER)*1000
   +(MIN(CAST(strftime('%d',boundary/1000,'unixepoch') AS INTEGER),
          CAST(strftime('%d',boundary/1000,'unixepoch','start of month','+2 months','-1 day') AS INTEGER))-1)*86400000
   +(boundary%86400000),
 amount_fen,'pending',COALESCE(next_charge_at,CAST((boundary+28800000)/86400000 AS INTEGER)*86400000-280800000),created_at,updated_at
FROM pending;
