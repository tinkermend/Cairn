-- 0118：会话操作排队可解释性——记录最近一次未能领取的原因、上下文与评估时间。

ALTER TABLE "__SCHEMA__".session_operations
  ADD COLUMN IF NOT EXISTS wait_reason TEXT,
  ADD COLUMN IF NOT EXISTS wait_detail JSONB,
  ADD COLUMN IF NOT EXISTS last_claim_attempt_at TIMESTAMPTZ;
