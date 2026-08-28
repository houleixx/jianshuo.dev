-- 15 分钟订阅任务会恢复超过处理时限的结算订单；避免订单历史增长后扫描整张表。
CREATE INDEX IF NOT EXISTS idx_wechat_txn_settling ON wechat_txn(status, processing_at);
