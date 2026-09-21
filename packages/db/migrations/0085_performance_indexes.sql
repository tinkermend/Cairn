-- 0085：性能优化索引（runs、run_events、evidences）。

CREATE INDEX runs_target_status_deleted_idx ON "__SCHEMA__".runs (target_id, status, deleted_at);
CREATE INDEX run_events_occurred_idx ON "__SCHEMA__".run_events (occurred_at);
CREATE INDEX evidences_step_run_id_idx ON "__SCHEMA__".evidences (step_run_id);
