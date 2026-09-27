-- 0136：将「通知」模块物理命名重命名为「消息推送（outbound）」。
ALTER TABLE "__SCHEMA__".notification_events RENAME TO outbound_events;
ALTER TABLE "__SCHEMA__".notification_deliveries RENAME TO outbound_deliveries;
ALTER TABLE "__SCHEMA__".notification_delivery_attempts RENAME TO outbound_delivery_attempts;
ALTER TABLE "__SCHEMA__".notification_commands RENAME TO outbound_commands;
ALTER TABLE "__SCHEMA__".notification_controls RENAME TO outbound_controls;
ALTER TABLE "__SCHEMA__".scenario_notification_policies RENAME TO scenario_outbound_policies;

ALTER TABLE "__SCHEMA__".outbound_deliveries RENAME COLUMN notification_event_id TO outbound_event_id;
ALTER TABLE "__SCHEMA__".outbound_delivery_attempts RENAME COLUMN notification_delivery_id TO outbound_delivery_id;
ALTER TABLE "__SCHEMA__".runs RENAME COLUMN notification_expected TO outbound_expected;

ALTER INDEX "__SCHEMA__".notification_events_source_idx RENAME TO outbound_events_source_idx;
ALTER INDEX "__SCHEMA__".notification_events_prepare_idx RENAME TO outbound_events_prepare_idx;
ALTER INDEX "__SCHEMA__".notification_events_target_idx RENAME TO outbound_events_target_idx;
ALTER INDEX "__SCHEMA__".notification_events_run_idx RENAME TO outbound_events_run_idx;
ALTER INDEX "__SCHEMA__".notification_events_alert_idx RENAME TO outbound_events_alert_idx;
ALTER INDEX "__SCHEMA__".notification_events_time_idx RENAME TO outbound_events_time_idx;
ALTER INDEX "__SCHEMA__".notification_deliveries_recipient_idx RENAME TO outbound_deliveries_recipient_idx;
ALTER INDEX "__SCHEMA__".notification_deliveries_due_idx RENAME TO outbound_deliveries_due_idx;
ALTER INDEX "__SCHEMA__".notification_deliveries_expiry_idx RENAME TO outbound_deliveries_expiry_idx;
ALTER INDEX "__SCHEMA__".notification_attempts_number_idx RENAME TO outbound_attempts_number_idx;
ALTER INDEX "__SCHEMA__".notification_commands_rate_idx RENAME TO outbound_commands_rate_idx;
ALTER INDEX "__SCHEMA__".runs_notification_repair_idx RENAME TO runs_outbound_repair_idx;

UPDATE "__SCHEMA__".console_role_permissions SET permission = 'outbound:read' WHERE permission = 'notification:read';
UPDATE "__SCHEMA__".console_role_permissions SET permission = 'outbound:operate' WHERE permission = 'notification:operate';

DELETE FROM "__SCHEMA__".console_audit_events WHERE action IN ('notification.policy', 'notification.test', 'notification.retry', 'notification.close');
