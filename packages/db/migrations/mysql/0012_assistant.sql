CREATE TABLE assistant_conversations (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  owner_account_id VARCHAR(36) NOT NULL,
  title TEXT NOT NULL,
  idempotency_key VARCHAR(128),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_active_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (owner_account_id) REFERENCES console_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX assistant_conversations_owner_idem_idx
  ON assistant_conversations (owner_account_id, idempotency_key);

CREATE INDEX assistant_conversations_owner_active_idx
  ON assistant_conversations (owner_account_id, last_active_at);

CREATE TABLE assistant_turns (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  owner_account_id VARCHAR(36) NOT NULL,
  client_turn_id VARCHAR(128) NOT NULL,
  parent_turn_id VARCHAR(36),
  request_digest VARCHAR(64) NOT NULL,
  question TEXT NOT NULL,
  capability_id VARCHAR(64),
  slots JSON,
  status VARCHAR(32) NOT NULL,
  deadline_at DATETIME(3) NOT NULL,
  processing_token VARCHAR(64) NOT NULL,
  result JSON,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  inflight_owner VARCHAR(36) GENERATED ALWAYS AS (CASE WHEN status = 'RUNNING' THEN owner_account_id ELSE NULL END) VIRTUAL,
  CONSTRAINT assistant_turns_status CHECK (status IN ('RUNNING','CLARIFY','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_account_id) REFERENCES console_accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX assistant_turns_conversation_client_idx
  ON assistant_turns (conversation_id, client_turn_id);

CREATE UNIQUE INDEX assistant_turns_owner_running_idx
  ON assistant_turns (inflight_owner);

CREATE INDEX assistant_turns_owner_status_idx
  ON assistant_turns (owner_account_id, status);

CREATE TABLE platform_ai_calls (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  turn_id VARCHAR(36),
  seq INTEGER NOT NULL,
  purpose VARCHAR(32) NOT NULL,
  config_revision INTEGER,
  model VARCHAR(256),
  prompt_version VARCHAR(64),
  reserved_tokens INTEGER,
  `usage` JSON,
  error TEXT,
  duration_ms INTEGER,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (turn_id) REFERENCES assistant_turns(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX platform_ai_calls_created_idx ON platform_ai_calls (created_at);

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'ai:assist' FROM console_roles WHERE kind = 'system';
