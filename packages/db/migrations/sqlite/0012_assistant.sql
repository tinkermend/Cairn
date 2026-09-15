CREATE TABLE assistant_conversations (
  id TEXT NOT NULL PRIMARY KEY,
  owner_account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  FOREIGN KEY (owner_account_id) REFERENCES console_accounts(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX assistant_conversations_owner_idem_idx
  ON assistant_conversations (owner_account_id, idempotency_key);

CREATE INDEX assistant_conversations_owner_active_idx
  ON assistant_conversations (owner_account_id, last_active_at);

CREATE TABLE assistant_turns (
  id TEXT NOT NULL PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  client_turn_id TEXT NOT NULL,
  parent_turn_id TEXT,
  request_digest TEXT NOT NULL,
  question TEXT NOT NULL,
  capability_id TEXT,
  slots TEXT,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','CLARIFY','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  deadline_at TEXT NOT NULL,
  processing_token TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_account_id) REFERENCES console_accounts(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX assistant_turns_conversation_client_idx
  ON assistant_turns (conversation_id, client_turn_id);

CREATE UNIQUE INDEX assistant_turns_owner_running_idx
  ON assistant_turns (owner_account_id) WHERE status = 'RUNNING';

CREATE INDEX assistant_turns_owner_status_idx
  ON assistant_turns (owner_account_id, status);

CREATE TABLE platform_ai_calls (
  id TEXT NOT NULL PRIMARY KEY,
  turn_id TEXT,
  seq INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  config_revision INTEGER,
  model TEXT,
  prompt_version TEXT,
  reserved_tokens INTEGER,
  usage TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES assistant_turns(id) ON DELETE SET NULL
);

CREATE INDEX platform_ai_calls_created_idx ON platform_ai_calls (created_at);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'ai:assist' FROM console_roles WHERE kind = 'system';
