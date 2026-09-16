-- 0044 的 MySQL 等价增量：场景编写文档 V2、模块清册与动作模块引用关联

ALTER TABLE scenarios
  ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'user';

ALTER TABLE scenario_versions
  ADD COLUMN authoring_document JSON,
  ADD COLUMN module_manifest JSON;

CREATE TABLE scenario_module_refs (
  id VARCHAR(36) NOT NULL,
  scenario_id VARCHAR(36) NOT NULL,
  scenario_version_id VARCHAR(36),
  invocation_id VARCHAR(36) NOT NULL,
  module_id VARCHAR(36) NOT NULL,
  module_version_id VARCHAR(36),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT scenario_module_refs_pkey PRIMARY KEY (id),
  CONSTRAINT scenario_module_refs_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE CASCADE,
  CONSTRAINT scenario_module_refs_scenario_ver_fk FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE CASCADE,
  CONSTRAINT scenario_module_refs_module_fk FOREIGN KEY (module_id) REFERENCES action_modules(id) ON DELETE CASCADE,
  CONSTRAINT scenario_module_refs_module_ver_fk FOREIGN KEY (module_version_id) REFERENCES action_module_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX scenario_module_refs_scenario_ver_idx ON scenario_module_refs (scenario_id, scenario_version_id);
CREATE INDEX scenario_module_refs_module_ver_idx ON scenario_module_refs (module_id, module_version_id);
