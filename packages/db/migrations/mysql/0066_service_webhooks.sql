-- 0082 的 MySQL 等价增量：调用方 Webhook 配置、异步投递事实与可恢复 claim。

CREATE TABLE service_webhooks (
  id CHAR(36) NOT NULL PRIMARY KEY,
  caller_id CHAR(36) NOT NULL,
  url VARCHAR(2048) NOT NULL,
  secret_id CHAR(36) NOT NULL,
  events JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  enabled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT service_webhooks_caller_fk
    FOREIGN KEY (caller_id) REFERENCES service_callers(id) ON DELETE CASCADE,
  CONSTRAINT service_webhooks_secret_fk
    FOREIGN KEY (secret_id) REFERENCES secrets(id) ON DELETE RESTRICT,
  CONSTRAINT service_webhooks_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT service_webhooks_caller_unique UNIQUE (caller_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE service_webhook_deliveries (
  id CHAR(36) NOT NULL PRIMARY KEY,
  webhook_id CHAR(36) NOT NULL,
  caller_id CHAR(36) NOT NULL,
  run_id CHAR(36) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  replay_count INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME(3) NULL,
  last_response_code INT NULL,
  last_response_body TEXT NULL,
  last_error VARCHAR(256) NULL,
  claim_owner VARCHAR(256) NULL,
  claim_instance CHAR(36) NULL,
  claim_epoch INT NOT NULL DEFAULT 0,
  claim_expires_at DATETIME(3) NULL,
  submitted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT service_webhook_deliveries_webhook_fk
    FOREIGN KEY (webhook_id) REFERENCES service_webhooks(id) ON DELETE CASCADE,
  CONSTRAINT service_webhook_deliveries_caller_fk
    FOREIGN KEY (caller_id) REFERENCES service_callers(id) ON DELETE CASCADE,
  CONSTRAINT service_webhook_deliveries_run_fk
    FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  CONSTRAINT service_webhook_deliveries_event_type_check
    CHECK (event_type IN ('run.started', 'run.completed', 'run.failed', 'run.cancelled')),
  CONSTRAINT service_webhook_deliveries_status_check
    CHECK (status IN ('pending', 'sending', 'retrying', 'success', 'dead_letter')),
  CONSTRAINT service_webhook_deliveries_attempts_check
    CHECK (attempts >= 0 AND max_attempts > 0 AND replay_count >= 0 AND claim_epoch >= 0),
  CONSTRAINT service_webhook_deliveries_response_code_check
    CHECK (last_response_code IS NULL OR (last_response_code >= 100 AND last_response_code <= 599)),
  CONSTRAINT service_webhook_deliveries_event_unique UNIQUE (webhook_id, run_id, event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX service_webhook_deliveries_due_idx
  ON service_webhook_deliveries (status, next_retry_at, id);
CREATE INDEX service_webhook_deliveries_claim_idx
  ON service_webhook_deliveries (status, claim_expires_at);
CREATE INDEX service_webhook_deliveries_caller_created_idx
  ON service_webhook_deliveries (caller_id, created_at, id);
