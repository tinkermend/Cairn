-- 0044_scenario_action_module_refs：场景编写文档 V2、模块清册与动作模块引用关联

ALTER TABLE "__SCHEMA__".scenarios
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'user';

ALTER TABLE "__SCHEMA__".scenarios
  ADD CONSTRAINT scenarios_purpose_check CHECK (purpose IN ('user', 'module_verification'));

ALTER TABLE "__SCHEMA__".scenario_versions
  ADD COLUMN authoring_document JSONB,
  ADD COLUMN module_manifest JSONB;

CREATE TABLE "__SCHEMA__".scenario_module_refs (
  id UUID PRIMARY KEY,
  scenario_id UUID NOT NULL REFERENCES "__SCHEMA__".scenarios(id) ON DELETE CASCADE,
  scenario_version_id UUID REFERENCES "__SCHEMA__".scenario_versions(id) ON DELETE CASCADE,
  invocation_id UUID NOT NULL,
  module_id UUID NOT NULL REFERENCES "__SCHEMA__".action_modules(id) ON DELETE CASCADE,
  module_version_id UUID REFERENCES "__SCHEMA__".action_module_versions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scenario_module_refs_scenario_ver_idx ON "__SCHEMA__".scenario_module_refs (scenario_id, scenario_version_id);
CREATE INDEX scenario_module_refs_module_ver_idx ON "__SCHEMA__".scenario_module_refs (module_id, module_version_id);
