-- 0005_target_login_fields：用户手填的登录框定位（id / name / css）
--
-- 只存用户显式写下的定位。常见字段启发式在 @cairn/shared 代码里，不进库。
-- null 与 {} 语义相同：全部未指定。
--
-- 全文幂等：重复执行不产生副作用。

ALTER TABLE "__SCHEMA__".targets
  ADD COLUMN IF NOT EXISTS login_fields JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'targets_login_fields_object'
      AND conrelid = '"__SCHEMA__".targets'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".targets
      ADD CONSTRAINT targets_login_fields_object
      CHECK (login_fields IS NULL OR jsonb_typeof(login_fields) = 'object');
  END IF;
END $$;
