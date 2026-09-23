-- 0110：动作模块测试用例、执行快照、结果判定与测试批次表

CREATE TABLE "__SCHEMA__".module_test_cases (
  id UUID PRIMARY KEY,
  module_id UUID NOT NULL REFERENCES "__SCHEMA__".action_modules(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  contract_digest TEXT NOT NULL,
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_module_outcome TEXT NOT NULL DEFAULT 'VERIFIED',
  expected_failure_code TEXT,
  expected_outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  implementation_key TEXT NOT NULL DEFAULT 'default',
  release_gate BOOLEAN NOT NULL DEFAULT true,
  target_account_id UUID REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE SET NULL,
  sample_review JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT module_test_cases_status_check CHECK (status IN ('ACTIVE', 'ARCHIVED', 'INCOMPATIBLE'))
);

CREATE INDEX module_test_cases_module_status_idx
  ON "__SCHEMA__".module_test_cases (module_id, status);
CREATE INDEX module_test_cases_module_gate_idx
  ON "__SCHEMA__".module_test_cases (module_id, release_gate);

CREATE TABLE "__SCHEMA__".module_case_executions (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES "__SCHEMA__".module_test_cases(id) ON DELETE CASCADE,
  module_id UUID NOT NULL REFERENCES "__SCHEMA__".action_modules(id) ON DELETE CASCADE,
  case_revision INTEGER NOT NULL,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE CASCADE,
  comparator_version TEXT NOT NULL DEFAULT 'v1',
  module_draft_revision INTEGER,
  module_version_id UUID REFERENCES "__SCHEMA__".action_module_versions(id) ON DELETE SET NULL,
  content_digest TEXT NOT NULL,
  implementation_key TEXT NOT NULL DEFAULT 'default',
  target_account_id UUID REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE SET NULL,
  frozen_inputs JSONB NOT NULL,
  frozen_expected_outcome TEXT NOT NULL,
  frozen_expected_failure_code TEXT,
  frozen_expected_outputs JSONB NOT NULL,
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX module_case_executions_run_idx
  ON "__SCHEMA__".module_case_executions (run_id);
CREATE INDEX module_case_executions_case_idx
  ON "__SCHEMA__".module_case_executions (case_id, case_revision);
CREATE INDEX module_case_executions_module_idx
  ON "__SCHEMA__".module_case_executions (module_id, created_at);

CREATE TABLE "__SCHEMA__".module_case_results (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES "__SCHEMA__".module_case_executions(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES "__SCHEMA__".module_test_cases(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PENDING',
  outcome_matched BOOLEAN,
  outputs_matched BOOLEAN,
  evidence_complete BOOLEAN,
  failure_reason TEXT,
  details JSONB,
  projector_version TEXT NOT NULL DEFAULT 'v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  CONSTRAINT module_case_results_status_check CHECK (status IN ('PENDING', 'PASS', 'FAIL', 'INCONCLUSIVE'))
);

CREATE UNIQUE INDEX module_case_results_execution_rev_idx
  ON "__SCHEMA__".module_case_results (execution_id, revision);
CREATE INDEX module_case_results_case_status_idx
  ON "__SCHEMA__".module_case_results (case_id, status);
CREATE INDEX module_case_results_run_idx
  ON "__SCHEMA__".module_case_results (run_id);

CREATE TABLE "__SCHEMA__".module_test_batches (
  id UUID PRIMARY KEY,
  module_id UUID NOT NULL REFERENCES "__SCHEMA__".action_modules(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES "__SCHEMA__".targets(id) ON DELETE CASCADE,
  target_account_id UUID REFERENCES "__SCHEMA__".target_accounts(id) ON DELETE SET NULL,
  total_cases INTEGER NOT NULL,
  passed_cases INTEGER NOT NULL DEFAULT 0,
  failed_cases INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  halt_reason TEXT,
  case_execution_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  confirmed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT module_test_batches_status_check CHECK (status IN ('RUNNING', 'COMPLETED', 'HALTED', 'FAILED'))
);

CREATE INDEX module_test_batches_module_idx
  ON "__SCHEMA__".module_test_batches (module_id, created_at);
