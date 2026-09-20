-- Match the notification domain's explicit foreign-key names and opaque command key.
ALTER TABLE notification_deliveries RENAME COLUMN event_id TO notification_event_id;
ALTER TABLE notification_delivery_attempts RENAME COLUMN delivery_id TO notification_delivery_id;
ALTER TABLE notification_commands RENAME COLUMN id TO command_key;
