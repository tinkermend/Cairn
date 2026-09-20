-- Notification outbox; configuration upgrade remains versioned and historical snapshots are untouched.
ALTER TABLE "__SCHEMA__".runs ADD COLUMN notification_expected boolean NOT NULL DEFAULT false;
CREATE TABLE "__SCHEMA__".scenario_notification_policies (
 scenario_id uuid PRIMARY KEY, revision integer NOT NULL CHECK (revision > 0), policy jsonb NOT NULL,
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE "__SCHEMA__".notification_controls (
 "key" varchar(180) PRIMARY KEY, generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0), revoked boolean NOT NULL DEFAULT false
);
INSERT INTO "__SCHEMA__".notification_controls ("key",generation,revoked) VALUES ('dispatch',0,false);
CREATE TABLE "__SCHEMA__".notification_events (
 id uuid PRIMARY KEY, source_key varchar(200) NOT NULL, type text NOT NULL,
 run_id uuid, target_id uuid, scenario_id uuid, alert_id uuid, source_sequence integer NOT NULL DEFAULT 0,
 state varchar(24) NOT NULL CHECK (state IN ('waiting_result','ready','filtered','suppressed')), reason text,
 policy jsonb, bindings jsonb NOT NULL, payload jsonb, console_url text, occurred_at timestamptz NOT NULL,
 observed_at timestamptz, next_prepare_at timestamptz NOT NULL, actor_id uuid, purged_at timestamptz
);
CREATE UNIQUE INDEX notification_events_source_idx ON "__SCHEMA__".notification_events(source_key);
CREATE INDEX notification_events_prepare_idx ON "__SCHEMA__".notification_events(state,next_prepare_at,id);
CREATE INDEX notification_events_target_idx ON "__SCHEMA__".notification_events(target_id,occurred_at,id);
CREATE INDEX notification_events_run_idx ON "__SCHEMA__".notification_events(run_id,occurred_at);
CREATE INDEX notification_events_alert_idx ON "__SCHEMA__".notification_events(alert_id,source_sequence);
CREATE INDEX notification_events_time_idx ON "__SCHEMA__".notification_events(occurred_at,id);
CREATE TABLE "__SCHEMA__".notification_deliveries (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES "__SCHEMA__".notification_events(id) ON DELETE RESTRICT,
 channel_id uuid NOT NULL, recipient_key varchar(64) NOT NULL, recipient_label text NOT NULL, binding jsonb NOT NULL,
 status varchar(24) NOT NULL CHECK (status IN ('pending','sending','retry_wait','accepted','failed','unknown','suppressed')), reason text,
 automatic_attempt_count integer NOT NULL DEFAULT 0 CHECK (automatic_attempt_count >= 0), attempt_no integer NOT NULL DEFAULT 0,
 manual_permit boolean NOT NULL DEFAULT false, manual_actor_id uuid, next_attempt_at timestamptz,
 claim_owner text, claim_instance uuid, claim_epoch integer NOT NULL DEFAULT 0,
 claim_expires_at timestamptz, closed_at timestamptz, updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX notification_deliveries_recipient_idx ON "__SCHEMA__".notification_deliveries(event_id,channel_id,recipient_key);
CREATE INDEX notification_deliveries_due_idx ON "__SCHEMA__".notification_deliveries(status,next_attempt_at,id);
CREATE INDEX notification_deliveries_expiry_idx ON "__SCHEMA__".notification_deliveries(status,claim_expires_at);
CREATE TABLE "__SCHEMA__".notification_delivery_attempts (
 id uuid PRIMARY KEY, delivery_id uuid NOT NULL REFERENCES "__SCHEMA__".notification_deliveries(id) ON DELETE RESTRICT,
 attempt_no integer NOT NULL, claim_epoch integer NOT NULL, origin text NOT NULL CHECK (origin IN ('auto','manual')),
 actor_id uuid, started_at timestamptz NOT NULL, submitted_at timestamptz, finished_at timestamptz,
 result text CHECK (result IN ('pending','sending','retry_wait','accepted','failed','unknown','suppressed')), error_code text, response_code integer
);
CREATE UNIQUE INDEX notification_attempts_number_idx ON "__SCHEMA__".notification_delivery_attempts(delivery_id,attempt_no);
CREATE TABLE "__SCHEMA__".notification_commands (
 id varchar(180) PRIMARY KEY, actor_id uuid NOT NULL, resource_id uuid NOT NULL,
 action varchar(24) NOT NULL, digest text NOT NULL, result_id uuid NOT NULL, created_at timestamptz NOT NULL
);
CREATE INDEX notification_commands_rate_idx ON "__SCHEMA__".notification_commands(action,created_at);
