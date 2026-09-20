-- 0063：RM-D 告警实例。规则与渠道仍在平台配置文档，这里只存判定与投递事实。
-- 未恢复行用可空 open_key 做唯一约束，resolved 后置空，PG / MySQL 行为一致。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".monitoring_alerts (
  id UUID PRIMARY KEY,
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  state TEXT NOT NULL,
  severity TEXT NOT NULL,
  kind TEXT NOT NULL,
  metric_key TEXT,
  stale_source TEXT,
  comparator TEXT,
  threshold DOUBLE PRECISION,
  condition_opened_at TIMESTAMPTZ NOT NULL,
  fired_at TIMESTAMPTZ,
  recovery_opened_at TIMESTAMPTZ,
  interrupted_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  trigger_value DOUBLE PRECISION,
  channel_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_key TEXT,
  silenced_until TIMESTAMPTZ,
  silenced_by TEXT,
  delivery_status TEXT,
  delivery_kind TEXT,
  delivery_attempts INT NOT NULL DEFAULT 0,
  delivery_claimed_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  last_delivery_error TEXT,
  last_delivery_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT monitoring_alerts_scope_check CHECK (scope IN ('platform', 'api', 'worker')),
  CONSTRAINT monitoring_alerts_state_check CHECK (state IN ('pending', 'firing', 'interrupted', 'resolved')),
  CONSTRAINT monitoring_alerts_severity_check CHECK (severity IN ('warning', 'critical')),
  CONSTRAINT monitoring_alerts_kind_check CHECK (kind IN ('threshold', 'source_stale')),
  CONSTRAINT monitoring_alerts_delivery_status_check CHECK (
    delivery_status IS NULL OR delivery_status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')
  ),
  CONSTRAINT monitoring_alerts_delivery_kind_check CHECK (
    delivery_kind IS NULL OR delivery_kind IN ('firing', 'resolved', 'interrupted')
  ),
  CONSTRAINT monitoring_alerts_delivery_attempts_check CHECK (delivery_attempts >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS monitoring_alerts_open_key_idx
  ON "__SCHEMA__".monitoring_alerts (open_key);

CREATE INDEX IF NOT EXISTS monitoring_alerts_active_idx
  ON "__SCHEMA__".monitoring_alerts (state, fired_at);

CREATE INDEX IF NOT EXISTS monitoring_alerts_history_idx
  ON "__SCHEMA__".monitoring_alerts (resolved_at, id);

CREATE INDEX IF NOT EXISTS monitoring_alerts_delivery_idx
  ON "__SCHEMA__".monitoring_alerts (delivery_status, next_retry_at);
