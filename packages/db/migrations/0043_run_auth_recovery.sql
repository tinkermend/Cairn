-- 0043：运行中认证检查点，与调试 checkpoint 分列

ALTER TABLE "__SCHEMA__".runs
  ADD COLUMN IF NOT EXISTS auth_checkpoint JSONB;
