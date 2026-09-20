-- 0083：修复曾记录 0082 但未实际创建表的本地/预发布环境。
-- 全新环境已由 0082 建好同一结构；IF NOT EXISTS 让本增量安全地成为空操作。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".service_webhooks (
  id UUID PRIMARY KEY,
  caller_id UUID NOT NULL REFERENCES "__SCHEMA__".service_callers(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret_id UUID NOT NULL REFERENCES "__SCHEMA__".secrets(id) ON DELETE RESTRICT,
  events JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  enabled_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT service_webhooks_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS "__SCHEMA__".service_webhook_deliveries (
  id UUID PRIMARY KEY,
  webhook_id UUID NOT NULL REFERENCES "__SCHEMA__".service_webhooks(id) ON DELETE CASCADE,
  caller_id UUID NOT NULL REFERENCES "__SCHEMA__".service_callers(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  replay_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ(3),
  last_response_code INTEGER,
  last_response_body TEXT,
  last_error TEXT,
  claim_owner TEXT,
  claim_instance UUID,
  claim_epoch INTEGER NOT NULL DEFAULT 0,
  claim_expires_at TIMESTAMPTZ(3),
  submitted_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT service_webhook_deliveries_event_type_check
    CHECK (event_type IN ('run.started', 'run.completed', 'run.failed', 'run.cancelled')),
  CONSTRAINT service_webhook_deliveries_status_check
    CHECK (status IN ('pending', 'sending', 'retrying', 'success', 'dead_letter')),
  CONSTRAINT service_webhook_deliveries_attempts_check
    CHECK (attempts >= 0 AND max_attempts > 0 AND replay_count >= 0 AND claim_epoch >= 0),
  CONSTRAINT service_webhook_deliveries_response_code_check
    CHECK (last_response_code IS NULL OR (last_response_code >= 100 AND last_response_code <= 599))
);

CREATE UNIQUE INDEX IF NOT EXISTS service_webhooks_caller_idx
  ON "__SCHEMA__".service_webhooks (caller_id);
CREATE UNIQUE INDEX IF NOT EXISTS service_webhook_deliveries_event_idx
  ON "__SCHEMA__".service_webhook_deliveries (webhook_id, run_id, event_type);
CREATE INDEX IF NOT EXISTS service_webhook_deliveries_due_idx
  ON "__SCHEMA__".service_webhook_deliveries (status, next_retry_at, id);
CREATE INDEX IF NOT EXISTS service_webhook_deliveries_claim_idx
  ON "__SCHEMA__".service_webhook_deliveries (status, claim_expires_at);
CREATE INDEX IF NOT EXISTS service_webhook_deliveries_caller_created_idx
  ON "__SCHEMA__".service_webhook_deliveries (caller_id, created_at, id);
