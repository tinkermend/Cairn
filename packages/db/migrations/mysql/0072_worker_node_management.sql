-- 0072: PostgreSQL 0088 的 MySQL 等价增量：Worker 节点治理（DISABLED 状态、网络 IP/端口与主机名）。

ALTER TABLE workers
  ADD COLUMN listen_host TEXT,
  ADD COLUMN listen_port INT,
  ADD COLUMN hostname TEXT;

ALTER TABLE workers DROP CHECK workers_status_check;

ALTER TABLE workers
  ADD CONSTRAINT workers_status_check CHECK (
    status IN ('READY', 'DRAINING', 'STOPPED', 'LOST', 'DISABLED')
  );

ALTER TABLE workers
  ADD CONSTRAINT workers_listen_port_check CHECK (
    listen_port IS NULL OR (listen_port >= 1 AND listen_port <= 65535)
  );
