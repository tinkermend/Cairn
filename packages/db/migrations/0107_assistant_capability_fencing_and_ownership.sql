-- 0107：平台助手轮次执行所有权与租约 fencing，模型调用增加所属操作者归属。

ALTER TABLE "__SCHEMA__".assistant_turns
  ADD COLUMN owner_instance_id TEXT,
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;

CREATE INDEX assistant_turns_lease_idx
  ON "__SCHEMA__".assistant_turns (status, lease_until);

ALTER TABLE "__SCHEMA__".platform_ai_calls
  ADD COLUMN owner_account_id UUID REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE SET NULL;

CREATE INDEX platform_ai_calls_owner_idx
  ON "__SCHEMA__".platform_ai_calls (owner_account_id);
