-- 0098：证据类型放行 file（支持文件证据入库与对象关联）。
--
-- 全文幂等：重复执行不产生副作用。

DO $$
BEGIN
  ALTER TABLE "__SCHEMA__".evidences
    DROP CONSTRAINT IF EXISTS evidences_type_check;
  ALTER TABLE "__SCHEMA__".evidences
    ADD CONSTRAINT evidences_type_check
    CHECK (type IN ('input', 'output', 'error', 'screenshot', 'log', 'trace', 'video', 'file'));
END $$;
