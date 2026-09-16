-- 0038 的 MySQL 等价增量：地图查询治理、发布记录、场景引用与 map 权限。

CREATE TABLE map_governance_heads (
  target_id VARCHAR(36) NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_governance_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_governance_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_asset_governance (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  asset_ref_key VARCHAR(192) NOT NULL,
  lifecycle VARCHAR(16) NOT NULL,
  revision INT NOT NULL,
  reason VARCHAR(512) NOT NULL,
  actor_id VARCHAR(36) NOT NULL,
  command_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_asset_governance_pkey PRIMARY KEY (id),
  CONSTRAINT map_asset_governance_lifecycle_check CHECK (lifecycle IN ('TRUSTED','RETIRED')),
  CONSTRAINT map_asset_governance_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_asset_governance_ref_idx ON map_asset_governance (target_id, asset_ref_key);
CREATE INDEX map_asset_governance_cmd_idx ON map_asset_governance (command_id);

CREATE TABLE map_governance_commands (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  command_key VARCHAR(192) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  expected_revision INT NOT NULL,
  result_revision INT,
  payload JSON NOT NULL,
  reason VARCHAR(512) NOT NULL,
  evidence JSON NOT NULL,
  actor_id VARCHAR(36) NOT NULL,
  last_error VARCHAR(512),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_governance_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_governance_commands_kind_check
    CHECK (kind IN ('confirm_semantics','correct_identity','retire','restore')),
  CONSTRAINT map_governance_commands_status_check
    CHECK (status IN ('pending','applying','applied','rejected','failed')),
  CONSTRAINT map_governance_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_governance_commands_key_idx ON map_governance_commands (target_id, command_key);

CREATE TABLE map_publication_heads (
  target_id VARCHAR(36) NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_publication_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_publication_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_release_publications (
  release_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  publication_status VARCHAR(16) NOT NULL,
  command_key VARCHAR(192) NOT NULL,
  reason VARCHAR(512) NOT NULL,
  actor_id VARCHAR(36) NOT NULL,
  published_at DATETIME(3),
  withdrawn_at DATETIME(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_release_publications_pkey PRIMARY KEY (release_id),
  CONSTRAINT map_release_publications_status_check CHECK (publication_status IN ('published','withdrawn')),
  CONSTRAINT map_release_publications_release_fk FOREIGN KEY (release_id) REFERENCES map_releases(id),
  CONSTRAINT map_release_publications_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_release_publications_cmd_idx ON map_release_publications (target_id, command_key);
CREATE UNIQUE INDEX map_release_publications_target_rel_idx ON map_release_publications (target_id, release_id);
CREATE INDEX map_release_publications_status_idx ON map_release_publications (target_id, publication_status);

CREATE TABLE map_scenario_bindings (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scenario_id VARCHAR(36) NOT NULL,
  slot_key VARCHAR(192) NOT NULL,
  step_id VARCHAR(36),
  asset_ref_key VARCHAR(192) NOT NULL,
  page_id VARCHAR(36),
  object_id VARCHAR(36),
  implementation_key VARCHAR(192),
  descriptor_version INT,
  basis VARCHAR(32) NOT NULL,
  scope_kind VARCHAR(16) NOT NULL,
  draft_revision INT,
  scenario_version_id VARCHAR(36),
  version_slot VARCHAR(64) NOT NULL DEFAULT 'draft',
  descriptor_digest VARCHAR(64),
  confirmed_by VARCHAR(36),
  confirmed_at DATETIME(3),
  resolution VARCHAR(32) NOT NULL,
  source_ref JSON,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_scenario_bindings_pkey PRIMARY KEY (id),
  CONSTRAINT map_scenario_bindings_basis_check
    CHECK (basis IN ('explicit_user','compiled_action','accepted_proposal')),
  CONSTRAINT map_scenario_bindings_scope_check
    CHECK (scope_kind IN ('draft','version','page_context')),
  CONSTRAINT map_scenario_bindings_resolution_check
    CHECK (resolution IN ('resolved','pending_confirmation')),
  CONSTRAINT map_scenario_bindings_status_check CHECK (status IN ('active','removed')),
  CONSTRAINT map_scenario_bindings_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_scenario_bindings_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id),
  CONSTRAINT map_scenario_bindings_version_fk FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_scenario_bindings_slot_idx
  ON map_scenario_bindings (target_id, scenario_id, scope_kind, slot_key, version_slot);
CREATE INDEX map_scenario_bindings_asset_idx ON map_scenario_bindings (target_id, asset_ref_key);
CREATE INDEX map_scenario_bindings_scenario_idx ON map_scenario_bindings (scenario_id, status);

CREATE TABLE map_reference_scan_heads (
  target_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'idle',
  completeness VARCHAR(16) NOT NULL DEFAULT 'unknown',
  last_scenario_id VARCHAR(36),
  scanned_count INT NOT NULL DEFAULT 0,
  requested_at DATETIME(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_reference_scan_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_reference_scan_heads_status_check CHECK (status IN ('idle','running','complete')),
  CONSTRAINT map_reference_scan_heads_completeness_check
    CHECK (completeness IN ('complete','partial','unknown')),
  CONSTRAINT map_reference_scan_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_reference_candidates (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scenario_id VARCHAR(36) NOT NULL,
  scenario_version_id VARCHAR(36),
  step_id VARCHAR(36) NOT NULL,
  asset_ref_key VARCHAR(192) NOT NULL,
  page_id VARCHAR(36),
  object_id VARCHAR(36),
  reasons JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_reference_candidates_pkey PRIMARY KEY (id),
  CONSTRAINT map_reference_candidates_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_reference_candidates_step_idx
  ON map_reference_candidates (target_id, scenario_id, step_id, asset_ref_key);
CREATE INDEX map_reference_candidates_asset_idx ON map_reference_candidates (target_id, asset_ref_key);

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
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
) p ON p.role_key = r.`key`
WHERE r.kind = 'system';
