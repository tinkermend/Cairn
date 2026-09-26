-- 0127：录制意图泛化工作层表（recording_generalizations）与 outcome_results provenance 扩充 generalized。

ALTER TABLE "__SCHEMA__".outcome_results DROP CONSTRAINT IF EXISTS outcome_results_provenance_check;
ALTER TABLE "__SCHEMA__".outcome_results
  ADD CONSTRAINT outcome_results_provenance_check CHECK (
    provenance IN ('manual', 'module_inherited', 'recorded', 'ai_compiled', 'legacy_assert', 'runtime_invariant', 'imported', 'generalized')
  );

CREATE TABLE "__SCHEMA__".recording_generalizations (
  id UUID PRIMARY KEY,
  recording_draft_id UUID NOT NULL REFERENCES "__SCHEMA__".recording_drafts(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL DEFAULT 'editing' CHECK (status IN ('editing', 'handed_off')),
  fact_digest TEXT NOT NULL,
  suggestion_digest TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  rounds JSONB NOT NULL DEFAULT '[]'::jsonb,
  handed_off_scenario_id UUID REFERENCES "__SCHEMA__".scenarios(id) ON DELETE SET NULL,
  handed_off_receipt_id UUID REFERENCES "__SCHEMA__".recording_import_receipts(id) ON DELETE SET NULL,
  created_by_console_account_id UUID NOT NULL REFERENCES "__SCHEMA__".console_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recording_generalizations_draft_unique UNIQUE (recording_draft_id)
);

CREATE INDEX recording_generalizations_draft_idx ON "__SCHEMA__".recording_generalizations (recording_draft_id);
CREATE INDEX recording_generalizations_status_idx ON "__SCHEMA__".recording_generalizations (status);
CREATE INDEX recording_generalizations_scenario_idx ON "__SCHEMA__".recording_generalizations (handed_off_scenario_id);
