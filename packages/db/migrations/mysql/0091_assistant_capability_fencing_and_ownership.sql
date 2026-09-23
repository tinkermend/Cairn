-- 0091：平台助手轮次执行所有权与租约 fencing，模型调用增加所属操作者归属（MySQL 等价）。

ALTER TABLE assistant_turns
  ADD COLUMN owner_instance_id VARCHAR(64) NULL,
  ADD COLUMN lease_until DATETIME(3) NULL,
  ADD COLUMN epoch INT NOT NULL DEFAULT 0;

CREATE INDEX assistant_turns_lease_idx
  ON assistant_turns (status, lease_until);

ALTER TABLE platform_ai_calls
  ADD COLUMN owner_account_id VARCHAR(36) NULL,
  ADD CONSTRAINT fk_platform_ai_calls_owner FOREIGN KEY (owner_account_id) REFERENCES console_accounts(id) ON DELETE SET NULL;

CREATE INDEX platform_ai_calls_owner_idx
  ON platform_ai_calls (owner_account_id);
