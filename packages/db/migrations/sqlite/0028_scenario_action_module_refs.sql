-- 0044 的 SQLite 等价增量：场景编写文档 V2、模块清册与动作模块引用关联

ALTER TABLE scenarios
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'user';

ALTER TABLE scenario_versions
  ADD COLUMN authoring_document TEXT;

ALTER TABLE scenario_versions
  ADD COLUMN module_manifest TEXT;

CREATE TABLE scenario_module_refs (
  id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_version_id TEXT,
  invocation_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  module_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT scenario_module_refs_pkey PRIMARY KEY (id),
  CONSTRAINT scenario_module_refs_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE,
  CONSTRAINT scenario_module_refs_scenario_ver_fk FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE CASCADE,
  CONSTRAINT scenario_module_refs_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE CASCADE,
  CONSTRAINT scenario_module_refs_module_ver_fk FOREIGN KEY (module_version_id) REFERENCES action_module_versions(id) ON DELETE RESTRICT
);

CREATE INDEX scenario_module_refs_scenario_ver_idx ON scenario_module_refs (scenario_id, scenario_version_id);
CREATE INDEX scenario_module_refs_module_ver_idx ON scenario_module_refs (module_id, module_version_id);
