-- 0118 的 MySQL 等价增量：会话操作排队可解释性——记录最近一次未能领取的原因、上下文与评估时间。

ALTER TABLE session_operations
  ADD COLUMN wait_reason VARCHAR(64) NULL,
  ADD COLUMN wait_detail JSON NULL,
  ADD COLUMN last_claim_attempt_at DATETIME(3) NULL;
