-- 0057：结果轴与 Outcome 契约底座（runs/step_runs 结果状态列与 outcome_results 表）

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN outcome_status TEXT NOT NULL DEFAULT 'NOT_EVALUATED',
  ADD CONSTRAINT runs_outcome_status_check CHECK (
    outcome_status IN ('PASS', 'WARN', 'FAIL', 'UNKNOWN', 'NOT_EVALUATED')
  );

ALTER TABLE "__SCHEMA__".step_runs
  ADD COLUMN outcome_status TEXT NOT NULL DEFAULT 'NOT_EVALUATED',
  ADD CONSTRAINT step_runs_outcome_status_check CHECK (
    outcome_status IN ('PASS', 'WARN', 'FAIL', 'UNKNOWN', 'NOT_EVALUATED')
  );

CREATE TABLE "__SCHEMA__".outcome_results (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  step_run_id UUID NOT NULL REFERENCES "__SCHEMA__".step_runs(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES "__SCHEMA__".attempts(id) ON DELETE RESTRICT,
  contract_id UUID NOT NULL,
  scope TEXT NOT NULL,
  meaning TEXT NOT NULL,
  severity TEXT NOT NULL,
  on_violation TEXT NOT NULL,
  provenance TEXT NOT NULL,
  verdict TEXT NOT NULL,
  expected JSONB,
  actual JSONB,
  evidence_id UUID REFERENCES "__SCHEMA__".evidences(id) ON DELETE RESTRICT,
  details JSONB,
  evaluated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outcome_results_scope_check CHECK (scope IN ('step', 'scenario')),
  CONSTRAINT outcome_results_severity_check CHECK (severity IN ('MUST', 'SHOULD', 'INFO')),
  CONSTRAINT outcome_results_on_violation_check CHECK (on_violation IN ('halt', 'continue')),
  CONSTRAINT outcome_results_provenance_check CHECK (
    provenance IN ('manual', 'module_inherited', 'recorded', 'ai_compiled', 'legacy_assert')
  ),
  CONSTRAINT outcome_results_verdict_check CHECK (verdict IN ('PASS', 'WARN', 'FAIL', 'UNKNOWN'))
);

CREATE UNIQUE INDEX outcome_results_attempt_contract_idx
  ON "__SCHEMA__".outcome_results (attempt_id, contract_id);

CREATE INDEX outcome_results_run_idx
  ON "__SCHEMA__".outcome_results (run_id);

CREATE INDEX outcome_results_step_run_idx
  ON "__SCHEMA__".outcome_results (step_run_id);

CREATE INDEX outcome_results_verdict_idx
  ON "__SCHEMA__".outcome_results (verdict);
