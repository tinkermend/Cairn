-- 0012_session_affinity：Worker 上报本进程会话上限，供观察面展示。
-- 领取谓词不读这一列；事实仍是进程 env CAIRN_BROWSER_MAX_SESSIONS。
--
-- 全文幂等：重复执行不产生副作用。

ALTER TABLE "__SCHEMA__".workers
  ADD COLUMN IF NOT EXISTS max_sessions INT NOT NULL DEFAULT 2;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_max_sessions_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers
      ADD CONSTRAINT workers_max_sessions_check
      CHECK (max_sessions >= 1);
  END IF;
END $$;
