-- 0075：通知表列名与 Drizzle 对齐。0070 用 event_id/delivery_id/id，领域层读 notification_event_id 等。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__SCHEMA__' AND table_name = 'notification_deliveries' AND column_name = 'event_id'
  ) THEN
    ALTER TABLE "__SCHEMA__".notification_deliveries RENAME COLUMN event_id TO notification_event_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__SCHEMA__' AND table_name = 'notification_delivery_attempts' AND column_name = 'delivery_id'
  ) THEN
    ALTER TABLE "__SCHEMA__".notification_delivery_attempts RENAME COLUMN delivery_id TO notification_delivery_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__SCHEMA__' AND table_name = 'notification_commands' AND column_name = 'id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__SCHEMA__' AND table_name = 'notification_commands' AND column_name = 'command_key'
  ) THEN
    ALTER TABLE "__SCHEMA__".notification_commands RENAME COLUMN id TO command_key;
  END IF;
END $$;
