-- 0096 的 MySQL 等价增量：受管测试夹具资产账本与 stored_objects fixture 外键关联。

CREATE TABLE IF NOT EXISTS target_fixtures (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  scenario_id VARCHAR(36) NULL,
  name VARCHAR(255) NOT NULL,
  content_type VARCHAR(128) NOT NULL,
  byte_size INT NULL,
  digest VARCHAR(128) NULL,
  upload_generation_id VARCHAR(36) NULL,
  upload_deadline_at DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  deleted_by JSON NULL,
  created_by_console_account_id VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT target_fixtures_pkey PRIMARY KEY (id),
  CONSTRAINT target_fixtures_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT target_fixtures_scenario_fk FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  CONSTRAINT target_fixtures_creator_fk FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT target_fixtures_byte_size_check CHECK (byte_size IS NULL OR byte_size >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX target_fixtures_target_idx ON target_fixtures (target_id, created_at);
CREATE INDEX target_fixtures_scenario_idx ON target_fixtures (scenario_id);
CREATE INDEX target_fixtures_deleted_at_idx ON target_fixtures (deleted_at);

ALTER TABLE stored_objects ADD COLUMN fixture_id VARCHAR(36) NULL;
ALTER TABLE stored_objects
  ADD CONSTRAINT stored_objects_fixture_fkey FOREIGN KEY (fixture_id) REFERENCES target_fixtures (id) ON DELETE RESTRICT;
ALTER TABLE stored_objects DROP CHECK stored_objects_owner_check;
ALTER TABLE stored_objects
  ADD CONSTRAINT stored_objects_owner_check CHECK (
    (owner_kind = 'run' AND run_id IS NOT NULL AND artifact_id IS NULL AND fixture_id IS NULL)
    OR (owner_kind = 'artifact' AND artifact_id IS NOT NULL AND run_id IS NULL AND fixture_id IS NULL)
    OR (owner_kind = 'fixture' AND fixture_id IS NOT NULL AND run_id IS NULL AND artifact_id IS NULL)
  );
CREATE INDEX stored_objects_fixture_id_idx ON stored_objects (fixture_id);
