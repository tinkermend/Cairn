-- 平台助手会话、轮次、模型调用记录；系统角色补 ai:assist。

CREATE TABLE "__SCHEMA__".assistant_conversations (
  id UUID PRIMARY KEY,
  owner_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX assistant_conversations_owner_idem_idx
  ON "__SCHEMA__".assistant_conversations (owner_account_id, idempotency_key);

CREATE INDEX assistant_conversations_owner_active_idx
  ON "__SCHEMA__".assistant_conversations (owner_account_id, last_active_at);

CREATE TABLE "__SCHEMA__".assistant_turns (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES "__SCHEMA__".assistant_conversations(id) ON DELETE CASCADE,
  owner_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE CASCADE,
  client_turn_id TEXT NOT NULL,
  parent_turn_id UUID,
  request_digest TEXT NOT NULL,
  question TEXT NOT NULL,
  capability_id TEXT,
  slots JSONB,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','CLARIFY','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  deadline_at TIMESTAMPTZ NOT NULL,
  processing_token TEXT NOT NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX assistant_turns_conversation_client_idx
  ON "__SCHEMA__".assistant_turns (conversation_id, client_turn_id);

CREATE UNIQUE INDEX assistant_turns_owner_running_idx
  ON "__SCHEMA__".assistant_turns (owner_account_id)
  WHERE status = 'RUNNING';

CREATE INDEX assistant_turns_owner_status_idx
  ON "__SCHEMA__".assistant_turns (owner_account_id, status);

CREATE TABLE "__SCHEMA__".platform_ai_calls (
  id UUID PRIMARY KEY,
  turn_id UUID REFERENCES "__SCHEMA__".assistant_turns(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  config_revision INTEGER,
  model TEXT,
  prompt_version TEXT,
  reserved_tokens INTEGER,
  usage JSONB,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX platform_ai_calls_created_idx
  ON "__SCHEMA__".platform_ai_calls (created_at);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, 'ai:assist'
FROM "__SCHEMA__".console_roles r
WHERE r.kind = 'system'
ON CONFLICT DO NOTHING;
