-- 0106：受控修复候选 (repair_candidates) 持久化与验证状态。

CREATE TABLE "__SCHEMA__".repair_candidates (
  id UUID PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE CASCADE,
  source_attempt_id UUID NOT NULL,
  patch_target_ref JSONB NOT NULL,
  authoring_origin JSONB,
  patch JSONB NOT NULL,
  hypothesis TEXT NOT NULL,
  applicability TEXT,
  digest_manifest JSONB NOT NULL,
  guard_results JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  validation_scope JSONB NOT NULL,
  validation_refs JSONB,
  adoption JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT repair_candidates_status_check
    CHECK (status IN ('proposed', 'blocked', 'validating', 'validated', 'rejected', 'expired', 'adopted'))
);

CREATE INDEX repair_candidates_run_idx
  ON "__SCHEMA__".repair_candidates (run_id);

CREATE INDEX repair_candidates_status_idx
  ON "__SCHEMA__".repair_candidates (status);

CREATE INDEX repair_candidates_source_attempt_idx
  ON "__SCHEMA__".repair_candidates (source_attempt_id);
