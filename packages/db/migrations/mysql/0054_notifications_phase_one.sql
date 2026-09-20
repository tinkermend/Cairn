-- Notification outbox; configuration upgrade remains versioned and historical snapshots are untouched.
ALTER TABLE runs ADD COLUMN notification_expected boolean NOT NULL DEFAULT false;
CREATE TABLE scenario_notification_policies (
 scenario_id varchar(36) PRIMARY KEY, revision integer NOT NULL CHECK (revision > 0), policy json NOT NULL,
 updated_by varchar(36) NOT NULL, updated_at timestamp(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE TABLE notification_controls (
 `key` varchar(180) PRIMARY KEY, generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0), revoked boolean NOT NULL DEFAULT false
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
INSERT INTO notification_controls (`key`,generation,revoked) VALUES ('dispatch',0,false);
CREATE TABLE notification_events (
 id varchar(36) PRIMARY KEY, source_key varchar(200) NOT NULL, type text NOT NULL,
 run_id varchar(36), target_id varchar(36), scenario_id varchar(36), alert_id varchar(36), source_sequence integer NOT NULL DEFAULT 0,
 state varchar(24) NOT NULL CHECK (state IN ('waiting_result','ready','filtered','suppressed')), reason text,
 policy json, bindings json NOT NULL, payload json, console_url text, occurred_at timestamp(3) NOT NULL,
 observed_at timestamp(3), next_prepare_at timestamp(3) NOT NULL, actor_id varchar(36), purged_at timestamp(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX notification_events_source_idx ON notification_events(source_key);
CREATE INDEX notification_events_prepare_idx ON notification_events(state,next_prepare_at,id);
CREATE INDEX notification_events_target_idx ON notification_events(target_id,occurred_at,id);
CREATE INDEX notification_events_run_idx ON notification_events(run_id,occurred_at);
CREATE INDEX notification_events_alert_idx ON notification_events(alert_id,source_sequence);
CREATE INDEX notification_events_time_idx ON notification_events(occurred_at,id);
CREATE TABLE notification_deliveries (
 id varchar(36) PRIMARY KEY, event_id varchar(36) NOT NULL, FOREIGN KEY (event_id) REFERENCES notification_events(id) ON DELETE RESTRICT,
 channel_id varchar(36) NOT NULL, recipient_key varchar(64) NOT NULL, recipient_label text NOT NULL, binding json NOT NULL,
 status varchar(24) NOT NULL CHECK (status IN ('pending','sending','retry_wait','accepted','failed','unknown','suppressed')), reason text,
 automatic_attempt_count integer NOT NULL DEFAULT 0 CHECK (automatic_attempt_count >= 0), attempt_no integer NOT NULL DEFAULT 0,
 manual_permit boolean NOT NULL DEFAULT false, manual_actor_id varchar(36), next_attempt_at timestamp(3),
 claim_owner text, claim_instance varchar(36), claim_epoch integer NOT NULL DEFAULT 0,
 claim_expires_at timestamp(3), closed_at timestamp(3), updated_at timestamp(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX notification_deliveries_recipient_idx ON notification_deliveries(event_id,channel_id,recipient_key);
CREATE INDEX notification_deliveries_due_idx ON notification_deliveries(status,next_attempt_at,id);
CREATE INDEX notification_deliveries_expiry_idx ON notification_deliveries(status,claim_expires_at);
CREATE TABLE notification_delivery_attempts (
 id varchar(36) PRIMARY KEY, delivery_id varchar(36) NOT NULL, FOREIGN KEY (delivery_id) REFERENCES notification_deliveries(id) ON DELETE RESTRICT,
 attempt_no integer NOT NULL, claim_epoch integer NOT NULL, origin text NOT NULL CHECK (origin IN ('auto','manual')),
 actor_id varchar(36), started_at timestamp(3) NOT NULL, submitted_at timestamp(3), finished_at timestamp(3),
 result text CHECK (result IN ('pending','sending','retry_wait','accepted','failed','unknown','suppressed')), error_code text, response_code integer
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE UNIQUE INDEX notification_attempts_number_idx ON notification_delivery_attempts(delivery_id,attempt_no);
CREATE TABLE notification_commands (
 id varchar(180) PRIMARY KEY, actor_id varchar(36) NOT NULL, resource_id varchar(36) NOT NULL,
 action varchar(24) NOT NULL, digest text NOT NULL, result_id varchar(36) NOT NULL, created_at timestamp(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
CREATE INDEX notification_commands_rate_idx ON notification_commands(action,created_at);
