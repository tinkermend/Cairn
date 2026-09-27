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

/**
 * 一个活跃账号的全部授予行（角色范围 × 该角色的每条权限）。
 *
 * 这条查询只按 accountId 过滤，与具体 permission 无关——权限筛选在内存里做。
 * 因此同一请求内要判多个权限时，**取一次行、在内存里派生多次**，不要按权限重复查库。
 */
export type ScopeGrantRow = { mode: string; ids: string[]; permission: string }

export async function loadAccountGrants(db: Db, accountId: string): Promise<ScopeGrantRow[]> {
  const { consoleAccountRoles: grants, consoleRolePermissions: permissions, consoleAccounts } = schemaFor(db)
  return (await db.select({ mode: grants.targetScopeMode, ids: grants.targetScopeIds, permission: permissions.permission })
    .from(grants).innerJoin(consoleAccounts, and(eq(consoleAccounts.id, grants.consoleAccountId), eq(consoleAccounts.status, 'active')))
    .innerJoin(permissions, eq(permissions.consoleRoleId, grants.consoleRoleId))
    .where(eq(grants.consoleAccountId, accountId))) as ScopeGrantRow[]
}

/** 从已取到的授予行派生某个权限的目标范围；纯内存，不查库。 */
export function scopeFromGrants(rows: ScopeGrantRow[], permission: string): TargetScope {
  const relevant = rows.filter((row) => hasPermission([row.permission], permission))
  return { all: relevant.some((row) => row.mode === 'all'), ids: [...new Set(relevant.flatMap((row) => row.mode === 'selected' ? row.ids : []))] }
}

/** 从已取到的授予行判断是否具备某权限；纯内存，不查库。 */
export function hasPermissionFromGrants(rows: ScopeGrantRow[], permission: string): boolean {
  return hasPermission(rows.map((row) => row.permission), permission)
}

export async function targetScopeFor(db: Db, accountId: string, permission: string): Promise<TargetScope> {
  return scopeFromGrants(await loadAccountGrants(db, accountId), permission)
}

/** 一次取行、派生多个权限的范围，供同一请求内需要多项判定的调用方使用。 */
export async function targetScopesFor(
  db: Db,
  accountId: string,
  permissions: readonly string[],
): Promise<Map<string, TargetScope>> {
  const rows = await loadAccountGrants(db, accountId)
  return new Map(permissions.map((permission) => [permission, scopeFromGrants(rows, permission)]))
}

export function targetScopeFilter(column: AnyColumn, scope: TargetScope) {
  return scope.all ? sql`1 = 1` : scope.ids.length ? inArray(column, scope.ids) : sql`1 = 0`
}

/** 两个目标范围的交集。任一侧不是全量时，结果只含双方都允许的目标。 */
export function intersectTargetScopes(left: TargetScope, right: TargetScope): TargetScope {
  if (left.all && right.all) return { all: true, ids: [] }
  if (left.all) return { all: false, ids: [...new Set(right.ids)] }
  if (right.all) return { all: false, ids: [...new Set(left.ids)] }
  const allow = new Set(right.ids)
  return { all: false, ids: [...new Set(left.ids.filter((id) => allow.has(id)))] }
}

/** 运行读取可见目标：target:read 与 run:read 的交集。 */
export async function runReadScope(db: Db, actorId: string): Promise<TargetScope> {
  const rows = await loadAccountGrants(db, actorId)
  return intersectTargetScopes(scopeFromGrants(rows, 'target:read'), scopeFromGrants(rows, 'run:read'))
}

export async function scopedTargetFilter(db: Db, actorId: string | undefined, column: AnyColumn, permission: string) {
  if (!actorId) return undefined
  const rows = await loadAccountGrants(db, actorId)
  return and(
    targetScopeFilter(column, scopeFromGrants(rows, 'target:read')),
    targetScopeFilter(column, scopeFromGrants(rows, permission)),
  )
}

export async function readableSessionTargets(db: Db, actorId: string): Promise<string[] | undefined> {
  const rows = await loadAccountGrants(db, actorId)
  const read = scopeFromGrants(rows, 'target:read')
  const session = scopeFromGrants(rows, 'session:read')
  if (read.all && session.all) return undefined
  if (read.all) return session.ids
  if (session.all) return read.ids
  return read.ids.filter((id) => session.ids.includes(id))
}

export async function assertTargetPermission(db: Db, accountId: string, targetId: string, permission = 'target:read') {
  const rows = await loadAccountGrants(db, accountId)
  const read = scopeFromGrants(rows, 'target:read')
  const action = permission === 'target:read' ? read : scopeFromGrants(rows, permission)
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
  targetId?: string; sessionId?: string; operationId?: string; runId?: string; scenarioId?: string; scheduleId?: string; evidenceId?: string; moduleId?: string; suiteId?: string; suiteRunId?: string; reportId?: string; artifactId?: string; incidentId?: string; targetIncidentId?: string; permissions: string[];
}) {
  const targetIds: Array<string | null | undefined> = [input.targetId]
  const { browserSessions, sessionOperations, runs, scenarios, schedules, evidences, actionModules, scenarioSuites, suiteRuns, reports, artifacts, reliabilityIncidents } = schemaFor(db)
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
  if (input.incidentId) targetIds.push((await db.select({ id: reliabilityIncidents.targetId }).from(reliabilityIncidents).where(eq(reliabilityIncidents.id, input.incidentId)).limit(1))[0]?.id)
  if (input.targetIncidentId) targetIds.push((await db.select({ id: reliabilityIncidents.targetId }).from(reliabilityIncidents).where(eq(reliabilityIncidents.id, input.targetIncidentId)).limit(1))[0]?.id)
  for (const targetId of new Set(targetIds.filter((id): id is string => !!id))) {
    await assertTargetPermission(db, actorId, targetId)
    for (const permission of input.permissions.filter((permission) => /^(target|session|credential|run|workflow|map|schedule|module|notification|suite|report|dataset|batch|reliability):/.test(permission))) {
      await assertTargetPermission(db, actorId, targetId, permission)
    }
  }
}
