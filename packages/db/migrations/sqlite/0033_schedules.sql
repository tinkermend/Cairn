-- 0049 的 SQLite 等价增量：平台调度计划、窗口 occurrence、事件与写命令。

CREATE TABLE schedules (
  id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_account_id TEXT NOT NULL,
  consumer_key TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  current_version_id TEXT NOT NULL,
  next_due_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT schedules_pkey PRIMARY KEY (id),
  CONSTRAINT schedules_account_consumer UNIQUE (target_account_id, consumer_key),
  CONSTRAINT schedules_target_fk FOREIGN KEY (target_id) REFERENCES targets(id) ON DELETE RESTRICT,
  CONSTRAINT schedules_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id) ON DELETE RESTRICT
);

CREATE INDEX schedules_due_idx ON schedules (enabled, next_due_at);
CREATE INDEX schedules_target_idx ON schedules (target_id, created_at);

CREATE TABLE schedule_versions (
  id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  weekdays TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  misfire TEXT NOT NULL,
  consumer TEXT NOT NULL,
  authorized_actor_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT schedule_versions_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_versions_rev UNIQUE (schedule_id, revision),
  CONSTRAINT schedule_versions_schedule_fk FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE RESTRICT
);

CREATE TABLE schedule_occurrences (
  id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  local_slot_key TEXT NOT NULL,
  occurrence_key TEXT,
  local_start_date TEXT NOT NULL,
  window_start_utc TEXT,
  window_end_utc TEXT,
  start_offset_minutes INTEGER,
  end_offset_minutes INTEGER,
  time_rule_version TEXT NOT NULL,
  admission_status TEXT NOT NULL,
  reason TEXT,
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  admitted_at TEXT,
  CONSTRAINT schedule_occurrences_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_occurrences_slot UNIQUE (schedule_id, local_slot_key),
  CONSTRAINT schedule_occurrences_key UNIQUE (occurrence_key),
  CONSTRAINT schedule_occurrences_job UNIQUE (job_id),
  CONSTRAINT schedule_occurrences_schedule_fk FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE RESTRICT,
  CONSTRAINT schedule_occurrences_version_fk FOREIGN KEY (schedule_version_id) REFERENCES schedule_versions(id) ON DELETE RESTRICT,
  CONSTRAINT schedule_occurrences_job_fk FOREIGN KEY (job_id) REFERENCES map_jobs(id) ON DELETE RESTRICT
);

CREATE INDEX schedule_occurrences_due_idx ON schedule_occurrences (admission_status, window_end_utc);

CREATE TABLE schedule_events (
  id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT schedule_events_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_events_seq UNIQUE (schedule_id, seq),
  CONSTRAINT schedule_events_schedule_fk FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE RESTRICT
);

CREATE TABLE schedule_commands (
  id TEXT NOT NULL,
  command_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT schedule_commands_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_commands_key UNIQUE (command_key)
);

INSERT OR IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'schedule:read' AS permission
  UNION ALL SELECT 'admin', 'schedule:write'
  UNION ALL SELECT 'operator', 'schedule:read'
  UNION ALL SELECT 'operator', 'schedule:write'
) AS p ON p.role_key = r.key
WHERE r.kind = 'system';
