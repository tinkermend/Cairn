-- 0038 的 SQLite 等价增量：地图查询治理、发布记录、场景引用与 map 权限。

CREATE TABLE map_governance_heads (
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_governance_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_governance_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_asset_governance (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  asset_ref_key TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('TRUSTED','RETIRED')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_asset_governance_pkey PRIMARY KEY (id),
  CONSTRAINT map_asset_governance_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_asset_governance_ref_idx ON map_asset_governance (target_id, asset_ref_key);
CREATE INDEX map_asset_governance_cmd_idx ON map_asset_governance (command_id);

CREATE TABLE map_governance_commands (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('confirm_semantics','correct_identity','retire','restore')),
  status TEXT NOT NULL CHECK (status IN ('pending','applying','applied','rejected','failed')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  result_revision INTEGER,
  payload TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_governance_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_governance_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_governance_commands_key_idx ON map_governance_commands (target_id, command_key);

CREATE TABLE map_publication_heads (
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_publication_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_publication_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_release_publications (
  release_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  publication_status TEXT NOT NULL CHECK (publication_status IN ('published','withdrawn')),
  command_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  published_at TEXT,
  withdrawn_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_release_publications_pkey PRIMARY KEY (release_id),
  CONSTRAINT map_release_publications_release_fk FOREIGN KEY (release_id) REFERENCES map_releases(id) ON DELETE RESTRICT,
  CONSTRAINT map_release_publications_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_release_publications_cmd_idx ON map_release_publications (target_id, command_key);
CREATE UNIQUE INDEX map_release_publications_target_rel_idx ON map_release_publications (target_id, release_id);
CREATE INDEX map_release_publications_status_idx ON map_release_publications (target_id, publication_status);

CREATE TABLE map_scenario_bindings (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  step_id TEXT,
  asset_ref_key TEXT NOT NULL,
  page_id TEXT,
  object_id TEXT,
  implementation_key TEXT,
  descriptor_version INTEGER,
  basis TEXT NOT NULL CHECK (basis IN ('explicit_user','compiled_action','accepted_proposal')),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('draft','version','page_context')),
  draft_revision INTEGER,
  scenario_version_id TEXT,
  version_slot TEXT NOT NULL DEFAULT 'draft',
  descriptor_digest TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  resolution TEXT NOT NULL CHECK (resolution IN ('resolved','pending_confirmation')),
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_scenario_bindings_pkey PRIMARY KEY (id),
  CONSTRAINT map_scenario_bindings_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT map_scenario_bindings_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  CONSTRAINT map_scenario_bindings_version_fk FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_scenario_bindings_slot_idx
  ON map_scenario_bindings (target_id, scenario_id, scope_kind, slot_key, version_slot);
CREATE INDEX map_scenario_bindings_asset_idx ON map_scenario_bindings (target_id, asset_ref_key);
CREATE INDEX map_scenario_bindings_scenario_idx ON map_scenario_bindings (scenario_id, status);

CREATE TABLE map_reference_scan_heads (
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','running','complete')),
  completeness TEXT NOT NULL DEFAULT 'unknown' CHECK (completeness IN ('complete','partial','unknown')),
  last_scenario_id TEXT,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  requested_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_reference_scan_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_reference_scan_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_reference_candidates (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_version_id TEXT,
  step_id TEXT NOT NULL,
  asset_ref_key TEXT NOT NULL,
  page_id TEXT,
  object_id TEXT,
  reasons TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_reference_candidates_pkey PRIMARY KEY (id),
  CONSTRAINT map_reference_candidates_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_reference_candidates_step_idx
  ON map_reference_candidates (target_id, scenario_id, step_id, asset_ref_key);
CREATE INDEX map_reference_candidates_asset_idx ON map_reference_candidates (target_id, asset_ref_key);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'map:read' AS permission
  UNION ALL SELECT 'admin', 'map:review'
  UNION ALL SELECT 'admin', 'map:publish'
  UNION ALL SELECT 'author', 'map:read'
  UNION ALL SELECT 'author', 'map:review'
  UNION ALL SELECT 'operator', 'map:read'
  UNION ALL SELECT 'viewer', 'map:read'
) AS p ON p.role_key = r.key
WHERE r.kind = 'system';
