-- 0053 的 SQLite 等价增量：存量库把 map_jobs.job_kind 扩到 map_explore。

PRAGMA foreign_keys=OFF;

CREATE TABLE map_jobs_kind (
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

INSERT INTO map_jobs_kind SELECT * FROM map_jobs;
DROP TABLE map_jobs;
ALTER TABLE map_jobs_kind RENAME TO map_jobs;
CREATE INDEX map_jobs_target_idx ON map_jobs (target_id, created_at);

PRAGMA foreign_keys=ON;
