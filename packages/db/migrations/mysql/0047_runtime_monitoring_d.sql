-- 0047：RM-D 告警实例。未恢复唯一靠可空 open_key，与 PG 部分唯一索引等价。

CREATE TABLE monitoring_alerts (
  id VARCHAR(36) NOT NULL,
  rule_id VARCHAR(64) NOT NULL,
  rule_name VARCHAR(80) NOT NULL,
  scope VARCHAR(16) NOT NULL,
  scope_id VARCHAR(256) NOT NULL,
  state VARCHAR(16) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  metric_key VARCHAR(64) NULL,
  stale_source VARCHAR(32) NULL,
  comparator VARCHAR(8) NULL,
  threshold DOUBLE NULL,
  condition_opened_at DATETIME(3) NOT NULL,
  fired_at DATETIME(3) NULL,
  recovery_opened_at DATETIME(3) NULL,
  interrupted_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  trigger_value DOUBLE NULL,
  channel_ids JSON NOT NULL,
  open_key VARCHAR(512) NULL,
  silenced_until DATETIME(3) NULL,
  silenced_by VARCHAR(64) NULL,
  delivery_status VARCHAR(16) NULL,
  delivery_kind VARCHAR(16) NULL,
  delivery_attempts INT NOT NULL DEFAULT 0,
  delivery_claimed_at DATETIME(3) NULL,
  next_retry_at DATETIME(3) NULL,
  last_delivery_error VARCHAR(64) NULL,
  last_delivery_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT monitoring_alerts_scope_check CHECK (scope IN ('platform', 'api', 'worker')),
  CONSTRAINT monitoring_alerts_state_check CHECK (state IN ('pending', 'firing', 'interrupted', 'resolved')),
  CONSTRAINT monitoring_alerts_severity_check CHECK (severity IN ('warning', 'critical')),
  CONSTRAINT monitoring_alerts_kind_check CHECK (kind IN ('threshold', 'source_stale')),
  CONSTRAINT monitoring_alerts_delivery_status_check CHECK (
    (delivery_status IS NULL) OR (delivery_status IN ('pending', 'sending', 'sent', 'failed', 'suppressed'))
  ),
  CONSTRAINT monitoring_alerts_delivery_kind_check CHECK (
    (delivery_kind IS NULL) OR (delivery_kind IN ('firing', 'resolved', 'interrupted'))
  ),
  CONSTRAINT monitoring_alerts_delivery_attempts_check CHECK (delivery_attempts >= 0)
);

CREATE UNIQUE INDEX monitoring_alerts_open_key_idx ON monitoring_alerts (open_key);
CREATE INDEX monitoring_alerts_active_idx ON monitoring_alerts (state, fired_at);
CREATE INDEX monitoring_alerts_history_idx ON monitoring_alerts (resolved_at, id);
CREATE INDEX monitoring_alerts_delivery_idx ON monitoring_alerts (delivery_status, next_retry_at);
