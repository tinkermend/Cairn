-- 0112：目标系统受控图标与身份色，并加速目标最近会话活动查询。

ALTER TABLE "__SCHEMA__".targets ADD COLUMN icon_key text NOT NULL DEFAULT 'globe';
ALTER TABLE "__SCHEMA__".targets ADD COLUMN accent_key text NOT NULL DEFAULT 'pine';
CREATE INDEX session_events_target_created_idx ON "__SCHEMA__".session_events (target_id, created_at, id);
