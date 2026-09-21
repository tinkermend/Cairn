-- 0088: Worker 节点治理：支持 DISABLED 维护状态、网络 IP/端口与主机名感知。

ALTER TABLE "__SCHEMA__".workers
  ADD COLUMN IF NOT EXISTS listen_host TEXT,
  ADD COLUMN IF NOT EXISTS listen_port INT,
  ADD COLUMN IF NOT EXISTS hostname TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_status_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers DROP CONSTRAINT workers_status_check;
  END IF;

  ALTER TABLE "__SCHEMA__".workers
    ADD CONSTRAINT workers_status_check
    CHECK (status IN ('READY', 'DRAINING', 'STOPPED', 'LOST', 'DISABLED'));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_listen_port_check'
      AND conrelid = '"__SCHEMA__".workers'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".workers
      ADD CONSTRAINT workers_listen_port_check
      CHECK (listen_port IS NULL OR (listen_port >= 1 AND listen_port <= 65535));
  END IF;
END $$;
