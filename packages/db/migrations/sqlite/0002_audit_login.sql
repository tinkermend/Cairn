-- 0016 的 SQLite 等价增量。表级 CHECK 无法廉价追加，形状由写路径卡住。

ALTER TABLE console_audit_events ADD COLUMN category TEXT NOT NULL DEFAULT 'operation';
ALTER TABLE console_audit_events ADD COLUMN client_ip TEXT;
ALTER TABLE console_audit_events ADD COLUMN user_agent TEXT;
ALTER TABLE console_audit_events ADD COLUMN client_kind TEXT;
ALTER TABLE console_audit_events ADD COLUMN login_identifier TEXT;
ALTER TABLE console_audit_events ADD COLUMN outcome TEXT;
ALTER TABLE console_audit_events ADD COLUMN failure_reason TEXT;

CREATE INDEX console_audit_events_category_created_idx
  ON console_audit_events (category, created_at DESC);

CREATE INDEX console_audit_events_login_outcome_idx
  ON console_audit_events (category, outcome, created_at DESC);

CREATE INDEX console_audit_events_login_identifier_idx
  ON console_audit_events (login_identifier);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT id, 'audit:login' FROM console_roles WHERE key = 'admin';
