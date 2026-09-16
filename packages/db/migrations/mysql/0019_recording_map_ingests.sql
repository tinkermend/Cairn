-- 0035 的 MySQL 等价增量：录制草稿转地图观察的游标。

CREATE TABLE recording_map_ingests (
  recording_draft_id VARCHAR(36) NOT NULL,
  next_index INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  last_error VARCHAR(512) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT recording_map_ingests_pkey PRIMARY KEY (recording_draft_id),
  CONSTRAINT recording_map_ingests_next_index_check CHECK (next_index >= 0),
  CONSTRAINT recording_map_ingests_status_check CHECK (status IN ('pending', 'completed', 'aborted')),
  CONSTRAINT recording_map_ingests_draft_fk FOREIGN KEY (recording_draft_id) REFERENCES recording_drafts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
