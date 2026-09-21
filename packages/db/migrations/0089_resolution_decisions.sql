-- 统一目标解析阶梯的运行事实：每个走过阶梯的 Attempt 恰好一条决策。

CREATE TABLE "__SCHEMA__".resolution_decisions (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  step_run_id UUID NOT NULL REFERENCES "__SCHEMA__".step_runs(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES "__SCHEMA__".attempts(id) ON DELETE RESTRICT,
  step_id UUID NOT NULL,
  effective_policy TEXT NOT NULL,
  decision_kind TEXT NOT NULL,
  reason_code TEXT,
  semantic_digest TEXT,
  rungs_json JSONB NOT NULL,
  evidence_refs JSONB NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX resolution_decisions_attempt ON "__SCHEMA__".resolution_decisions (attempt_id);
CREATE INDEX resolution_decisions_run_idx ON "__SCHEMA__".resolution_decisions (run_id, step_run_id, created_at);
CREATE INDEX resolution_decisions_decision_idx ON "__SCHEMA__".resolution_decisions (decision_kind);
