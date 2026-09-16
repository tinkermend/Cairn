-- 0036 的 SQLite 等价增量：地图身份、条件实现、投影与不可变封存。

CREATE TABLE map_pages (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  allocation_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('top','frame_primary','composite')),
  route_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered','active','retired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_pages_pkey PRIMARY KEY (id),
  CONSTRAINT map_pages_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_pages_target_alloc_idx ON map_pages (target_id, allocation_key);
CREATE UNIQUE INDEX map_pages_target_id_idx ON map_pages (target_id, id);

CREATE TABLE map_objects (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  allocation_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered','active','retired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_objects_pkey PRIMARY KEY (id),
  CONSTRAINT map_objects_page_fk FOREIGN KEY (target_id, page_id) REFERENCES map_pages (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_objects_target_alloc_idx ON map_objects (target_id, allocation_key);
CREATE UNIQUE INDEX map_objects_target_id_idx ON map_objects (target_id, id);
CREATE UNIQUE INDEX map_objects_target_page_id_idx ON map_objects (target_id, page_id, id);
CREATE INDEX map_objects_page_idx ON map_objects (target_id, page_id);

CREATE TABLE map_identity_revisions (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  command_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('merge','split','alias')),
  old_refs TEXT NOT NULL,
  new_refs TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_identity_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT map_identity_revisions_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_identity_revisions_rev_idx ON map_identity_revisions (target_id, revision);
CREATE UNIQUE INDEX map_identity_revisions_cmd_idx ON map_identity_revisions (target_id, command_key);

CREATE TABLE map_projections (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL CHECK (status IN ('active','shadow','ready','failed','superseded')),
  algorithm_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  identity_revision INTEGER NOT NULL CHECK (identity_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ingest_cursor INTEGER NOT NULL DEFAULT 0 CHECK (ingest_cursor >= 0),
  source_watermark INTEGER,
  last_error TEXT,
  rebuild_completeness TEXT CHECK (rebuild_completeness IS NULL OR rebuild_completeness IN ('complete','partial','unknown')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_projections_pkey PRIMARY KEY (id),
  CONSTRAINT map_projections_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_projections_generation_idx ON map_projections (target_id, generation);
CREATE UNIQUE INDEX map_projections_target_id_idx ON map_projections (target_id, id);
CREATE INDEX map_projections_status_idx ON map_projections (target_id, status);

CREATE TABLE map_projection_heads (
  target_id TEXT NOT NULL,
  current_projection_id TEXT NOT NULL,
  identity_revision INTEGER NOT NULL DEFAULT 0 CHECK (identity_revision >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_projection_heads_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_projection_heads_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT map_projection_heads_current_fk
    FOREIGN KEY (target_id, current_projection_id) REFERENCES map_projections (target_id, id) ON DELETE RESTRICT
);

CREATE TABLE map_identity_assignments (
  id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  page_id TEXT,
  object_id TEXT,
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision >= 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_identity_assignments_pkey PRIMARY KEY (id),
  CONSTRAINT map_identity_assignments_projection_fk
    FOREIGN KEY (target_id, projection_id) REFERENCES map_projections (target_id, id) ON DELETE RESTRICT,
  CONSTRAINT map_identity_assignments_observation_fk
    FOREIGN KEY (observation_id, target_id) REFERENCES map_observations (id, target_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_identity_assignments_rev_idx
  ON map_identity_assignments (projection_id, observation_id, assignment_revision);
CREATE INDEX map_identity_assignments_obs_idx ON map_identity_assignments (projection_id, observation_id);

CREATE TABLE map_object_descriptors (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  implementation_key TEXT NOT NULL,
  descriptor_version INTEGER NOT NULL CHECK (descriptor_version >= 1),
  features TEXT NOT NULL,
  condition_snapshot TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_object_descriptors_pkey PRIMARY KEY (id),
  CONSTRAINT map_object_descriptors_object_fk
    FOREIGN KEY (target_id, object_id) REFERENCES map_objects (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_object_descriptors_ver_idx
  ON map_object_descriptors (object_id, implementation_key, descriptor_version);
CREATE UNIQUE INDEX map_object_descriptors_digest_idx
  ON map_object_descriptors (object_id, implementation_key, content_digest);
CREATE UNIQUE INDEX map_object_descriptors_fk_idx
  ON map_object_descriptors (object_id, implementation_key, descriptor_version);

CREATE TABLE map_implementations (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  implementation_key TEXT NOT NULL,
  current_descriptor_version INTEGER,
  condition_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_implementations_pkey PRIMARY KEY (id),
  CONSTRAINT map_implementations_object_fk
    FOREIGN KEY (target_id, object_id) REFERENCES map_objects (target_id, id) ON DELETE RESTRICT,
  CONSTRAINT map_implementations_descriptor_fk
    FOREIGN KEY (object_id, implementation_key, current_descriptor_version)
    REFERENCES map_object_descriptors (object_id, implementation_key, descriptor_version)
);
CREATE UNIQUE INDEX map_implementations_key_idx ON map_implementations (object_id, implementation_key);
CREATE UNIQUE INDEX map_implementations_target_key_idx
  ON map_implementations (target_id, object_id, implementation_key);

CREATE TABLE map_projection_assets (
  id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  asset_ref_key TEXT NOT NULL,
  page_id TEXT,
  object_id TEXT,
  implementation_key TEXT,
  descriptor_version INTEGER,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('DISCOVERED','OBSERVED','VERIFIED','TRUSTED','DEGRADED','STALE','RETIRED')),
  importance INTEGER NOT NULL DEFAULT 0 CHECK (importance >= 0),
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  reject_reasons TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  change_count INTEGER NOT NULL DEFAULT 0 CHECK (change_count >= 0),
  last_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_projection_assets_pkey PRIMARY KEY (id),
  CONSTRAINT map_projection_assets_projection_fk
    FOREIGN KEY (target_id, projection_id) REFERENCES map_projections (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_projection_assets_ref_idx ON map_projection_assets (projection_id, asset_ref_key);
CREATE INDEX map_projection_assets_object_idx ON map_projection_assets (projection_id, object_id);

CREATE TABLE map_conflicts (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  projection_id TEXT,
  conflict_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  payload TEXT NOT NULL,
  handling_revision INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_conflicts_pkey PRIMARY KEY (id),
  CONSTRAINT map_conflicts_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_conflicts_key_idx ON map_conflicts (target_id, conflict_key);

CREATE TABLE map_releases (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  release_no INTEGER NOT NULL CHECK (release_no >= 1),
  projection_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  source_watermark INTEGER NOT NULL CHECK (source_watermark >= 0),
  manifest_digest TEXT NOT NULL,
  manifest TEXT NOT NULL,
  command_key TEXT NOT NULL,
  sealed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_releases_pkey PRIMARY KEY (id),
  CONSTRAINT map_releases_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT map_releases_projection_fk
    FOREIGN KEY (target_id, projection_id) REFERENCES map_projections (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_releases_no_idx ON map_releases (target_id, release_no);
CREATE UNIQUE INDEX map_releases_cmd_idx ON map_releases (target_id, command_key);
CREATE UNIQUE INDEX map_releases_target_id_idx ON map_releases (target_id, id);
CREATE UNIQUE INDEX map_releases_digest_idx ON map_releases (target_id, manifest_digest);

CREATE TABLE map_release_items (
  id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  asset_ref_key TEXT NOT NULL,
  page_id TEXT,
  object_id TEXT,
  implementation_key TEXT,
  descriptor_version INTEGER,
  identity_revision INTEGER NOT NULL CHECK (identity_revision >= 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('DISCOVERED','OBSERVED','VERIFIED','TRUSTED','DEGRADED','STALE','RETIRED')),
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  condition_snapshot TEXT,
  features TEXT,
  CONSTRAINT map_release_items_pkey PRIMARY KEY (id),
  CONSTRAINT map_release_items_release_fk
    FOREIGN KEY (target_id, release_id) REFERENCES map_releases (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_release_items_ref_idx ON map_release_items (release_id, asset_ref_key);
