-- 0049 的 MySQL 等价增量：平台调度计划、窗口 occurrence、事件与写命令。

CREATE TABLE schedules (
  id VARCHAR(36) NOT NULL,
  target_id VARCHAR(36) NOT NULL,
  target_account_id VARCHAR(36) NOT NULL,
  consumer_key VARCHAR(32) NOT NULL,
  enabled TINYINT(1) NOT NULL,
  revision INT NOT NULL,
  current_version_id VARCHAR(36) NOT NULL,
  next_due_at DATETIME(3) NULL,
  created_by VARCHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT schedules_pkey PRIMARY KEY (id),
  CONSTRAINT schedules_account_consumer UNIQUE (target_account_id, consumer_key),
  CONSTRAINT schedules_target_fk FOREIGN KEY (target_id) REFERENCES targets(id),
  CONSTRAINT schedules_account_fk FOREIGN KEY (target_account_id) REFERENCES target_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX schedules_due_idx ON schedules (enabled, next_due_at);
CREATE INDEX schedules_target_idx ON schedules (target_id, created_at);

CREATE TABLE schedule_versions (
  id VARCHAR(36) NOT NULL,
  schedule_id VARCHAR(36) NOT NULL,
  revision INT NOT NULL,
  timezone VARCHAR(64) NOT NULL,
  weekdays JSON NOT NULL,
  window_start VARCHAR(8) NOT NULL,
  window_end VARCHAR(8) NOT NULL,
  misfire VARCHAR(16) NOT NULL,
  consumer JSON NOT NULL,
  authorized_actor_id VARCHAR(36) NOT NULL,
  content_digest VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT schedule_versions_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_versions_rev UNIQUE (schedule_id, revision),
  CONSTRAINT schedule_versions_schedule_fk FOREIGN KEY (schedule_id) REFERENCES schedules(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE schedule_occurrences (
  id VARCHAR(36) NOT NULL,
  schedule_id VARCHAR(36) NOT NULL,
  schedule_version_id VARCHAR(36) NOT NULL,
  local_slot_key VARCHAR(128) NOT NULL,
  occurrence_key VARCHAR(160) NULL,
  local_start_date VARCHAR(16) NOT NULL,
  window_start_utc DATETIME(3) NULL,
  window_end_utc DATETIME(3) NULL,
  start_offset_minutes INT NULL,
  end_offset_minutes INT NULL,
  time_rule_version VARCHAR(32) NOT NULL,
  admission_status VARCHAR(16) NOT NULL,
  reason VARCHAR(64) NULL,
  job_id VARCHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  admitted_at DATETIME(3) NULL,
  CONSTRAINT schedule_occurrences_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_occurrences_slot UNIQUE (schedule_id, local_slot_key),
  CONSTRAINT schedule_occurrences_key UNIQUE (occurrence_key),
  CONSTRAINT schedule_occurrences_job UNIQUE (job_id),
  CONSTRAINT schedule_occurrences_schedule_fk FOREIGN KEY (schedule_id) REFERENCES schedules(id),
  CONSTRAINT schedule_occurrences_version_fk FOREIGN KEY (schedule_version_id) REFERENCES schedule_versions(id),
  CONSTRAINT schedule_occurrences_job_fk FOREIGN KEY (job_id) REFERENCES map_jobs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE INDEX schedule_occurrences_due_idx ON schedule_occurrences (admission_status, window_end_utc);

CREATE TABLE schedule_events (
  id VARCHAR(36) NOT NULL,
  schedule_id VARCHAR(36) NOT NULL,
  seq INT NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT schedule_events_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_events_seq UNIQUE (schedule_id, seq),
  CONSTRAINT schedule_events_schedule_fk FOREIGN KEY (schedule_id) REFERENCES schedules(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE TABLE schedule_commands (
  id VARCHAR(36) NOT NULL,
  command_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  result JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT schedule_commands_pkey PRIMARY KEY (id),
  CONSTRAINT schedule_commands_key UNIQUE (command_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

INSERT IGNORE INTO console_role_permissions (console_role_id, permission)
SELECT r.id, p.permission
FROM console_roles r
JOIN (
  SELECT 'admin' AS role_key, 'schedule:read' AS permission
  UNION ALL SELECT 'admin', 'schedule:write'
  UNION ALL SELECT 'operator', 'schedule:read'
  UNION ALL SELECT 'operator', 'schedule:write'
) p ON p.role_key = r.`key`
WHERE r.kind = 'system';
