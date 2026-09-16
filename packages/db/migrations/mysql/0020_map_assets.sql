-- 0036 的 MySQL 等价增量：地图身份、条件实现、投影与不可变封存。

CREATE TABLE map_pages (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  allocation_key VARCHAR(192) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  route_template VARCHAR(512) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'discovered',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_pages_pkey PRIMARY KEY (id),
  CONSTRAINT map_pages_kind_check CHECK (kind IN ('top','frame_primary','composite')),
  CONSTRAINT map_pages_status_check CHECK (status IN ('discovered','active','retired')),
  CONSTRAINT map_pages_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_pages_target_alloc_idx ON map_pages (target_id, allocation_key);
CREATE UNIQUE INDEX map_pages_target_id_idx ON map_pages (target_id, id);

CREATE TABLE map_objects (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  page_id VARCHAR(36) NOT NULL,
  allocation_key VARCHAR(192) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'discovered',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_objects_pkey PRIMARY KEY (id),
  CONSTRAINT map_objects_status_check CHECK (status IN ('discovered','active','retired')),
  CONSTRAINT map_objects_page_fk FOREIGN KEY (target_id, page_id) REFERENCES map_pages (target_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_objects_target_alloc_idx ON map_objects (target_id, allocation_key);
CREATE UNIQUE INDEX map_objects_target_id_idx ON map_objects (target_id, id);
CREATE UNIQUE INDEX map_objects_target_page_id_idx ON map_objects (target_id, page_id, id);
CREATE INDEX map_objects_page_idx ON map_objects (target_id, page_id);

CREATE TABLE map_identity_revisions (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  revision INT NOT NULL,
  command_key VARCHAR(192) NOT NULL,
  action VARCHAR(16) NOT NULL,
  old_refs JSON NOT NULL,
  new_refs JSON NOT NULL,
  reason VARCHAR(512) NOT NULL,
  evidence JSON NOT NULL,
  actor_id VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_identity_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT map_identity_revisions_rev_check CHECK (revision >= 1),
  CONSTRAINT map_identity_revisions_action_check CHECK (action IN ('merge','split','alias')),
  CONSTRAINT map_identity_revisions_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_identity_revisions_rev_idx ON map_identity_revisions (target_id, revision);
CREATE UNIQUE INDEX map_identity_revisions_cmd_idx ON map_identity_revisions (target_id, command_key);

CREATE TABLE map_projections (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  generation INT NOT NULL,
  status VARCHAR(16) NOT NULL,
  algorithm_version VARCHAR(64) NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  identity_revision INT NOT NULL,
  revision INT NOT NULL DEFAULT 0,
  ingest_cursor INT NOT NULL DEFAULT 0,
  source_watermark INT,
  last_error VARCHAR(512),
  rebuild_completeness VARCHAR(16),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_projections_pkey PRIMARY KEY (id),
  CONSTRAINT map_projections_generation_check CHECK (generation >= 1),
  CONSTRAINT map_projections_identity_check CHECK (identity_revision >= 0),
  CONSTRAINT map_projections_revision_check CHECK (revision >= 0),
  CONSTRAINT map_projections_cursor_check CHECK (ingest_cursor >= 0),
  CONSTRAINT map_projections_status_check CHECK (status IN ('active','shadow','ready','failed','superseded')),
  CONSTRAINT map_projections_completeness_check
    CHECK (rebuild_completeness IS NULL OR rebuild_completeness IN ('complete','partial','unknown')),
  CONSTRAINT map_projections_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_projections_generation_idx ON map_projections (target_id, generation);
CREATE UNIQUE INDEX map_projections_target_id_idx ON map_projections (target_id, id);
CREATE INDEX map_projections_status_idx ON map_projections (target_id, status);

CREATE TABLE map_projection_heads (
  target_id VARCHAR(36) NOT NULL,
  current_projection_id VARCHAR(36) NOT NULL,
  identity_revision INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_projection_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_projection_heads_identity_check CHECK (identity_revision >= 0),
  CONSTRAINT map_projection_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_projection_heads_current_fk
    FOREIGN KEY (target_id, current_projection_id) REFERENCES map_projections (target_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_identity_assignments (
  id VARCHAR(36) NOT NULL,
  projection_id VARCHAR(36) NOT NULL,
  observation_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  page_id VARCHAR(36),
  object_id VARCHAR(36),
  assignment_revision INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_identity_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT map_identity_assignments_rev_check CHECK (assignment_revision >= 1),
  CONSTRAINT map_identity_assignments_projection_fk
    FOREIGN KEY (target_id, projection_id) REFERENCES map_projections (target_id, id),
  CONSTRAINT map_identity_assignments_observation_fk
    FOREIGN KEY (observation_id, target_id) REFERENCES map_observations (id, target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_identity_assignments_rev_idx
  ON map_identity_assignments (projection_id, observation_id, assignment_revision);
CREATE INDEX map_identity_assignments_obs_idx ON map_identity_assignments (projection_id, observation_id);

CREATE TABLE map_object_descriptors (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  object_id VARCHAR(36) NOT NULL,
  implementation_key VARCHAR(192) NOT NULL,
  descriptor_version INT NOT NULL,
  features JSON NOT NULL,
  condition_snapshot JSON NOT NULL,
  content_digest VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_object_descriptors_pkey PRIMARY KEY (id),
  CONSTRAINT map_object_descriptors_ver_check CHECK (descriptor_version >= 1),
  CONSTRAINT map_object_descriptors_digest_check CHECK (CHAR_LENGTH(content_digest) = 64),
  CONSTRAINT map_object_descriptors_object_fk
    FOREIGN KEY (target_id, object_id) REFERENCES map_objects (target_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_object_descriptors_ver_idx
  ON map_object_descriptors (object_id, implementation_key, descriptor_version);
CREATE UNIQUE INDEX map_object_descriptors_digest_idx
  ON map_object_descriptors (object_id, implementation_key, content_digest);
CREATE UNIQUE INDEX map_object_descriptors_fk_idx
  ON map_object_descriptors (object_id, implementation_key, descriptor_version);

CREATE TABLE map_implementations (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  object_id VARCHAR(36) NOT NULL,
  implementation_key VARCHAR(192) NOT NULL,
  current_descriptor_version INT,
  condition_snapshot JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_implementations_pkey PRIMARY KEY (id),
  CONSTRAINT map_implementations_object_fk
    FOREIGN KEY (target_id, object_id) REFERENCES map_objects (target_id, id),
  CONSTRAINT map_implementations_descriptor_fk
    FOREIGN KEY (object_id, implementation_key, current_descriptor_version)
    REFERENCES map_object_descriptors (object_id, implementation_key, descriptor_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_implementations_key_idx ON map_implementations (object_id, implementation_key);
CREATE UNIQUE INDEX map_implementations_target_key_idx
  ON map_implementations (target_id, object_id, implementation_key);

CREATE TABLE map_projection_assets (
  id VARCHAR(36) NOT NULL,
  projection_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  asset_ref_key VARCHAR(192) NOT NULL,
  page_id VARCHAR(36),
  object_id VARCHAR(36),
  implementation_key VARCHAR(192),
  descriptor_version INT,
  lifecycle VARCHAR(16) NOT NULL,
  importance INT NOT NULL DEFAULT 0,
  executable INT NOT NULL DEFAULT 0,
  reject_reasons JSON NOT NULL,
  dimensions JSON NOT NULL,
  sample_count INT NOT NULL DEFAULT 0,
  change_count INT NOT NULL DEFAULT 0,
  last_verified_at DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_projection_assets_pkey PRIMARY KEY (id),
  CONSTRAINT map_projection_assets_importance_check CHECK (importance >= 0),
  CONSTRAINT map_projection_assets_executable_check CHECK (executable IN (0, 1)),
  CONSTRAINT map_projection_assets_sample_check CHECK (sample_count >= 0),
  CONSTRAINT map_projection_assets_change_check CHECK (change_count >= 0),
  CONSTRAINT map_projection_assets_lifecycle_check
    CHECK (lifecycle IN ('DISCOVERED','OBSERVED','VERIFIED','TRUSTED','DEGRADED','STALE','RETIRED')),
  CONSTRAINT map_projection_assets_projection_fk
    FOREIGN KEY (target_id, projection_id) REFERENCES map_projections (target_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_projection_assets_ref_idx ON map_projection_assets (projection_id, asset_ref_key);
CREATE INDEX map_projection_assets_object_idx ON map_projection_assets (projection_id, object_id);

CREATE TABLE map_conflicts (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  projection_id VARCHAR(36),
  conflict_key VARCHAR(192) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',
  payload JSON NOT NULL,
  handling_revision INT,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_conflicts_pkey PRIMARY KEY (id),
  CONSTRAINT map_conflicts_status_check CHECK (status IN ('open','resolved')),
  CONSTRAINT map_conflicts_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_conflicts_key_idx ON map_conflicts (target_id, conflict_key);

CREATE TABLE map_releases (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  release_no INT NOT NULL,
  projection_id VARCHAR(36) NOT NULL,
  policy_version VARCHAR(64) NOT NULL,
  source_watermark INT NOT NULL,
  manifest_digest VARCHAR(64) NOT NULL,
  manifest JSON NOT NULL,
  command_key VARCHAR(192) NOT NULL,
  sealed_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_releases_pkey PRIMARY KEY (id),
  CONSTRAINT map_releases_no_check CHECK (release_no >= 1),
  CONSTRAINT map_releases_watermark_check CHECK (source_watermark >= 0),
  CONSTRAINT map_releases_digest_check CHECK (CHAR_LENGTH(manifest_digest) = 64),
  CONSTRAINT map_releases_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_releases_projection_fk
    FOREIGN KEY (target_id, projection_id) REFERENCES map_projections (target_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_releases_no_idx ON map_releases (target_id, release_no);
CREATE UNIQUE INDEX map_releases_cmd_idx ON map_releases (target_id, command_key);
CREATE UNIQUE INDEX map_releases_target_id_idx ON map_releases (target_id, id);
CREATE UNIQUE INDEX map_releases_digest_idx ON map_releases (target_id, manifest_digest);

CREATE TABLE map_release_items (
  id VARCHAR(36) NOT NULL,
  release_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  asset_ref_key VARCHAR(192) NOT NULL,
  page_id VARCHAR(36),
  object_id VARCHAR(36),
  implementation_key VARCHAR(192),
  descriptor_version INT,
  identity_revision INT NOT NULL,
  lifecycle VARCHAR(16) NOT NULL,
  executable INT NOT NULL DEFAULT 0,
  condition_snapshot JSON,
  features JSON,
  CONSTRAINT map_release_items_pkey PRIMARY KEY (id),
  CONSTRAINT map_release_items_identity_check CHECK (identity_revision >= 0),
  CONSTRAINT map_release_items_executable_check CHECK (executable IN (0, 1)),
  CONSTRAINT map_release_items_lifecycle_check
    CHECK (lifecycle IN ('DISCOVERED','OBSERVED','VERIFIED','TRUSTED','DEGRADED','STALE','RETIRED')),
  CONSTRAINT map_release_items_release_fk
    FOREIGN KEY (target_id, release_id) REFERENCES map_releases (target_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX map_release_items_ref_idx ON map_release_items (release_id, asset_ref_key);
