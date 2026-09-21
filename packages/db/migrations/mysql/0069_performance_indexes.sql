-- 0085 的 MySQL 等价增量：性能优化索引（runs、run_events、evidences）。

CREATE INDEX runs_target_status_deleted_idx ON runs (target_id, status, deleted_at);
CREATE INDEX run_events_occurred_idx ON run_events (occurred_at);
CREATE INDEX evidences_step_run_id_idx ON evidences (step_run_id);
