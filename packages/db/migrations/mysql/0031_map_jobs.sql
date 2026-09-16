-- 0047 的 MySQL 等价增量：Target 授权、作业政策、安全进入与作业分片。

ALTER TABLE runs DROP CHECK runs_actor_shape;
ALTER TABLE runs ADD CONSTRAINT runs_actor_shape CHECK (
  (created_by_console_account_id IS NOT NULL AND service_caller_id IS NULL AND service_credential_id IS NULL AND service_admission IS NULL)
  OR (created_by_console_account_id IS NULL AND service_caller_id IS NOT NULL AND service_credential_id IS NOT NULL AND service_admission IS NOT NULL AND deadline_at IS NOT NULL AND idempotency_key IS NOT NULL)
);

CREATE TABLE target_access_policies (
  target_id VARCHAR(36) NOT NULL,
  policy_schema_version INT NOT NULL,
  policy_version INT NOT NULL,
  rules_json JSON NOT NULL,
  policy_digest VARCHAR(64) NOT NULL,
  revision INT NOT NULL,
  updated_by VARCHAR(36) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT target_access_policies_pkey PRIMARY KEY (target_id),
  CONSTRAINT target_access_policies_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE target_access_policy_commands (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  command_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT target_access_policy_commands_pkey PRIMARY KEY (id),
  CONSTRAINT target_access_policy_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT target_access_policy_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_job_policies (
  target_id VARCHAR(36) NOT NULL,
  policy_schema_version INT NOT NULL,
  policy_version INT NOT NULL,
  manual_jobs_enabled TINYINT(1) NOT NULL,
  max_probe_pages INT NOT NULL,
  max_probe_objects INT NOT NULL,
  max_probe_actions INT NOT NULL,
  max_probe_seconds INT NOT NULL,
  max_refresh_pages INT NOT NULL,
  max_refresh_objects INT NOT NULL,
  max_refresh_actions INT NOT NULL,
  max_refresh_seconds INT NOT NULL,
  slice_work_seconds INT NOT NULL,
  default_depth VARCHAR(16) NOT NULL,
  static_refresh_days INT NOT NULL,
  revision INT NOT NULL,
  updated_by VARCHAR(36) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_job_policies_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_job_policies_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_job_policy_commands (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  command_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_job_policy_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_job_policy_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT map_job_policy_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_safe_entries (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  entry_version INT NOT NULL,
  entry_name VARCHAR(128) NOT NULL,
  entry_url VARCHAR(2048) NOT NULL,
  arrival_name VARCHAR(128) NOT NULL,
  arrival_target JSON NOT NULL,
  safety_basis JSON NOT NULL,
  job_kinds JSON NOT NULL,
  command_key VARCHAR(128) NOT NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_safe_entries_pkey PRIMARY KEY (id),
  CONSTRAINT map_safe_entries_cmd UNIQUE (target_id, command_key),
  CONSTRAINT map_safe_entries_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX map_safe_entries_target_idx ON map_safe_entries (target_id, created_at);

CREATE TABLE map_jobs (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  job_kind VARCHAR(16) NOT NULL,
  job_status VARCHAR(16) NOT NULL,
  stop_reason VARCHAR(64),
  revision INT NOT NULL,
  remaining_budget_seconds INT NOT NULL,
  policy_revision INT NOT NULL,
  entry_id VARCHAR(36) NOT NULL,
  release_id VARCHAR(36),
  request_json JSON NOT NULL,
  frozen_policy_json JSON NOT NULL,
  active_guard VARCHAR(1),
  created_by VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT map_jobs_kind_check CHECK (job_kind IN ('map_probe','map_refresh')),
  CONSTRAINT map_jobs_status_check CHECK (job_status IN ('queued','running','completed','cancelled','failed')),
  CONSTRAINT map_jobs_active_target UNIQUE (target_id, active_guard),
  CONSTRAINT map_jobs_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_jobs_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id),
  CONSTRAINT map_jobs_entry_fk FOREIGN KEY (entry_id) REFERENCES map_safe_entries(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX map_jobs_target_idx ON map_jobs (target_id, created_at);

CREATE TABLE map_job_slices (
  id VARCHAR(36) NOT NULL,
  job_id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  slice_ordinal INT NOT NULL,
  run_id VARCHAR(36) NOT NULL,
  reserved_seconds INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_job_slices_pkey PRIMARY KEY (id),
  CONSTRAINT map_job_slices_ord UNIQUE (job_id, slice_ordinal),
  CONSTRAINT map_job_slices_run UNIQUE (run_id),
  CONSTRAINT map_job_slices_job_fk FOREIGN KEY (job_id) REFERENCES map_jobs(id),
  CONSTRAINT map_job_slices_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT map_job_slices_run_fk FOREIGN KEY (run_id) REFERENCES runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX map_job_slices_target_idx ON map_job_slices (target_id, created_at);

CREATE TABLE map_job_commands (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  command_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_job_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_job_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT map_job_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'map:maintain' AS permission
  UNION ALL SELECT 'operator', 'map:maintain'
) p ON p.role_key = r.`key`
WHERE r.kind = 'system';
