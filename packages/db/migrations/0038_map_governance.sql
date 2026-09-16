-- 0038：地图查询治理、发布记录、场景引用与系统角色 map 权限。

CREATE TABLE "__SCHEMA__".map_governance_heads (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "__SCHEMA__".map_asset_governance (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  asset_ref_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  reason TEXT NOT NULL,
  actor_id UUID NOT NULL,
  command_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_asset_governance_lifecycle_check CHECK (lifecycle IN ('TRUSTED','RETIRED'))
);
CREATE UNIQUE INDEX map_asset_governance_ref_idx ON "__SCHEMA__".map_asset_governance (target_id, asset_ref_key);
CREATE INDEX map_asset_governance_cmd_idx ON "__SCHEMA__".map_asset_governance (command_id);

CREATE TABLE "__SCHEMA__".map_governance_commands (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  command_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  result_revision INTEGER,
  payload JSONB NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  actor_id UUID NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_governance_commands_kind_check
    CHECK (kind IN ('confirm_semantics','correct_identity','retire','restore')),
  CONSTRAINT map_governance_commands_status_check
    CHECK (status IN ('pending','applying','applied','rejected','failed'))
);
CREATE UNIQUE INDEX map_governance_commands_key_idx ON "__SCHEMA__".map_governance_commands (target_id, command_key);

CREATE TABLE "__SCHEMA__".map_publication_heads (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "__SCHEMA__".map_release_publications (
  release_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".map_releases(id) ON DELETE RESTRICT,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  publication_status TEXT NOT NULL,
  command_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id UUID NOT NULL,
  published_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_release_publications_status_check CHECK (publication_status IN ('published','withdrawn'))
);
CREATE UNIQUE INDEX map_release_publications_cmd_idx ON "__SCHEMA__".map_release_publications (target_id, command_key);
CREATE UNIQUE INDEX map_release_publications_target_rel_idx ON "__SCHEMA__".map_release_publications (target_id, release_id);
CREATE INDEX map_release_publications_status_idx ON "__SCHEMA__".map_release_publications (target_id, publication_status);

CREATE TABLE "__SCHEMA__".map_scenario_bindings (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  scenario_id UUID NOT NULL REFERENCES "__SCHEMA__".scenarios(id) ON DELETE RESTRICT,
  slot_key TEXT NOT NULL,
  step_id UUID,
  asset_ref_key TEXT NOT NULL,
  page_id UUID,
  object_id UUID,
  implementation_key TEXT,
  descriptor_version INTEGER,
  basis TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  draft_revision INTEGER,
  scenario_version_id UUID REFERENCES "__SCHEMA__".scenario_versions(id) ON DELETE RESTRICT,
  version_slot TEXT NOT NULL DEFAULT 'draft',
  descriptor_digest TEXT,
  confirmed_by UUID,
  confirmed_at TIMESTAMPTZ,
  resolution TEXT NOT NULL,
  source_ref JSONB,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_scenario_bindings_basis_check
    CHECK (basis IN ('explicit_user','compiled_action','accepted_proposal')),
  CONSTRAINT map_scenario_bindings_scope_check
    CHECK (scope_kind IN ('draft','version','page_context')),
  CONSTRAINT map_scenario_bindings_resolution_check
    CHECK (resolution IN ('resolved','pending_confirmation')),
  CONSTRAINT map_scenario_bindings_status_check
    CHECK (status IN ('active','removed'))
);
CREATE UNIQUE INDEX map_scenario_bindings_slot_idx
  ON "__SCHEMA__".map_scenario_bindings (target_id, scenario_id, scope_kind, slot_key, version_slot);
CREATE INDEX map_scenario_bindings_asset_idx ON "__SCHEMA__".map_scenario_bindings (target_id, asset_ref_key);
CREATE INDEX map_scenario_bindings_scenario_idx ON "__SCHEMA__".map_scenario_bindings (scenario_id, status);

CREATE TABLE "__SCHEMA__".map_reference_scan_heads (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'idle',
  completeness TEXT NOT NULL DEFAULT 'unknown',
  last_scenario_id UUID,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  requested_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_reference_scan_heads_status_check CHECK (status IN ('idle','running','complete')),
  CONSTRAINT map_reference_scan_heads_completeness_check
    CHECK (completeness IN ('complete','partial','unknown'))
);

CREATE TABLE "__SCHEMA__".map_reference_candidates (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  scenario_id UUID NOT NULL,
  scenario_version_id UUID,
  step_id UUID NOT NULL,
  asset_ref_key TEXT NOT NULL,
  page_id UUID,
  object_id UUID,
  reasons JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX map_reference_candidates_step_idx
  ON "__SCHEMA__".map_reference_candidates (target_id, scenario_id, step_id, asset_ref_key);
CREATE INDEX map_reference_candidates_asset_idx ON "__SCHEMA__".map_reference_candidates (target_id, asset_ref_key);

INSERT INTO "__SCHEMA__".console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM "__SCHEMA__".console_roles r
JOIN (VALUES
  ('admin', 'map:read'),
  ('admin', 'map:review'),
  ('admin', 'map:publish'),
  ('author', 'map:read'),
  ('author', 'map:review'),
  ('operator', 'map:read'),
  ('viewer', 'map:read')
) AS p(role_key, permission) ON p.role_key = r.key
WHERE r.kind = 'system'
ON CONFLICT DO NOTHING;
