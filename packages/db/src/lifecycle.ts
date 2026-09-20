import { and, eq, gte, inArray, isNull, lt, notInArray, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import {
  deleteResourceResultSchema,
  resourceDeletedBySchema,
  type CleanupStatusResponse,
  type DeletePreviewCounts,
  type DeletePreviewBlocker,
  type DeleteResourceResult,
  type ResourceDeletedBy,
} from '@cairn/shared'
import type { Db } from './client.js'
import { schemaFor, updateRows } from './native.js'
import { conflict } from './runs/errors.js'

export const RESOURCE_DELETED_CLOSE_REASON = 'resource_deleted'

export type DeleteActor = {
  id: string
  displayName?: string
  kind?: 'console' | 'service'
}

export async function snapshotDeletedBy(db: Db, actor: DeleteActor): Promise<ResourceDeletedBy> {
  const kind = actor.kind === 'service' ? 'service' : 'console'
  const named = actor.displayName?.trim()
  if (named) {
    return resourceDeletedBySchema.parse({ id: actor.id, displayName: named, kind })
  }
  if (kind === 'service') {
    return resourceDeletedBySchema.parse({ id: actor.id, displayName: actor.id, kind })
  }
  const { consoleAccounts } = schemaFor(db)
  const [row] = await db
    .select({ displayName: consoleAccounts.displayName })
    .from(consoleAccounts)
    .where(eq(consoleAccounts.id, actor.id))
    .limit(1)
  return resourceDeletedBySchema.parse({
    id: actor.id,
    displayName: row?.displayName?.trim() || actor.id,
    kind,
  })
}

export function createdAtBounds(column: SQLWrapper, from?: string, to?: string): SQL[] {
  const parts: SQL[] = []
  if (from) parts.push(gte(column, new Date(from)))
  if (to) parts.push(lt(column, new Date(to)))
  return parts
}

export function assertExpectedCounts(
  actual: DeletePreviewCounts,
  expected?: DeletePreviewCounts,
): void {
  if (!expected) return
  if (
    (expected.targetAccounts !== undefined &&
      (actual.targetAccounts ?? 0) > expected.targetAccounts) ||
    (expected.scenarios !== undefined && (actual.scenarios ?? 0) > expected.scenarios) ||
    (expected.recordings !== undefined && (actual.recordings ?? 0) > expected.recordings) ||
    (expected.runs !== undefined && (actual.runs ?? 0) > expected.runs)
  ) {
    throw conflict('DELETE_SCOPE_EXPANDED', '级联删除影响范围已发生变化，请刷新预览后重新确认')
  }
}

export function resourceDeletedConflict(): never {
  throw conflict('RESOURCE_DELETED', '原请求资源已删除')
}

export function toDeleteResult(input: {
  id: string
  deletedAt: Date | string
  deletedBy: ResourceDeletedBy
  cleanup?: CleanupStatusResponse
}): DeleteResourceResult {
  return deleteResourceResultSchema.parse({
    id: input.id,
    deletedAt: typeof input.deletedAt === 'string' ? input.deletedAt : input.deletedAt.toISOString(),
    deletedBy: input.deletedBy,
    accepted: true,
    cleanup: input.cleanup,
  })
}

export function activeRunBlockers(
  rows: { id: string; status: string }[],
): DeletePreviewBlocker[] {
  return rows.map((row) => ({
    id: row.id,
    code: 'RUN_NOT_TERMINAL',
    message: `运行仍在进行（${row.status}）`,
  }))
}

export async function pendingWriteBlockers(
  tx: Db,
  runIds: string[],
): Promise<DeletePreviewBlocker[]> {
  if (runIds.length === 0) return []
  const { evidences, storedObjects } = schemaFor(tx)
  const [pendingObject] = await tx
    .select({ id: storedObjects.id })
    .from(storedObjects)
    .where(
      and(
        inArray(storedObjects.runId, runIds),
        eq(storedObjects.status, 'pending'),
        isNull(storedObjects.deleteRequestedAt),
      ),
    )
    .limit(1)
  const [pendingEvidence] = await tx
    .select({ id: evidences.id })
    .from(evidences)
    .where(and(inArray(evidences.runId, runIds), eq(evidences.status, 'pending')))
    .limit(1)
  if (!pendingObject && !pendingEvidence) return []
  return [
    {
      id: 'pending_writes',
      code: 'RESOURCE_BUSY',
      message: '仍有证据正在写入，无法删除',
    },
  ]
}

export async function assertResourceIdle(
  tx: Db,
  input: {
    runIds?: string[]
    targetId?: string
    targetAccountId?: string
    scenarioId?: string
    checkPendingWrites?: boolean
  },
): Promise<void> {
  const { browserSessions, runLeases, runs, sessionLeases } = schemaFor(tx)
  const now = new Date()
  let runIds = input.runIds ?? []
  if (input.scenarioId) {
    const rows = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.scenarioId, input.scenarioId), isNull(runs.deletedAt)))
    runIds = [...new Set([...runIds, ...rows.map((row) => row.id)])]
  }
  if (runIds.length > 0) {
    const [lease] = await tx
      .select({ id: runLeases.id })
      .from(runLeases)
      .where(and(inArray(runLeases.runId, runIds), eq(runLeases.status, 'ACTIVE')))
      .limit(1)
    if (lease) {
      throw conflict('RESOURCE_BUSY', '仍有活跃任务租约，无法删除')
    }
    if (input.checkPendingWrites) {
      const pending = await pendingWriteBlockers(tx, runIds)
      if (pending.length > 0) {
        throw conflict('RESOURCE_BUSY', pending[0]!.message)
      }
    }
  }

  const sessionFilters = [
    input.targetId ? eq(browserSessions.targetId, input.targetId) : undefined,
    input.targetAccountId ? eq(browserSessions.targetAccountId, input.targetAccountId) : undefined,
  ].filter((item): item is SQL => item !== undefined)
  if (sessionFilters.length === 0) return

  const sessions = await tx
    .select({
      id: browserSessions.id,
      authControlExpiresAt: browserSessions.authControlExpiresAt,
    })
    .from(browserSessions)
    .where(and(...sessionFilters))
  if (sessions.length === 0) return

  const sessionIds = sessions.map((row) => row.id)
  const [held] = await tx
    .select({ id: sessionLeases.id })
    .from(sessionLeases)
    .where(and(inArray(sessionLeases.sessionId, sessionIds), eq(sessionLeases.status, 'ACTIVE')))
    .limit(1)
  if (held) {
    throw conflict('RESOURCE_BUSY', '仍有活跃会话租约，无法删除')
  }
  if (
    sessions.some((row) => row.authControlExpiresAt && row.authControlExpiresAt > now)
  ) {
    throw conflict('RESOURCE_BUSY', '仍有认证占用，无法删除')
  }
}

export async function exclusiveSecretIds(
  tx: Db,
  secretIds: string[],
  excludeAccountIds: string[],
): Promise<string[]> {
  if (secretIds.length === 0) return []
  const { platformAiSecretBindings, targetAccounts, credentialVersions } = schemaFor(tx)
  const others = await tx
    .select({ secretId: targetAccounts.secretId })
    .from(targetAccounts)
    .where(
      and(
        inArray(targetAccounts.secretId, secretIds),
        isNull(targetAccounts.deletedAt),
        excludeAccountIds.length > 0
          ? notInArray(targetAccounts.id, excludeAccountIds)
          : undefined,
      ),
    )
  const bindings = await tx
    .select({ secretId: platformAiSecretBindings.secretId })
    .from(platformAiSecretBindings)
    .where(inArray(platformAiSecretBindings.secretId, secretIds))
  const versions = await tx
    .select({ secretId: credentialVersions.secretId, status: credentialVersions.materialStatus })
    .from(credentialVersions)
    .where(inArray(credentialVersions.secretId, secretIds))
  const used = new Set(
    [
      ...others,
      ...bindings,
      ...versions.filter((row) => row.status !== 'cleared' && row.status !== 'revoked' && row.status !== 'unavailable'),
    ]
      .map((row) => row.secretId)
      .filter((id): id is string => id !== null),
  )
  return secretIds.filter((id) => !used.has(id))
}

export async function revokeTargetGrants(tx: Db, targetId: string): Promise<void> {
  const { credentialTargetAccountGrants, credentialTargetGrants } = schemaFor(tx)
  await tx
    .delete(credentialTargetAccountGrants)
    .where(eq(credentialTargetAccountGrants.targetId, targetId))
  await tx.delete(credentialTargetGrants).where(eq(credentialTargetGrants.targetId, targetId))
}

export async function revokeAccountGrants(tx: Db, accountId: string): Promise<void> {
  const { credentialTargetAccountGrants } = schemaFor(tx)
  await tx
    .delete(credentialTargetAccountGrants)
    .where(eq(credentialTargetAccountGrants.targetAccountId, accountId))
}

export async function closeOpenBindings(
  tx: Db,
  input: { targetId?: string; scenarioId?: string; recordingDraftId?: string },
  now: Date,
): Promise<void> {
  const { recordingBindings } = schemaFor(tx)
  const filters = [
    input.targetId ? eq(recordingBindings.targetId, input.targetId) : undefined,
    input.scenarioId ? eq(recordingBindings.scenarioId, input.scenarioId) : undefined,
    input.recordingDraftId
      ? eq(recordingBindings.recordingDraftId, input.recordingDraftId)
      : undefined,
    inArray(recordingBindings.status, ['issued', 'claimed']),
  ].filter((item): item is SQL => item !== undefined)
  await tx
    .update(recordingBindings)
    .set({ status: 'closed', closedAt: now, updatedAt: now })
    .where(and(...filters))
}

export async function revokeExternalEvidence(tx: Db, runIds: string[]): Promise<void> {
  if (runIds.length === 0) return
  const { evidences, reports, suiteRunItems } = schemaFor(tx)
  await tx.update(evidences).set({ externalAccess: 0 }).where(inArray(evidences.runId, runIds))
  const parents = await tx.select({ id: suiteRunItems.suiteRunId }).from(suiteRunItems).where(inArray(suiteRunItems.childRunId, runIds))
  const related = await tx.select({ id: reports.id }).from(reports).where(or(inArray(reports.runId, runIds), parents.length ? inArray(reports.suiteRunId, parents.map((row) => row.id)) : undefined))
  const { revokeReportTrees } = await import('./reports/cleanup.js')
  await revokeReportTrees(tx, related.map((row) => row.id), false)
}

export async function requestSessionClose(
  tx: Db,
  input: { targetId?: string; targetAccountId?: string },
  now: Date,
  reason = RESOURCE_DELETED_CLOSE_REASON,
): Promise<number> {
  const { browserSessions } = schemaFor(tx)
  const filters = [
    input.targetId ? eq(browserSessions.targetId, input.targetId) : undefined,
    input.targetAccountId ? eq(browserSessions.targetAccountId, input.targetAccountId) : undefined,
    inArray(browserSessions.status, ['CREATING', 'OPEN']),
  ].filter((item): item is SQL => item !== undefined)
  if (!input.targetId && !input.targetAccountId) return 0
  const rows = await updateRows(
    tx,
    browserSessions,
    {
      status: 'CLOSING',
      closeReason: reason,
      version: sql`${browserSessions.version} + 1`,
      updatedAt: now,
    },
    and(...filters),
    { id: browserSessions.id },
  )
  return rows.length
}

export async function deletedOccupancyMessage(
  db: Db,
  kind: 'target_code' | 'account_username' | 'scenario_name',
  input: { code?: string; targetId?: string; username?: string; name?: string },
): Promise<string | null> {
  const { scenarios, targetAccounts, targets } = schemaFor(db)
  if (kind === 'target_code' && input.code) {
    const [row] = await db
      .select({ deletedAt: targets.deletedAt })
      .from(targets)
      .where(eq(targets.code, input.code))
      .limit(1)
    return row?.deletedAt ? '目标系统编码已被已删除记录占用，无法复用' : null
  }
  if (kind === 'account_username' && input.targetId && input.username) {
    const [row] = await db
      .select({ deletedAt: targetAccounts.deletedAt })
      .from(targetAccounts)
      .where(
        and(eq(targetAccounts.targetId, input.targetId), eq(targetAccounts.username, input.username)),
      )
      .limit(1)
    return row?.deletedAt ? '该目标系统下登录名已被已删除记录占用，无法复用' : null
  }
  if (kind === 'scenario_name' && input.targetId && input.name) {
    const [row] = await db
      .select({ deletedAt: scenarios.deletedAt })
      .from(scenarios)
      .where(and(eq(scenarios.targetId, input.targetId), eq(scenarios.name, input.name)))
      .limit(1)
    return row?.deletedAt ? '该目标系统下场景名已被已删除记录占用，无法复用' : null
  }
  return null
}

export async function requireLiveRun(tx: Db, runId: string): Promise<void> {
  const { runs } = schemaFor(tx)
  const [row] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .limit(1)
  if (!row) {
    throw conflict('RESOURCE_DELETED', '运行已删除，不能继续写入')
  }
}
