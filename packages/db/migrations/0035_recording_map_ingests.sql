-- 0035：录制草稿转地图观察的游标。按 item 下标推进，不是 Run 领取队列。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".recording_map_ingests (
  recording_draft_id UUID PRIMARY KEY REFERENCES "__SCHEMA__".recording_drafts(id) ON DELETE RESTRICT,
  next_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recording_map_ingests_next_index_check CHECK (next_index >= 0),
  CONSTRAINT recording_map_ingests_status_check CHECK (status IN ('pending', 'completed', 'aborted'))
);
