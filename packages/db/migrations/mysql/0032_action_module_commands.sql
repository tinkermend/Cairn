-- 0048 的 MySQL 等价增量：动作模块升级/提炼/停用命令回执
CREATE TABLE action_module_command_receipts (
  id VARCHAR(36) NOT NULL,
  actor_id VARCHAR(36) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  command VARCHAR(32) NOT NULL,
  request_digest TEXT NOT NULL,
  module_id VARCHAR(36),
  scenario_id VARCHAR(36),
  response JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT action_module_command_receipts_pkey PRIMARY KEY (id),
  CONSTRAINT action_module_command_receipts_actor_fk FOREIGN KEY (actor_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT action_module_command_receipts_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE RESTRICT,
  CONSTRAINT action_module_command_receipts_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  CONSTRAINT action_module_command_receipts_command_check CHECK (
    command IN ('upgrade', 'batch_upgrade', 'extract', 'replace', 'disable_affected')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX action_module_command_receipts_actor_key_idx ON action_module_command_receipts (actor_id, idempotency_key);
CREATE INDEX action_module_command_receipts_module_idx ON action_module_command_receipts (module_id);
