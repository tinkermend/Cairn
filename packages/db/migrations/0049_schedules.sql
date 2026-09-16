-- 0049：平台调度计划、窗口 occurrence、事件与写命令。

CREATE TABLE "__SCHEMA__".schedules (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  target_account_id UUID NOT NULL REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE RESTRICT,
  consumer_key TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  current_version_id UUID NOT NULL,
  next_due_at TIMESTAMPTZ,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedules_account_consumer UNIQUE (target_account_id, consumer_key)
);

CREATE INDEX schedules_due_idx ON "__SCHEMA__".schedules (enabled, next_due_at);
CREATE INDEX schedules_target_idx ON "__SCHEMA__".schedules (target_id, created_at);

CREATE TABLE "__SCHEMA__".schedule_versions (
  id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES "__SCHEMA__".schedules(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  timezone TEXT NOT NULL,
  weekdays JSONB NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  misfire TEXT NOT NULL,
  consumer JSONB NOT NULL,
  authorized_actor_id UUID NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_versions_rev UNIQUE (schedule_id, revision)
);

CREATE TABLE "__SCHEMA__".schedule_occurrences (
  id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES "__SCHEMA__".schedules(id) ON DELETE RESTRICT,
  schedule_version_id UUID NOT NULL REFERENCES "__SCHEMA__".schedule_versions(id) ON DELETE RESTRICT,
  local_slot_key TEXT NOT NULL,
  occurrence_key TEXT,
  local_start_date TEXT NOT NULL,
  window_start_utc TIMESTAMPTZ,
  window_end_utc TIMESTAMPTZ,
  start_offset_minutes INTEGER,
  end_offset_minutes INTEGER,
  time_rule_version TEXT NOT NULL,
  admission_status TEXT NOT NULL,
  reason TEXT,
  job_id UUID REFERENCES "__SCHEMA__".map_jobs(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  admitted_at TIMESTAMPTZ,
  CONSTRAINT schedule_occurrences_slot UNIQUE (schedule_id, local_slot_key),
  CONSTRAINT schedule_occurrences_key UNIQUE (occurrence_key),
  CONSTRAINT schedule_occurrences_job UNIQUE (job_id)
);

CREATE INDEX schedule_occurrences_due_idx ON "__SCHEMA__".schedule_occurrences (admission_status, window_end_utc);

CREATE TABLE "__SCHEMA__".schedule_events (
  id UUID PRIMARY KEY,
  schedule_id UUID NOT NULL REFERENCES "__SCHEMA__".schedules(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_events_seq UNIQUE (schedule_id, seq)
);

CREATE TABLE "__SCHEMA__".schedule_commands (
  id UUID PRIMARY KEY,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_commands_key UNIQUE (command_key)
);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'schedule:read'),
  ('admin', 'schedule:write'),
  ('operator', 'schedule:read'),
  ('operator', 'schedule:write')
) AS p(role_key, permission) ON p.role_key = r.key
WHERE r.kind = 'system'
ON CONFLICT DO NOTHING;
