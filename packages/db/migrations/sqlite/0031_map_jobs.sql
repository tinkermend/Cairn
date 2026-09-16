-- 0047 的 SQLite 等价增量：Target 授权、作业政策、安全进入与作业分片。

PRAGMA foreign_keys=OFF;

CREATE TABLE runs_deadline_new (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_version_id TEXT NOT NULL,
  target_account_id TEXT,
  created_by_console_account_id TEXT,
  service_caller_id TEXT,
  service_credential_id TEXT,
  service_admission TEXT CHECK (service_admission IS NULL OR json_valid(service_admission)),
  deadline_at TEXT,
  cancel_reason TEXT,
  status TEXT NOT NULL,
  evidence_status TEXT NOT NULL DEFAULT 'PENDING',
  debug_mode TEXT NOT NULL DEFAULT 'runThrough',
  checkpoint TEXT,
  debug_overlay TEXT,
  cancel_requested_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  snapshot TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  context TEXT NOT NULL,
  idempotency_key TEXT,
  idempotency_digest TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_seq INTEGER NOT NULL DEFAULT 0,
  auth_checkpoint TEXT,
  CONSTRAINT runs_created_by_console_account_id_fkey FOREIGN KEY (created_by_console_account_id) REFERENCES console_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT runs_evidence_status_check CHECK ((evidence_status IN ('PENDING', 'COMPLETE', 'INCOMPLETE'))),
  CONSTRAINT runs_debug_mode_check CHECK ((debug_mode IN ('runThrough', 'holdOnFailure', 'holdAfterEach', 'stepByStep'))),
  CONSTRAINT runs_idempotency_pair CHECK (((idempotency_key IS NULL) = (idempotency_digest IS NULL))),
  CONSTRAINT runs_pkey PRIMARY KEY (id),
  CONSTRAINT runs_scenario_id_fkey FOREIGN KEY (scenario_id) REFERENCES scenarios(id) ON DELETE RESTRICT,
  CONSTRAINT runs_scenario_version_id_fkey FOREIGN KEY (scenario_version_id) REFERENCES scenario_versions(id) ON DELETE RESTRICT,
  CONSTRAINT runs_status_check CHECK ((status IN ('QUEUED', 'RUNNING', 'HOLDING', 'RECOVERING', 'WAITING_FOR_AUTH', 'NEEDS_REVIEW', 'SUCCEEDED', 'FAILED', 'CANCELLED'))),
  CONSTRAINT runs_target_account_id_fkey FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT runs_target_id_fkey FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT runs_actor_shape CHECK (
    (created_by_console_account_id IS NOT NULL AND service_caller_id IS NULL AND service_credential_id IS NULL AND service_admission IS NULL)
    OR (created_by_console_account_id IS NULL AND service_caller_id IS NOT NULL AND service_credential_id IS NOT NULL AND service_admission IS NOT NULL AND deadline_at IS NOT NULL AND idempotency_key IS NOT NULL)
  ),
  FOREIGN KEY (service_caller_id, service_credential_id) REFERENCES service_credentials(caller_id, id) ON DELETE RESTRICT
);

INSERT INTO runs_deadline_new (
  id, target_id, scenario_id, scenario_version_id, target_account_id,
  created_by_console_account_id, service_caller_id, service_credential_id,
  service_admission, deadline_at, cancel_reason, status, evidence_status,
  debug_mode, checkpoint, debug_overlay, cancel_requested_at, started_at,
  finished_at, snapshot, snapshot_digest, context, idempotency_key,
  idempotency_digest, deleted_at, deleted_by, created_at, updated_at, event_seq, auth_checkpoint
)
SELECT
  id, target_id, scenario_id, scenario_version_id, target_account_id,
  created_by_console_account_id, service_caller_id, service_credential_id,
  service_admission, deadline_at, cancel_reason, status, evidence_status,
  debug_mode, checkpoint, debug_overlay, cancel_requested_at, started_at,
  finished_at, snapshot, snapshot_digest, context, idempotency_key,
  idempotency_digest, deleted_at, deleted_by, created_at, updated_at, event_seq, auth_checkpoint
FROM runs;

DROP TABLE runs;
ALTER TABLE runs_deadline_new RENAME TO runs;

CREATE UNIQUE INDEX runs_idempotency_idx ON runs(created_by_console_account_id, idempotency_key);
CREATE INDEX runs_claim_idx ON runs(status, created_at, id);
CREATE UNIQUE INDEX runs_idempotency_service_idx ON runs(service_caller_id, idempotency_key);
CREATE INDEX runs_service_status_idx ON runs(service_caller_id, status);
CREATE INDEX runs_deadline_idx ON runs(deadline_at, status);
CREATE INDEX runs_deleted_at_idx ON runs(deleted_at);
CREATE INDEX runs_target_deleted_created_idx ON runs(target_id, deleted_at, created_at);
CREATE INDEX runs_scenario_deleted_created_idx ON runs(scenario_id, deleted_at, created_at);

CREATE TRIGGER runs_deleted_check_ins BEFORE INSERT ON runs WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'runs deleted mismatch'); END;
CREATE TRIGGER runs_deleted_check_upd BEFORE UPDATE ON runs WHEN NOT ((NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR (NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NOT NULL)) BEGIN SELECT RAISE(ABORT, 'runs deleted mismatch'); END;
CREATE TRIGGER runs_snapshot_immutable BEFORE UPDATE ON runs WHEN OLD.snapshot IS NOT NEW.snapshot OR OLD.snapshot_digest IS NOT NEW.snapshot_digest OR OLD.target_id IS NOT NEW.target_id OR OLD.target_account_id IS NOT NEW.target_account_id OR OLD.scenario_id IS NOT NEW.scenario_id OR OLD.scenario_version_id IS NOT NEW.scenario_version_id OR OLD.created_by_console_account_id IS NOT NEW.created_by_console_account_id OR OLD.service_caller_id IS NOT NEW.service_caller_id OR OLD.service_credential_id IS NOT NEW.service_credential_id OR OLD.service_admission IS NOT NEW.service_admission OR OLD.deadline_at IS NOT NEW.deadline_at OR OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.idempotency_digest IS NOT NEW.idempotency_digest BEGIN SELECT RAISE(ABORT, 'runs immutable'); END;

PRAGMA foreign_keys=ON;

CREATE TABLE target_access_policies (
  target_id TEXT NOT NULL,
  policy_schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  rules_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT target_access_policies_pkey PRIMARY KEY (target_id),
  CONSTRAINT target_access_policies_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE target_access_policy_commands (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT target_access_policy_commands_pkey PRIMARY KEY (id),
  CONSTRAINT target_access_policy_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT target_access_policy_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_job_policies (
  target_id TEXT NOT NULL,
  policy_schema_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  manual_jobs_enabled INTEGER NOT NULL,
  max_probe_pages INTEGER NOT NULL,
  max_probe_objects INTEGER NOT NULL,
  max_probe_actions INTEGER NOT NULL,
  max_probe_seconds INTEGER NOT NULL,
  max_refresh_pages INTEGER NOT NULL,
  max_refresh_objects INTEGER NOT NULL,
  max_refresh_actions INTEGER NOT NULL,
  max_refresh_seconds INTEGER NOT NULL,
  slice_work_seconds INTEGER NOT NULL,
  default_depth TEXT NOT NULL,
  static_refresh_days INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_job_policies_pkey PRIMARY KEY (target_id),
  CONSTRAINT map_job_policies_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_job_policy_commands (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_job_policy_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_job_policy_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT map_job_policy_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

CREATE TABLE map_safe_entries (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  entry_version INTEGER NOT NULL CHECK (entry_version >= 1),
  entry_name TEXT NOT NULL,
  entry_url TEXT NOT NULL,
  arrival_name TEXT NOT NULL,
  arrival_target TEXT NOT NULL,
  safety_basis TEXT NOT NULL,
  job_kinds TEXT NOT NULL,
  command_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_safe_entries_pkey PRIMARY KEY (id),
  CONSTRAINT map_safe_entries_cmd UNIQUE (target_id, command_key),
  CONSTRAINT map_safe_entries_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);
CREATE INDEX map_safe_entries_target_idx ON map_safe_entries (target_id, created_at);

CREATE TABLE map_jobs (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('map_probe','map_refresh')),
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
CREATE INDEX map_jobs_target_idx ON map_jobs (target_id, created_at);

CREATE TABLE map_job_slices (
  id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  slice_ordinal INTEGER NOT NULL CHECK (slice_ordinal >= 0),
  run_id TEXT NOT NULL,
  reserved_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_job_slices_pkey PRIMARY KEY (id),
  CONSTRAINT map_job_slices_ord UNIQUE (job_id, slice_ordinal),
  CONSTRAINT map_job_slices_run UNIQUE (run_id),
  CONSTRAINT map_job_slices_job_fk FOREIGN KEY (job_id) REFERENCES map_jobs(id) ON DELETE RESTRICT,
  CONSTRAINT map_job_slices_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT map_job_slices_run_fk FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT
);
CREATE INDEX map_job_slices_target_idx ON map_job_slices (target_id, created_at);

CREATE TABLE map_job_commands (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT map_job_commands_pkey PRIMARY KEY (id),
  CONSTRAINT map_job_commands_key UNIQUE (target_id, command_key),
  CONSTRAINT map_job_commands_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT
);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'map:maintain' AS permission
  UNION ALL SELECT 'operator', 'map:maintain'
) AS p ON p.role_key = r.key
WHERE r.kind = 'system';
