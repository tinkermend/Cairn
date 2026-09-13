-- 0021_audit_login_shape_portable：登录审计形状约束改成三库同一种写法
--
-- 0016 的形状约束把 actor_console_account_id 写进了 CHECK，而那一列是
-- ON DELETE SET NULL 的外键列，带来两个后果：
--
-- 1. MySQL 直接不接受这种 DDL（8.4 报 ER_CHECK_CONSTRAINT_CLAUSE_USING_FK_
--    REFER_ACTION_COLUMN 3823），所以 MySQL 迁移只能落在 resource_id 上，
--    同一条业务约束在两库有两种强度；
-- 2. 更要紧的是 PG 上它会反噬删除：删掉登录成功过的控制台账号时，外键把
--    actor 置空，这条 CHECK 随即判定该行非法，DELETE 整个失败。
--
-- 因此把 PG 对齐到可移植写法：形状仍然由 resource_id 表达，actor 与
-- resource_id 的对应关系由写路径（recordLoginAudit）保证，并由三库共用的
-- 用例钉住。删除账号后 actor 置空、resource_id 保留历史指向，不再被约束挡下。
-- 全文幂等：重复执行不产生副作用。

ALTER TABLE "__SCHEMA__".console_audit_events
  DROP CONSTRAINT IF EXISTS console_audit_events_shape_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'console_audit_events_shape_check'
      AND conrelid = '"__SCHEMA__".console_audit_events'::regclass
  ) THEN
    ALTER TABLE "__SCHEMA__".console_audit_events
      ADD CONSTRAINT console_audit_events_shape_check
      CHECK (
        (
          category = 'operation'
          AND outcome IS NULL
          AND failure_reason IS NULL
          AND login_identifier IS NULL
          AND action <> 'auth.login'
        )
        OR (
          category = 'login'
          AND action = 'auth.login'
          AND resource = 'auth'
          AND login_identifier IS NOT NULL
          AND (
            (
              outcome = 'success'
              AND failure_reason IS NULL
              AND resource_id IS NOT NULL
            )
            OR (
              outcome = 'failure'
              AND failure_reason IN ('unknown_account', 'invalid_password', 'account_disabled')
              AND (
                (
                  failure_reason = 'unknown_account'
                  AND resource_id IS NULL
                )
                OR (
                  failure_reason IN ('invalid_password', 'account_disabled')
                  AND resource_id IS NOT NULL
                )
              )
            )
          )
        )
      );
  END IF;
END $$;
