-- 0048 的 SQLite 等价增量：动作模块升级/提炼/停用命令回执
CREATE TABLE action_module_command_receipts (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES console_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command IN ('upgrade', 'batch_upgrade', 'extract', 'replace', 'disable_affected')),
  request_digest TEXT NOT NULL,
  module_id TEXT REFERENCES action_modules(id) ON DELETE RESTRICT,
  scenario_id TEXT REFERENCES scenarios(id) ON DELETE RESTRICT,
  response TEXT NOT NULL CHECK (json_valid(response)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX action_module_command_receipts_actor_key_idx ON action_module_command_receipts (actor_id, idempotency_key);
CREATE INDEX action_module_command_receipts_module_idx ON action_module_command_receipts (module_id);
