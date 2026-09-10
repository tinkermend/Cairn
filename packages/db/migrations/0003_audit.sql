-- 0003_audit：控制台 IAM 审计事件
--
-- 只记身份与权限变更。菜单不入库；业务资源的审计以后各自加。
-- 全文幂等：重复执行不产生副作用。

CREATE TABLE IF NOT EXISTS "__SCHEMA__".console_audit_events (
  id                          UUID        PRIMARY KEY,
  actor_console_account_id    UUID
    REFERENCES "__SCHEMA__".console_accounts (id) ON DELETE SET NULL,
  action                      TEXT        NOT NULL,
  resource                    TEXT        NOT NULL,
  resource_id                 UUID,
  summary                     TEXT        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS console_audit_events_created_idx
  ON "__SCHEMA__".console_audit_events (created_at DESC);

CREATE INDEX IF NOT EXISTS console_audit_events_actor_idx
  ON "__SCHEMA__".console_audit_events (actor_console_account_id);
