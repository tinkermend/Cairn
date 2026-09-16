-- 0052 的 MySQL 等价增量：Target 探索政策、OCC 收据、系统角色 map:explore，以及作业 kind 纳入 map_explore。

ALTER TABLE map_jobs DROP CHECK map_jobs_kind_check;
ALTER TABLE map_jobs
  ADD CONSTRAINT map_jobs_kind_check CHECK (job_kind IN ('map_probe','map_refresh','map_explore'));

CREATE TABLE map_exploration_policies (
  target_id VARCHAR(36) NOT NULL,
  policy_schema_version INT NOT NULL,
  policy_version INT NOT NULL,
  explore_enabled TINYINT(1) NOT NULL,
  explore_mode VARCHAR(16) NOT NULL,
  model_enabled TINYINT(1) NOT NULL,
  max_hop_depth INT NOT NULL,
  max_new_pages INT NOT NULL,
  max_candidates INT NOT NULL,
  max_actions INT NOT NULL,
  max_seconds INT NOT NULL,
  slice_work_seconds INT NOT NULL,
  allowlist_json JSON NOT NULL,
  seed_refs_json JSON NOT NULL,
  revision INT NOT NULL,
  updated_by VARCHAR(36) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_exploration_policies_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_exploration_policies_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE map_exploration_policy_commands (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  command_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT map_exploration_policy_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_exploration_policy_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT map_exploration_policy_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'map:explore' AS permission
  UNION ALL SELECT 'operator', 'map:explore'
) p ON p.role_key = r.`key`
WHERE r.kind = 'system';
