-- 0036：地图身份、条件实现、投影与不可变封存。

CREATE TABLE "__SCHEMA__".map_pages (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  allocation_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  route_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_pages_kind_check CHECK (kind IN ('top','frame_primary','composite')),
  CONSTRAINT map_pages_status_check CHECK (status IN ('discovered','active','retired'))
);
CREATE UNIQUE INDEX map_pages_target_alloc_idx ON "__SCHEMA__".map_pages (target_id, allocation_key);
CREATE UNIQUE INDEX map_pages_target_id_idx ON "__SCHEMA__".map_pages (target_id, id);

CREATE TABLE "__SCHEMA__".map_objects (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL,
  page_id UUID NOT NULL,
  allocation_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'discovered',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_objects_status_check CHECK (status IN ('discovered','active','retired')),
  CONSTRAINT map_objects_page_fk
    FOREIGN KEY (target_id, page_id) REFERENCES "__SCHEMA__".map_pages (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_objects_target_alloc_idx ON "__SCHEMA__".map_objects (target_id, allocation_key);
CREATE UNIQUE INDEX map_objects_target_id_idx ON "__SCHEMA__".map_objects (target_id, id);
CREATE UNIQUE INDEX map_objects_target_page_id_idx ON "__SCHEMA__".map_objects (target_id, page_id, id);
CREATE INDEX map_objects_page_idx ON "__SCHEMA__".map_objects (target_id, page_id);

CREATE TABLE "__SCHEMA__".map_identity_revisions (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  command_key TEXT NOT NULL,
  action TEXT NOT NULL,
  old_refs JSONB NOT NULL,
  new_refs JSONB NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  actor_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_identity_revisions_action_check CHECK (action IN ('merge','split','alias'))
);
CREATE UNIQUE INDEX map_identity_revisions_rev_idx ON "__SCHEMA__".map_identity_revisions (target_id, revision);
CREATE UNIQUE INDEX map_identity_revisions_cmd_idx ON "__SCHEMA__".map_identity_revisions (target_id, command_key);

CREATE TABLE "__SCHEMA__".map_projections (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  identity_revision INTEGER NOT NULL CHECK (identity_revision >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  ingest_cursor INTEGER NOT NULL DEFAULT 0 CHECK (ingest_cursor >= 0),
  source_watermark INTEGER,
  last_error TEXT,
  rebuild_completeness TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_projections_status_check CHECK (status IN ('active','shadow','ready','failed','superseded')),
  CONSTRAINT map_projections_completeness_check
    CHECK (rebuild_completeness IS NULL OR rebuild_completeness IN ('complete','partial','unknown'))
);
CREATE UNIQUE INDEX map_projections_generation_idx ON "__SCHEMA__".map_projections (target_id, generation);
CREATE UNIQUE INDEX map_projections_target_id_idx ON "__SCHEMA__".map_projections (target_id, id);
CREATE INDEX map_projections_status_idx ON "__SCHEMA__".map_projections (target_id, status);

CREATE TABLE "__SCHEMA__".map_projection_heads (
  target_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  current_projection_id UUID NOT NULL,
  identity_revision INTEGER NOT NULL DEFAULT 0 CHECK (identity_revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_projection_heads_current_fk
    FOREIGN KEY (target_id, current_projection_id)
    REFERENCES "__SCHEMA__".map_projections (target_id, id) ON DELETE RESTRICT
);

CREATE TABLE "__SCHEMA__".map_identity_assignments (
  id UUID PRIMARY KEY,
  projection_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  target_id UUID NOT NULL,
  page_id UUID,
  object_id UUID,
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_identity_assignments_projection_fk
    FOREIGN KEY (target_id, projection_id)
    REFERENCES "__SCHEMA__".map_projections (target_id, id) ON DELETE RESTRICT,
  CONSTRAINT map_identity_assignments_observation_fk
    FOREIGN KEY (observation_id, target_id)
    REFERENCES "__SCHEMA__".map_observations (id, target_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_identity_assignments_rev_idx
  ON "__SCHEMA__".map_identity_assignments (projection_id, observation_id, assignment_revision);
CREATE INDEX map_identity_assignments_obs_idx
  ON "__SCHEMA__".map_identity_assignments (projection_id, observation_id);

CREATE TABLE "__SCHEMA__".map_object_descriptors (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL,
  object_id UUID NOT NULL,
  implementation_key TEXT NOT NULL,
  descriptor_version INTEGER NOT NULL CHECK (descriptor_version >= 1),
  features JSONB NOT NULL,
  condition_snapshot JSONB NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_object_descriptors_digest_check CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT map_object_descriptors_object_fk
    FOREIGN KEY (target_id, object_id)
    REFERENCES "__SCHEMA__".map_objects (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_object_descriptors_ver_idx
  ON "__SCHEMA__".map_object_descriptors (object_id, implementation_key, descriptor_version);
CREATE UNIQUE INDEX map_object_descriptors_digest_idx
  ON "__SCHEMA__".map_object_descriptors (object_id, implementation_key, content_digest);
CREATE UNIQUE INDEX map_object_descriptors_fk_idx
  ON "__SCHEMA__".map_object_descriptors (object_id, implementation_key, descriptor_version);

CREATE TABLE "__SCHEMA__".map_implementations (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL,
  object_id UUID NOT NULL,
  implementation_key TEXT NOT NULL,
  current_descriptor_version INTEGER,
  condition_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_implementations_object_fk
    FOREIGN KEY (target_id, object_id)
    REFERENCES "__SCHEMA__".map_objects (target_id, id) ON DELETE RESTRICT,
  CONSTRAINT map_implementations_descriptor_fk
    FOREIGN KEY (object_id, implementation_key, current_descriptor_version)
    REFERENCES "__SCHEMA__".map_object_descriptors (object_id, implementation_key, descriptor_version)
);
CREATE UNIQUE INDEX map_implementations_key_idx
  ON "__SCHEMA__".map_implementations (object_id, implementation_key);
CREATE UNIQUE INDEX map_implementations_target_key_idx
  ON "__SCHEMA__".map_implementations (target_id, object_id, implementation_key);

CREATE TABLE "__SCHEMA__".map_projection_assets (
  id UUID PRIMARY KEY,
  projection_id UUID NOT NULL,
  target_id UUID NOT NULL,
  asset_ref_key TEXT NOT NULL,
  page_id UUID,
  object_id UUID,
  implementation_key TEXT,
  descriptor_version INTEGER,
  lifecycle TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 0 CHECK (importance >= 0),
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  reject_reasons JSONB NOT NULL,
  dimensions JSONB NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  change_count INTEGER NOT NULL DEFAULT 0 CHECK (change_count >= 0),
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_projection_assets_lifecycle_check
    CHECK (lifecycle IN ('DISCOVERED','OBSERVED','VERIFIED','TRUSTED','DEGRADED','STALE','RETIRED')),
  CONSTRAINT map_projection_assets_projection_fk
    FOREIGN KEY (target_id, projection_id)
    REFERENCES "__SCHEMA__".map_projections (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_projection_assets_ref_idx
  ON "__SCHEMA__".map_projection_assets (projection_id, asset_ref_key);
CREATE INDEX map_projection_assets_object_idx
  ON "__SCHEMA__".map_projection_assets (projection_id, object_id);

CREATE TABLE "__SCHEMA__".map_conflicts (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  projection_id UUID,
  conflict_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  payload JSONB NOT NULL,
  handling_revision INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_conflicts_status_check CHECK (status IN ('open','resolved'))
);
CREATE UNIQUE INDEX map_conflicts_key_idx ON "__SCHEMA__".map_conflicts (target_id, conflict_key);

CREATE TABLE "__SCHEMA__".map_releases (
  id UUID PRIMARY KEY,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE RESTRICT,
  release_no INTEGER NOT NULL CHECK (release_no >= 1),
  projection_id UUID NOT NULL,
  policy_version TEXT NOT NULL,
  source_watermark INTEGER NOT NULL CHECK (source_watermark >= 0),
  manifest_digest TEXT NOT NULL,
  manifest JSONB NOT NULL,
  command_key TEXT NOT NULL,
  sealed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT map_releases_digest_check CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT map_releases_projection_fk
    FOREIGN KEY (target_id, projection_id)
    REFERENCES "__SCHEMA__".map_projections (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_releases_no_idx ON "__SCHEMA__".map_releases (target_id, release_no);
CREATE UNIQUE INDEX map_releases_cmd_idx ON "__SCHEMA__".map_releases (target_id, command_key);
CREATE UNIQUE INDEX map_releases_target_id_idx ON "__SCHEMA__".map_releases (target_id, id);
CREATE UNIQUE INDEX map_releases_digest_idx ON "__SCHEMA__".map_releases (target_id, manifest_digest);

CREATE TABLE "__SCHEMA__".map_release_items (
  id UUID PRIMARY KEY,
  release_id UUID NOT NULL,
  target_id UUID NOT NULL,
  asset_ref_key TEXT NOT NULL,
  page_id UUID,
  object_id UUID,
  implementation_key TEXT,
  descriptor_version INTEGER,
  identity_revision INTEGER NOT NULL CHECK (identity_revision >= 0),
  lifecycle TEXT NOT NULL,
  executable INTEGER NOT NULL DEFAULT 0 CHECK (executable IN (0, 1)),
  condition_snapshot JSONB,
  features JSONB,
  CONSTRAINT map_release_items_lifecycle_check
    CHECK (lifecycle IN ('DISCOVERED','OBSERVED','VERIFIED','TRUSTED','DEGRADED','STALE','RETIRED')),
  CONSTRAINT map_release_items_release_fk
    FOREIGN KEY (target_id, release_id)
    REFERENCES "__SCHEMA__".map_releases (target_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX map_release_items_ref_idx ON "__SCHEMA__".map_release_items (release_id, asset_ref_key);
