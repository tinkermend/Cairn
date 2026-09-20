-- 0076：运行级录像媒体任务。封存后领取/租约/fencing，本机 spool 水位写在 manifest。

CREATE TABLE "__SCHEMA__".run_video_media_jobs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES "__SCHEMA__".runs(id) ON DELETE RESTRICT,
  status varchar(16) NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
  fencing_token integer NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  claim_owner varchar(256),
  claim_instance uuid,
  claim_expires_at timestamptz,
  spool_dir text NOT NULL,
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error varchar(256),
  sealed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX run_video_media_jobs_run_idx ON "__SCHEMA__".run_video_media_jobs(run_id);
CREATE INDEX run_video_media_jobs_due_idx ON "__SCHEMA__".run_video_media_jobs(status, claim_expires_at, created_at, id);
