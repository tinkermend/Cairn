-- 0048：动作模块升级/提炼/停用命令回执
CREATE TABLE "__SCHEMA__".action_module_command_receipts (
  id UUID PRIMARY KEY,
  actor_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  command TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  module_id UUID REFERENCES "__SCHEMA__".action_modules(id) ON DELETE RESTRICT,
  scenario_id UUID REFERENCES "__SCHEMA__".scenarios(id) ON DELETE RESTRICT,
  response JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT action_module_command_receipts_command_check CHECK (
    command IN ('upgrade', 'batch_upgrade', 'extract', 'replace', 'disable_affected')
  )
);
CREATE UNIQUE INDEX action_module_command_receipts_actor_key_idx
  ON "__SCHEMA__".action_module_command_receipts (actor_id, idempotency_key);
CREATE INDEX action_module_command_receipts_module_idx
  ON "__SCHEMA__".action_module_command_receipts (module_id);
