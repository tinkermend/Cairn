-- 0052 的 SQLite 等价增量：Target 探索政策、OCC 收据、系统角色 map:explore，以及作业 kind 纳入 map_explore。

PRAGMA foreign_keys=OFF;

CREATE TABLE map_jobs_explore (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('map_probe','map_refresh','map_explore')),
  job_status TEXT NOT NULL CHECK (job_status IN ('queued','running','completed','cancelled','failed')),
  stop_reason TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  remaining_budget_seconds INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  release_id TEXT,
  request_json TEXT NOT NULL,
  frozen_policy_json TEXT NOT NULL,
  active_guard TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_jobs_pkey PRIMARY KEY (id),
  CONSTRAINT map_jobs_active_target UNIQUE (target_id, active_guard),
  CONSTRAINT map_jobs_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT map_jobs_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT map_jobs_entry_fk FOREIGN KEY (entry_id) REFERENCES map_safe_entries(id) ON DELETE RESTRICT
);

INSERT INTO map_jobs_explore SELECT * FROM map_jobs;
DROP TABLE map_jobs;
ALTER TABLE map_jobs_explore RENAME TO map_jobs;
CREATE INDEX map_jobs_target_idx ON map_jobs (target_id, created_at);

PRAGMA foreign_keys=ON;

CREATE TABLE map_exploration_policies (
  target_id TEXT NOT NULL,
  policy_schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  explore_enabled INTEGER NOT NULL CHECK (explore_enabled IN (0, 1)),
  explore_mode TEXT NOT NULL,
  model_enabled INTEGER NOT NULL CHECK (model_enabled IN (0, 1)),
  max_hop_depth INTEGER NOT NULL,
  max_new_pages INTEGER NOT NULL,
  max_candidates INTEGER NOT NULL,
  max_actions INTEGER NOT NULL,
  max_seconds INTEGER NOT NULL,
  slice_work_seconds INTEGER NOT NULL,
  allowlist_json TEXT NOT NULL,
  seed_refs_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_exploration_policies_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_exploration_policies_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_exploration_policy_commands (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_exploration_policy_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_exploration_policy_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT map_exploration_policy_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'map:explore' AS permission
  UNION ALL SELECT 'operator', 'map:explore'
) AS p ON p.role_key = r.key
WHERE r.kind = 'system';
