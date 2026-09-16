-- 0052：Target 探索政策、OCC 收据、系统角色 map:explore，以及作业 kind 纳入 map_explore。

ALTER TABLE "__SCHEMA__".map_jobs DROP CONSTRAINT IF EXISTS map_jobs_kind_check;
ALTER TABLE "__SCHEMA__".map_jobs
  ADD CONSTRAINT map_jobs_kind_check CHECK (job_kind IN ('map_probe','map_refresh','map_explore'));

CREATE TABLE "__SCHEMA__".map_exploration_policies (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  policy_schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  explore_enabled INTEGER NOT NULL CHECK (explore_enabled IN (0, 1)),
  explore_mode TEXT NOT NULL,
  model_enabled INTEGER NOT NULL CHECK (model_enabled IN (0, 1)),
  max_hop_depth INTEGER NOT NULL,
  max_new_pages INTEGER NOT NULL,
  max_candidates INTEGER NOT NULL,
  max_actions INTEGER NOT NULL,
  max_seconds INTEGER NOT NULL,
  slice_work_seconds INTEGER NOT NULL,
  allowlist_json JSONB NOT NULL,
  seed_refs_json JSONB NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by UUID NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "__SCHEMA__".map_exploration_policy_commands (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_exploration_policy_commands_key UNIQUE (target_id, command_key)
);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'map:explore'),
  ('operator', 'map:explore')
) AS p(role_key, permission) ON p.role_key = r.key
WHERE r.kind = 'system'
ON CONFLICT DO NOTHING;
