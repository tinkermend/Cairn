import { and, eq, inArray, isNull } from 'drizzle-orm'
import { accountAllowsMap, type AccountUsage } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { conflict, notFound } from '../runs/errors.js'

export function assertAccountAllowsMap(usage: string | null | undefined): void {
  if (!accountAllowsMap(usage)) {
    throw conflict('MAP_ACCOUNT_USAGE_REQUIRED', '请先在账号上标记地图用途')
  }
}

export function assertAccountAllowsBusiness(usage: string | null | undefined): void {
  if (usage === 'map') {
    throw conflict('RUN_ACCOUNT_MAP_ONLY', '该账号仅用于地图采集，不能创建场景运行')
  }
}

export async function requireMapCapableAccount(
  db: Db,
  targetId: string,
  accountId: string,
): Promise<{ id: string; usage: AccountUsage }> {
  const { targetAccounts } = schemaFor(db)
  const [account] = await db
    .select()
    .from(targetAccounts)
    .where(and(eq(targetAccounts.id, accountId), eq(targetAccounts.targetId, targetId), isNull(targetAccounts.deletedAt)))
    .limit(1)
  if (!account || account.status !== 'active') {
    throw notFound('TARGET_ACCOUNT_NOT_FOUND', '目标账号不存在或已停用')
  }
  assertAccountAllowsMap(account.usage)
  return { id: account.id, usage: account.usage as AccountUsage }
}

export async function requireTargetHasMapCapableAccount(db: Db, targetId: string): Promise<void> {
  const { targetAccounts } = schemaFor(db)
  const [account] = await db
    .select({ id: targetAccounts.id })
    .from(targetAccounts)
    .where(
      and(
        eq(targetAccounts.targetId, targetId),
        eq(targetAccounts.status, 'active'),
        isNull(targetAccounts.deletedAt),
        inArray(targetAccounts.usage, ['map', 'both']),
      ),
    )
    .limit(1)
  if (!account) {
    throw conflict('MAP_ACCOUNT_USAGE_REQUIRED', '请先在账号上标记地图用途')
  }
}
