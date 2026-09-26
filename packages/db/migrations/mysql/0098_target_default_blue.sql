-- 目标系统默认身份色随 B1 主色调整。此功能尚未发布，pine 为前次迁移的回填值。
ALTER TABLE targets MODIFY COLUMN accent_key VARCHAR(32) NOT NULL DEFAULT 'blue';
UPDATE targets SET accent_key = 'blue' WHERE accent_key = 'pine';
