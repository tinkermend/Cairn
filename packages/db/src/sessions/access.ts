import { and, eq, isNull } from 'drizzle-orm'
import { hasPermission, isSessionIdleOnlyKind } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { assertTargetPermission } from '../console/target-authorization.js'
import { conflict } from '../runs/errors.js'
import type { SessionOperationRow } from '../records.js'
import type { SessionKey } from './sessions.js'

export async function assertSessionAccountActive(db: Db, key: SessionKey): Promise<void> {
  const { targets, targetAccounts } = schemaFor(db)
  const [row] = await db
    .select({ id: targetAccounts.id })
    .from(targetAccounts)
    .innerJoin(targets, eq(targets.id, targetAccounts.targetId))
    .where(
      and(
        eq(targetAccounts.id, key.targetAccountId),
        eq(targets.id, key.targetId),
        eq(targetAccounts.status, 'active'),
        eq(targets.status, 'active'),
        isNull(targetAccounts.deletedAt),
        isNull(targets.deletedAt),
      ),
    )
    .limit(1)
  if (!row) throw conflict('AUTH_CONFIGURATION_REVOKED', '目标系统或账号已停用、删除或不匹配')
}

export async function assertSessionActorPermission(
  db: Db,
  actorId: string,
  permission: string,
): Promise<void> {
  const { consoleAccounts, consoleAccountRoles, consoleRolePermissions } = schemaFor(db)
  const [actor] = await db.select().from(consoleAccounts).where(eq(consoleAccounts.id, actorId)).limit(1)
  const rows = await db
    .select({ permission: consoleRolePermissions.permission })
    .from(consoleAccountRoles)
    .innerJoin(
      consoleRolePermissions,
      eq(consoleRolePermissions.consoleRoleId, consoleAccountRoles.consoleRoleId),
    )
    .where(eq(consoleAccountRoles.consoleAccountId, actorId))
  if (
    !actor ||
    actor.status !== 'active' ||
    !hasPermission(
      rows.map((row) => row.permission),
      permission,
    )
  ) {
    throw conflict('AUTH_CONFIGURATION_REVOKED', '会话操作权限已撤销')
  }
}

export async function assertMaintenanceAuthorized(
  db: Db,
  operation: Pick<SessionOperationRow, 'kind' | 'origin' | 'kindParams' | 'targetId' | 'targetAccountId'>,
): Promise<void> {
  await assertSessionAccountActive(db, operation)
  if (operation.origin === 'BACKGROUND') {
    const { targetAccountAuthBudget } = schemaFor(db)
    const [budget] = await db
      .select()
      .from(targetAccountAuthBudget)
      .where(eq(targetAccountAuthBudget.targetAccountId, operation.targetAccountId))
      .limit(1)
    if (budget?.pausedReason) throw conflict('AUTH_CONFIGURATION_REVOKED', '自动登录已暂停')
    return
  }
  const actorId = operation.kindParams?.requestedBy
  if (typeof actorId !== 'string') throw conflict('AUTH_CONFIGURATION_REVOKED', '会话操作缺少可验证的发起人')
  await assertSessionActorPermission(db, actorId, 'session:control')
  await assertTargetPermission(db, actorId, operation.targetId, 'session:control')
  if (isSessionIdleOnlyKind(operation.kind)) {
    await assertSessionActorPermission(db, actorId, 'session:manage')
    await assertTargetPermission(db, actorId, operation.targetId, 'session:manage')
  }
}
