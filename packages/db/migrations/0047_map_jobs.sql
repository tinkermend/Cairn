-- 0047：Target 授权修订、地图作业政策、安全进入与父作业/分片。

ALTER TABLE "__SCHEMA__".runs DROP CONSTRAINT IF EXISTS runs_actor_shape;
ALTER TABLE "__SCHEMA__".runs
  ADD CONSTRAINT runs_actor_shape CHECK (
    (created_by_console_account_id IS NOT NULL AND service_caller_id IS NULL AND service_credential_id IS NULL AND service_admission IS NULL)
    OR (created_by_console_account_id IS NULL AND service_caller_id IS NOT NULL AND service_credential_id IS NOT NULL AND service_admission IS NOT NULL AND deadline_at IS NOT NULL AND idempotency_key IS NOT NULL)
  );

ALTER TABLE "__SCHEMA__".scenarios DROP CONSTRAINT IF EXISTS scenarios_purpose_check;
ALTER TABLE "__SCHEMA__".scenarios
  ADD CONSTRAINT scenarios_purpose_check CHECK (purpose IN ('user','module_verification','map_job'));

CREATE TABLE "__SCHEMA__".target_access_policies (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  policy_schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  rules_json JSONB NOT NULL,
  policy_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "__SCHEMA__".target_access_policy_commands (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT target_access_policy_commands_key UNIQUE (target_id, command_key)
);

CREATE TABLE "__SCHEMA__".map_job_policies (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  policy_schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  manual_jobs_enabled INTEGER NOT NULL CHECK (manual_jobs_enabled IN (0, 1)),
  max_probe_pages INTEGER NOT NULL,
  max_probe_objects INTEGER NOT NULL,
  max_probe_actions INTEGER NOT NULL,
  max_probe_seconds INTEGER NOT NULL,
  max_refresh_pages INTEGER NOT NULL,
  max_refresh_objects INTEGER NOT NULL,
  max_refresh_actions INTEGER NOT NULL,
  max_refresh_seconds INTEGER NOT NULL,
  slice_work_seconds INTEGER NOT NULL,
  default_depth TEXT NOT NULL,
  static_refresh_days INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "__SCHEMA__".map_job_policy_commands (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_job_policy_commands_key UNIQUE (target_id, command_key)
);

CREATE TABLE "__SCHEMA__".map_safe_entries (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  entry_version INTEGER NOT NULL CHECK (entry_version >= 1),
  entry_name TEXT NOT NULL,
  entry_url TEXT NOT NULL,
  arrival_name TEXT NOT NULL,
  arrival_target JSONB NOT NULL,
  safety_basis JSONB NOT NULL,
  job_kinds JSONB NOT NULL,
  command_key TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_safe_entries_cmd UNIQUE (target_id, command_key)
);
CREATE INDEX map_safe_entries_target_idx ON "__SCHEMA__".map_safe_entries (target_id, created_at DESC);

CREATE TABLE "__SCHEMA__".map_jobs (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  target_account_id UUID NOT NULL REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE RESTRICT,
  job_kind TEXT NOT NULL,
  job_status TEXT NOT NULL,
  stop_reason TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  remaining_budget_seconds INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  entry_id UUID NOT NULL REFERENCES "__SCHEMA__".map_safe_entries(id) ON DELETE RESTRICT,
  release_id UUID,
  request_json JSONB NOT NULL,
  frozen_policy_json JSONB NOT NULL,
  active_guard TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_jobs_kind_check CHECK (job_kind IN ('map_probe','map_refresh')),
  CONSTRAINT map_jobs_status_check CHECK (job_status IN ('queued','running','completed','cancelled','failed')),
  CONSTRAINT map_jobs_active_target UNIQUE (target_id, active_guard)
);
CREATE INDEX map_jobs_target_idx ON "__SCHEMA__".map_jobs (target_id, created_at DESC);

CREATE TABLE "__SCHEMA__".map_job_slices (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES "__SCHEMA__".map_jobs(id) ON DELETE RESTRICT,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  slice_ordinal INTEGER NOT NULL CHECK (slice_ordinal >= 0),
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  reserved_seconds INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_job_slices_ord UNIQUE (job_id, slice_ordinal),
  CONSTRAINT map_job_slices_run UNIQUE (run_id)
);
CREATE INDEX map_job_slices_target_idx ON "__SCHEMA__".map_job_slices (target_id, created_at);

CREATE TABLE "__SCHEMA__".map_job_commands (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_job_commands_key UNIQUE (target_id, command_key)
);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'map:maintain'),
  ('operator', 'map:maintain')
) AS p(role_key, permission) ON p.role_key = r.key
WHERE r.kind = 'system'
ON CONFLICT DO NOTHING;
