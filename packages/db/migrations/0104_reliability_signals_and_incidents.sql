-- 0104_reliability_signals_and_incidents：自动化资产退化信号、桶化窗口、增量评价快照与故障归并账本
--
-- 全文幂等：重复执行不产生副作用。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".reliability_signals (
  id                  UUID        PRIMARY KEY,
  target_id           UUID        NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  kind                TEXT        NOT NULL,
  severity            TEXT        NOT NULL DEFAULT 'WARN',
  subject_ref         JSONB       NOT NULL,
  source_ref          JSONB       NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  commit_position     BIGINT,
  value               DOUBLE PRECISION,
  unit                TEXT,
  scope_digest        TEXT        NOT NULL,
  grouping_key        TEXT,
  availability        TEXT        NOT NULL DEFAULT 'available',
  metadata            JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rel_signals_target_occurred
  ON "__SCHEMA__".reliability_signals (target_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_rel_signals_grouping
  ON "__SCHEMA__".reliability_signals (grouping_key);

CREATE INDEX IF NOT EXISTS idx_rel_signals_scope
  ON "__SCHEMA__".reliability_signals (scope_digest);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".feature_windows (
  id                  UUID        PRIMARY KEY,
  target_id           UUID        NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  scope_digest        TEXT        NOT NULL,
  window_type         TEXT        NOT NULL,
  window_start        TIMESTAMPTZ NOT NULL,
  window_end          TIMESTAMPTZ NOT NULL,
  metric_version      TEXT        NOT NULL DEFAULT '1.0',
  sample_count        INT         NOT NULL DEFAULT 0,
  primary_hit_count   INT         NOT NULL DEFAULT 0,
  fallback_count      INT         NOT NULL DEFAULT 0,
  retry_step_count    INT         NOT NULL DEFAULT 0,
  ewma_latency_ms     DOUBLE PRECISION NOT NULL DEFAULT 0,
  ewma_success_rate   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  stats               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_windows_target_scope_win
  ON "__SCHEMA__".feature_windows (target_id, scope_digest, window_type, window_start);

CREATE INDEX IF NOT EXISTS idx_feature_windows_target_end
  ON "__SCHEMA__".feature_windows (target_id, window_end);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".baseline_revisions (
  id                  UUID        PRIMARY KEY,
  target_id           UUID        NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  scope_digest        TEXT        NOT NULL,
  baseline_kind       TEXT        NOT NULL,
  algorithm_version   TEXT        NOT NULL DEFAULT '1.0',
  sample_floor        INT         NOT NULL DEFAULT 10,
  stats               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT        NOT NULL DEFAULT 'ready',
  excluded_reasons    JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_baseline_revisions_target_scope_kind
  ON "__SCHEMA__".baseline_revisions (target_id, scope_digest, baseline_kind);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".reliability_evaluations (
  id                  UUID        PRIMARY KEY,
  target_id           UUID        NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  scope_digest        TEXT        NOT NULL,
  watermark_vector    JSONB       NOT NULL,
  generation          INT         NOT NULL DEFAULT 1,
  rules_evaluated     INT         NOT NULL DEFAULT 0,
  breaches_count      INT         NOT NULL DEFAULT 0,
  result              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  coverage_gaps       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rel_evaluations_target_generation
  ON "__SCHEMA__".reliability_evaluations (target_id, generation);

CREATE INDEX IF NOT EXISTS idx_rel_evaluations_target_created
  ON "__SCHEMA__".reliability_evaluations (target_id, created_at);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".reliability_checkpoints (
  target_id           UUID        PRIMARY KEY REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  watermark_vector    JSONB       NOT NULL,
  fencing_token       BIGINT      NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".reliability_incidents (
  id                    UUID        PRIMARY KEY,
  target_id             UUID        NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  grouping_key          TEXT        NOT NULL,
  scope_digest          TEXT        NOT NULL,
  severity              TEXT        NOT NULL DEFAULT 'P3',
  status                TEXT        NOT NULL DEFAULT 'DETECTED',
  action_required_reason TEXT,
  member_count          INT         NOT NULL DEFAULT 1,
  first_seen_at         TIMESTAMPTZ NOT NULL,
  last_seen_at          TIMESTAMPTZ NOT NULL,
  title                 TEXT        NOT NULL,
  summary               TEXT        NOT NULL,
  root_cause_hypothesis TEXT,
  evidence_scores       JSONB       NOT NULL DEFAULT '{"supportingScore":0,"counterScore":0,"supportingFactors":[],"counterFactors":[]}'::jsonb,
  silenced_until        TIMESTAMPTZ,
  dismissed_reason      TEXT,
  lineage               JSONB,
  revision              INT         NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rel_incidents_target_status
  ON "__SCHEMA__".reliability_incidents (target_id, status);

CREATE INDEX IF NOT EXISTS idx_rel_incidents_grouping
  ON "__SCHEMA__".reliability_incidents (target_id, grouping_key);

CREATE INDEX IF NOT EXISTS idx_rel_incidents_last_seen
  ON "__SCHEMA__".reliability_incidents (target_id, last_seen_at);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".reliability_incident_members (
  id                    UUID        PRIMARY KEY,
  incident_id           UUID        NOT NULL REFERENCES "__SCHEMA__".reliability_incidents (id) ON DELETE CASCADE,
  member_ref            TEXT        NOT NULL,
  member_type           TEXT        NOT NULL,
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rel_inc_members_incident
  ON "__SCHEMA__".reliability_incident_members (incident_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rel_inc_members_uniq
  ON "__SCHEMA__".reliability_incident_members (incident_id, member_ref);


CREATE TABLE IF NOT EXISTS "__SCHEMA__".map_change_candidates (
  id                    UUID        PRIMARY KEY,
  target_id             UUID        NOT NULL REFERENCES "__SCHEMA__".targets (id) ON DELETE CASCADE,
  asset_ref             JSONB       NOT NULL,
  before_ref            JSONB,
  after_ref             JSONB,
  change_level          TEXT        NOT NULL,
  conditions            JSONB       NOT NULL,
  observations_count    INT         NOT NULL DEFAULT 1,
  status                TEXT        NOT NULL DEFAULT 'pending',
  evidence_score        DOUBLE PRECISION,
  counter_evidence_score DOUBLE PRECISION,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_map_change_candidates_target_status
  ON "__SCHEMA__".map_change_candidates (target_id, status);
