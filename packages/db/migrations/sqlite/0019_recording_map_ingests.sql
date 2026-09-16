-- 0035 的 SQLite 等价增量：录制草稿转地图观察的游标。

CREATE TABLE recording_map_ingests (
  recording_draft_id TEXT NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'aborted')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CONSTRAINT recording_map_ingests_pkey PRIMARY KEY (recording_draft_id),
  CONSTRAINT recording_map_ingests_draft_fk FOREIGN KEY (recording_draft_id) REFERENCES recording_drafts(id) ON DELETE RESTRICT
);
