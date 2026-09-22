-- 0098 的 MySQL 等价增量：证据类型放行 file。

ALTER TABLE evidences DROP CHECK evidences_type_check;
ALTER TABLE evidences
  ADD CONSTRAINT evidences_type_check
  CHECK (type IN ('input', 'output', 'error', 'screenshot', 'log', 'trace', 'video', 'file'));
