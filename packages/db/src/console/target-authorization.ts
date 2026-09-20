import { and, eq, inArray, sql, type AnyColumn } from 'drizzle-orm'
import { hasPermission } from '@cairn/shared'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { forbidden, notFound } from '../runs/errors.js'

export type TargetScope = { all: boolean; ids: string[] }

/** Authorization mutations and scoped writes lock the same account row first. */
export async function lockConsoleAuthorization(db: Db, accountId: string, requireActive = true) {
  const { consoleAccounts } = schemaFor(db)
  const [account] = await db.select({ status: consoleAccounts.status }).from(consoleAccounts)
    .where(eq(consoleAccounts.id, accountId)).for('update')
  if (!account || (requireActive && account.status !== 'active')) throw forbidden('FORBIDDEN', '账号不可用')
}

export async function targetScopeFor(db: Db, accountId: string, permission: string): Promise<TargetScope> {
  const { consoleAccountRoles: grants, consoleRolePermissions: permissions, consoleAccounts } = schemaFor(db)
  const rows = await db.select({ mode: grants.targetScopeMode, ids: grants.targetScopeIds, permission: permissions.permission })
    .from(grants).innerJoin(consoleAccounts, and(eq(consoleAccounts.id, grants.consoleAccountId), eq(consoleAccounts.status, 'active')))
    .innerJoin(permissions, eq(permissions.consoleRoleId, grants.consoleRoleId))
    .where(eq(grants.consoleAccountId, accountId))
  const relevant = rows.filter((row) => hasPermission([row.permission], permission))
  return { all: relevant.some((row) => row.mode === 'all'), ids: [...new Set(relevant.flatMap((row) => row.mode === 'selected' ? row.ids : []))] }
}

export function targetScopeFilter(column: AnyColumn, scope: TargetScope) {
  return scope.all ? sql`1 = 1` : scope.ids.length ? inArray(column, scope.ids) : sql`1 = 0`
}

export async function scopedTargetFilter(db: Db, actorId: string | undefined, column: AnyColumn, permission: string) {
  if (!actorId) return undefined
  return and(targetScopeFilter(column, await targetScopeFor(db, actorId, 'target:read')), targetScopeFilter(column, await targetScopeFor(db, actorId, permission)))
}

export async function readableSessionTargets(db: Db, actorId: string): Promise<string[] | undefined> {
  const read = await targetScopeFor(db, actorId, 'target:read')
  const session = await targetScopeFor(db, actorId, 'session:read')
  if (read.all && session.all) return undefined
  if (read.all) return session.ids
  if (session.all) return read.ids
  return read.ids.filter((id) => session.ids.includes(id))
}

export async function assertTargetPermission(db: Db, accountId: string, targetId: string, permission = 'target:read') {
  const read = await targetScopeFor(db, accountId, 'target:read')
  const action = permission === 'target:read' ? read : await targetScopeFor(db, accountId, permission)
  if (!(read.all || read.ids.includes(targetId)) || !(action.all || action.ids.includes(targetId))) {
    throw notFound('TARGET_NOT_FOUND', '目标不存在或无权访问')
  }
}

/** Explicitly unrestricted IAM administrators own scope delegation. */
export async function assertScopeAdministrator(db: Db, accountId: string) {
  const { consoleAccountRoles: grants, consoleRoles: roles, consoleAccounts } = schemaFor(db)
  const [grant] = await db.select({ id: roles.id }).from(grants)
    .innerJoin(roles, eq(roles.id, grants.consoleRoleId))
    .innerJoin(consoleAccounts, and(eq(consoleAccounts.id, grants.consoleAccountId), eq(consoleAccounts.status, 'active')))
    .where(and(eq(grants.consoleAccountId, accountId), eq(grants.targetScopeMode, 'all'), eq(roles.key, 'admin'), eq(roles.kind, 'system'))).limit(1)
  if (!grant) throw forbidden('FORBIDDEN', '目标范围和角色能力的授权变更需要全范围管理员')
}

export async function authorizeTargetRequest(db: Db, actorId: string, input: {
  targetId?: string; sessionId?: string; operationId?: string; runId?: string; scenarioId?: string; scheduleId?: string; evidenceId?: string; moduleId?: string; suiteId?: string; suiteRunId?: string; reportId?: string; artifactId?: string; permissions: string[];
}) {
  const targetIds: Array<string | null | undefined> = [input.targetId]
  const { browserSessions, sessionOperations, runs, scenarios, schedules, evidences, actionModules, scenarioSuites, suiteRuns, reports, artifacts } = schemaFor(db)
  if (input.sessionId) targetIds.push((await db.select({ id: browserSessions.targetId }).from(browserSessions).where(eq(browserSessions.id, input.sessionId)).limit(1))[0]?.id)
  if (input.operationId) targetIds.push((await db.select({ id: sessionOperations.targetId }).from(sessionOperations).where(eq(sessionOperations.id, input.operationId)).limit(1))[0]?.id)
  if (input.runId) targetIds.push((await db.select({ id: runs.targetId }).from(runs).where(eq(runs.id, input.runId)).limit(1))[0]?.id)
  if (input.scenarioId) targetIds.push((await db.select({ id: scenarios.targetId }).from(scenarios).where(eq(scenarios.id, input.scenarioId)).limit(1))[0]?.id)
  if (input.scheduleId) targetIds.push((await db.select({ id: schedules.targetId }).from(schedules).where(eq(schedules.id, input.scheduleId)).limit(1))[0]?.id)
  if (input.evidenceId) {
    targetIds.push((await db.select({ id: runs.targetId }).from(evidences).innerJoin(runs, eq(runs.id, evidences.runId)).where(eq(evidences.id, input.evidenceId)).limit(1))[0]?.id)
  }
  if (input.moduleId) targetIds.push((await db.select({ id: actionModules.targetId }).from(actionModules).where(eq(actionModules.id, input.moduleId)).limit(1))[0]?.id)
  if (input.suiteId) targetIds.push((await db.select({ id: scenarioSuites.targetId }).from(scenarioSuites).where(eq(scenarioSuites.id, input.suiteId)).limit(1))[0]?.id)
  if (input.suiteRunId) targetIds.push((await db.select({ id: suiteRuns.targetId }).from(suiteRuns).where(eq(suiteRuns.id, input.suiteRunId)).limit(1))[0]?.id)
  if (input.reportId) targetIds.push((await db.select({ id: reports.targetId }).from(reports).where(eq(reports.id, input.reportId)).limit(1))[0]?.id)
  if (input.artifactId) targetIds.push((await db.select({ id: artifacts.targetId }).from(artifacts).where(eq(artifacts.id, input.artifactId)).limit(1))[0]?.id)
  for (const targetId of new Set(targetIds.filter((id): id is string => !!id))) {
    await assertTargetPermission(db, actorId, targetId)
    for (const permission of input.permissions.filter((permission) => /^(target|session|credential|run|workflow|map|schedule|module|notification|suite|report):/.test(permission))) {
      await assertTargetPermission(db, actorId, targetId, permission)
    }
  }
}
