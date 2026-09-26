-- 目标系统默认身份色随 B1 主色调整。此功能尚未发布，pine 为前次迁移的回填值。
ALTER TABLE "__SCHEMA__".targets ALTER COLUMN accent_key SET DEFAULT 'blue';
UPDATE "__SCHEMA__".targets SET accent_key = 'blue' WHERE accent_key = 'pine';
