-- 0112 的 MySQL 等价增量：目标系统受控图标与身份色，并加速目标最近会话活动查询。

ALTER TABLE targets ADD COLUMN icon_key VARCHAR(32) NOT NULL DEFAULT 'globe';
ALTER TABLE targets ADD COLUMN accent_key VARCHAR(32) NOT NULL DEFAULT 'pine';
CREATE INDEX session_events_target_created_idx ON session_events (target_id, created_at, id);
