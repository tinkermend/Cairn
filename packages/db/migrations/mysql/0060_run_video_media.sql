-- 0076 的 MySQL 等价增量：运行级录像媒体任务。封存后领取/租约/fencing，本机 spool 水位写在 manifest。

CREATE TABLE run_video_media_jobs (
  id varchar(36) PRIMARY KEY,
  run_id varchar(36) NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
  status varchar(16) NOT NULL CHECK (status IN ('pending','claimed','succeeded','failed')),
  fencing_token integer NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  claim_owner varchar(256),
  claim_instance varchar(36),
  claim_expires_at timestamp(3),
  spool_dir text NOT NULL,
  manifest json NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error varchar(256),
  sealed_at timestamp(3) NOT NULL,
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;

CREATE UNIQUE INDEX run_video_media_jobs_run_idx ON run_video_media_jobs(run_id);
CREATE INDEX run_video_media_jobs_due_idx ON run_video_media_jobs(status,claim_expires_at,created_at,id);
