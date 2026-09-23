-- 0104 的 MySQL 等价增量：自动化资产退化信号、桶化窗口、增量评价快照与故障归并账本。

CREATE TABLE IF NOT EXISTS reliability_signals (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  severity VARCHAR(16) NOT NULL DEFAULT 'WARN',
  subject_ref JSON NOT NULL,
  source_ref JSON NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  commit_position BIGINT NULL,
  value DOUBLE NULL,
  unit VARCHAR(32) NULL,
  scope_digest VARCHAR(64) NOT NULL,
  grouping_key VARCHAR(64) NULL,
  availability VARCHAR(16) NOT NULL DEFAULT 'available',
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT reliability_signals_pkey PRIMARY KEY (id),
  CONSTRAINT reliability_signals_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_rel_signals_target_occurred ON reliability_signals (target_id, occurred_at);
CREATE INDEX idx_rel_signals_grouping ON reliability_signals (grouping_key);
CREATE INDEX idx_rel_signals_scope ON reliability_signals (scope_digest);


CREATE TABLE IF NOT EXISTS feature_windows (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scope_digest VARCHAR(64) NOT NULL,
  window_type VARCHAR(32) NOT NULL,
  window_start DATETIME(3) NOT NULL,
  window_end DATETIME(3) NOT NULL,
  metric_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  sample_count INT NOT NULL DEFAULT 0,
  primary_hit_count INT NOT NULL DEFAULT 0,
  fallback_count INT NOT NULL DEFAULT 0,
  retry_step_count INT NOT NULL DEFAULT 0,
  ewma_latency_ms DOUBLE NOT NULL DEFAULT 0,
  ewma_success_rate DOUBLE NOT NULL DEFAULT 1.0,
  stats JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT feature_windows_pkey PRIMARY KEY (id),
  CONSTRAINT feature_windows_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE,
  CONSTRAINT uq_feature_windows_target_scope_win UNIQUE (target_id, scope_digest, window_type, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_feature_windows_target_end ON feature_windows (target_id, window_end);


CREATE TABLE IF NOT EXISTS baseline_revisions (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scope_digest VARCHAR(64) NOT NULL,
  baseline_kind VARCHAR(32) NOT NULL,
  algorithm_version VARCHAR(16) NOT NULL DEFAULT '1.0',
  sample_floor INT NOT NULL DEFAULT 10,
  stats JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ready',
  excluded_reasons JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT baseline_revisions_pkey PRIMARY KEY (id),
  CONSTRAINT baseline_revisions_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_baseline_revisions_target_scope_kind ON baseline_revisions (target_id, scope_digest, baseline_kind);


CREATE TABLE IF NOT EXISTS reliability_evaluations (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scope_digest VARCHAR(64) NOT NULL,
  watermark_vector JSON NOT NULL,
  generation INT NOT NULL DEFAULT 1,
  rules_evaluated INT NOT NULL DEFAULT 0,
  breaches_count INT NOT NULL DEFAULT 0,
  result JSON NOT NULL,
  coverage_gaps JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT reliability_evaluations_pkey PRIMARY KEY (id),
  CONSTRAINT reliability_evaluations_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_rel_evaluations_target_generation ON reliability_evaluations (target_id, generation);
CREATE INDEX idx_rel_evaluations_target_created ON reliability_evaluations (target_id, created_at);


CREATE TABLE IF NOT EXISTS reliability_checkpoints (
  target_id VARCHAR(36) NOT NULL,
  watermark_vector JSON NOT NULL,
  fencing_token BIGINT NOT NULL DEFAULT 0,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT reliability_checkpoints_pkey PRIMARY KEY (target_id),
  CONSTRAINT reliability_checkpoints_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;


CREATE TABLE IF NOT EXISTS reliability_incidents (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  grouping_key VARCHAR(64) NOT NULL,
  scope_digest VARCHAR(64) NOT NULL,
  severity VARCHAR(8) NOT NULL DEFAULT 'P3',
  status VARCHAR(24) NOT NULL DEFAULT 'DETECTED',
  action_required_reason VARCHAR(64) NULL,
  member_count INT NOT NULL DEFAULT 1,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  title VARCHAR(255) NOT NULL,
  summary TEXT NOT NULL,
  root_cause_hypothesis TEXT NULL,
  evidence_scores JSON NOT NULL,
  silenced_until DATETIME(3) NULL,
  dismissed_reason TEXT NULL,
  lineage JSON NULL,
  revision INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT reliability_incidents_pkey PRIMARY KEY (id),
  CONSTRAINT reliability_incidents_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_rel_incidents_target_status ON reliability_incidents (target_id, status);
CREATE INDEX idx_rel_incidents_grouping ON reliability_incidents (target_id, grouping_key);
CREATE INDEX idx_rel_incidents_last_seen ON reliability_incidents (target_id, last_seen_at);


CREATE TABLE IF NOT EXISTS reliability_incident_members (
  id VARCHAR(36) NOT NULL,
  incident_id VARCHAR(36) NOT NULL,
  member_ref VARCHAR(128) NOT NULL,
  member_type VARCHAR(32) NOT NULL,
  joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT reliability_incident_members_pkey PRIMARY KEY (id),
  CONSTRAINT reliability_incident_members_incident_fk FOREIGN KEY (incident_id) REFERENCES reliability_incidents(id) ON DELETE CASCADE,
  CONSTRAINT uq_rel_inc_members_uniq UNIQUE (incident_id, member_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_rel_inc_members_incident ON reliability_incident_members (incident_id);


CREATE TABLE IF NOT EXISTS map_change_candidates (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  asset_ref JSON NOT NULL,
  before_ref JSON NULL,
  after_ref JSON NULL,
  change_level VARCHAR(16) NOT NULL,
  conditions JSON NOT NULL,
  observations_count INT NOT NULL DEFAULT 1,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  evidence_score DOUBLE NULL,
  counter_evidence_score DOUBLE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT map_change_candidates_pkey PRIMARY KEY (id),
  CONSTRAINT map_change_candidates_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX idx_map_change_candidates_target_status ON map_change_candidates (target_id, status);
