-- 0089：平台助手异步提交、事件分片与模型调用视图增强（MySQL 等价）。

ALTER TABLE assistant_turns
  ADD COLUMN stage VARCHAR(64) NULL,
  ADD COLUMN event_seq INT NOT NULL DEFAULT 0,
  ADD COLUMN queue_position INT NULL,
  ADD COLUMN stop_reason VARCHAR(64) NULL;

ALTER TABLE assistant_turns
  DROP CHECK assistant_turns_status;

ALTER TABLE assistant_turns
  ADD CONSTRAINT assistant_turns_status
  CHECK (status IN ('QUEUED','RUNNING','CLARIFY','COMPLETED','FAILED','CANCELLED','INTERRUPTED'));

ALTER TABLE platform_ai_calls
  ADD COLUMN capability_version VARCHAR(64) NULL,
  ADD COLUMN context_manifest_id VARCHAR(64) NULL,
  ADD COLUMN requested_model VARCHAR(128) NULL,
  ADD COLUMN route VARCHAR(128) NULL,
  ADD COLUMN cost JSON NULL,
  ADD COLUMN error_class VARCHAR(64) NULL,
  ADD COLUMN validation JSON NULL;

CREATE TABLE assistant_turn_events (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  turn_id VARCHAR(36) NOT NULL,
  seq INT NOT NULL,
  channel VARCHAR(32) NOT NULL,
  payload JSON NOT NULL,
  retain_until DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (turn_id) REFERENCES assistant_turns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX assistant_turn_events_turn_seq_idx
  ON assistant_turn_events (turn_id, seq);

CREATE INDEX assistant_turn_events_retain_idx
  ON assistant_turn_events (retain_until);
