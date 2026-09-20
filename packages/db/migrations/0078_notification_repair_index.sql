-- Bound the candidate lookup to notification-enabled terminal runs.
CREATE INDEX runs_notification_repair_idx ON "__SCHEMA__".runs(notification_expected, status, finished_at, id);
