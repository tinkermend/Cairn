-- 0058：证据类型放行运行级 video。
--
-- 不建 (run_id, type) 唯一约束：截图仍按 Attempt 多行。
-- 同一 Run 一条 video 由 reserve 幂等保证。

DO $$
BEGIN
  ALTER TABLE "__SCHEMA__".evidences
    DROP CONSTRAINT IF EXISTS evidences_type_check;
  ALTER TABLE "__SCHEMA__".evidences
    ADD CONSTRAINT evidences_type_check
    CHECK (type IN ('input', 'output', 'error', 'screenshot', 'log', 'trace', 'video'));
END $$;
