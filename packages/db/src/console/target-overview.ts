import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  DEFAULT_TARGET_ACCENT_KEY,
  DEFAULT_TARGET_ICON_KEY,
  targetAccentKeySchema,
  targetIconKeySchema,
  targetOverviewQuerySchema,
  targetOverviewResponseSchema,
  type TargetOverviewAccountPreview,
  type TargetOverviewActivity,
  type TargetOverviewItem,
  type TargetOverviewQuery,
  type TargetOverviewResponse,
  type TargetOverviewScopedCount,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, databaseNow, driverOf, schemaFor } from '../native.js'
import { loadAccountGrants, scopeFromGrants, targetScopeFilter } from './target-authorization.js'

type TargetRow = ReturnType<typeof schemaFor>['targets']['$inferSelect']
type AccountRow = ReturnType<typeof schemaFor>['targetAccounts']['$inferSelect']
type SessionRow = ReturnType<typeof schemaFor>['browserSessions']['$inferSelect']
type LeaseRow = ReturnType<typeof schemaFor>['sessionLeases']['$inferSelect']
type OperationRow = ReturnType<typeof schemaFor>['sessionOperations']['$inferSelect']

type AccountFacts = {
  account: AccountRow
  sessions: SessionRow[]
  leases: LeaseRow[]
  operations: OperationRow[]
}

type AccountSignal = {
  preview: TargetOverviewAccountPreview
  ready: boolean
  needLogin: boolean
  attention: boolean
  needsCheck: boolean
  identityMismatch: boolean
  lost: boolean
  unprepared: boolean
  maintenance: boolean
  occupied: boolean
}

const userPurpose = (purpose: ReturnType<typeof schemaFor>['scenarios']['purpose']) =>
  or(eq(purpose, 'user'), isNull(purpose))

function grouped<T extends { targetId: string }>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const group = map.get(row.targetId) ?? []
    group.push(row)
    map.set(row.targetId, group)
  }
  return map
}

function scopedCount(value: number, coveredTargets: number, totalTargets: number, hasGlobalGrant: boolean): TargetOverviewScopedCount {
  return {
    value: coveredTargets || totalTargets === 0 && hasGlobalGrant ? value : null,
    coveredTargets,
    coverage: coveredTargets === totalTargets && (coveredTargets > 0 || hasGlobalGrant) ? 'complete'
      : coveredTargets === 0 ? 'forbidden' : 'partial',
  }
}

function text(value: string, max = 256) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function authProfileRevisionMismatch(session: SessionRow, target: TargetRow) {
  return target.currentAuthProfileRevision !== null &&
    session.authProfileRevision !== target.currentAuthProfileRevision
}

function validAuthenticatedSession(session: SessionRow, account: AccountRow, target: TargetRow, now: Date) {
  if (session.status !== 'OPEN' || session.health !== 'HEALTHY' || session.authState !== 'AUTHENTICATED') return false
  if (session.expiresAt <= now || session.authValidUntil && session.authValidUntil <= now) return false
  if (session.identityState === 'MISMATCH') return false
  if (session.lastAuthGeneration !== null && session.lastAuthGeneration !== session.generation) return false
  if (authProfileRevisionMismatch(session, target)) return false
  if (account.expectedIdentity && session.lastExpectedIdentity && account.expectedIdentity !== session.lastExpectedIdentity) return false
  return true
}

function classifyAccount(facts: AccountFacts, target: TargetRow, now: Date): AccountSignal {
  const { account, sessions, leases, operations } = facts
  const activeLeases = leases.filter((lease) => lease.status === 'ACTIVE' && lease.expiresAt > now)
  const leasedSessionIds = new Set(activeLeases.map((lease) => lease.sessionId))
  const ready = sessions.some((session) => validAuthenticatedSession(session, account, target, now) && !leasedSessionIds.has(session.id))
  const authWait = operations.some((operation) => operation.status === 'WAITING_FOR_AUTH') ||
    activeLeases.some((lease) => lease.purpose === 'AUTH_WAIT')
  const expired = sessions.some((session) => session.authState === 'EXPIRED' || session.authValidUntil && session.authValidUntil <= now)
  const needLogin = Boolean(authWait || expired)
  const identityMismatch = sessions.some((session) => session.identityState === 'MISMATCH')
  const lost = sessions.some((session) => session.status === 'LOST')
  const needsCheck = sessions.some((session) =>
    session.status === 'OPEN' &&
    (session.authState === 'UNKNOWN' || session.health !== 'HEALTHY' ||
      session.lastAuthGeneration !== null && session.lastAuthGeneration !== session.generation ||
      authProfileRevisionMismatch(session, target)),
  )
  const occupied = activeLeases.some((lease) => lease.purpose === 'EXECUTION')
  const maintenance = operations.some((operation) => ['QUEUED', 'RUNNING', 'WAITING_FOR_AUTH'].includes(operation.status)) ||
    activeLeases.some((lease) => lease.purpose !== 'EXECUTION') ||
    sessions.some((session) => session.status === 'CREATING' || session.status === 'CLOSING')
  const unprepared = sessions.length === 0 && operations.length === 0
  const attention = needLogin || identityMismatch || lost || needsCheck
  const loginMode = target.authMethod === 'manual' || target.captchaMode !== 'none' || !account.secretId
    ? 'manual' as const
    : account.secretProvider ? 'automatic' as const : 'unknown' as const
  const requiresHumanAuth = authWait || needLogin && loginMode !== 'automatic'
  const status: TargetOverviewAccountPreview['status'] =
    needLogin ? 'needs_login' : identityMismatch ? 'identity_mismatch' : lost ? 'lost' :
      needsCheck ? 'needs_check' : ready ? 'ready' : occupied ? 'executing' :
        maintenance ? 'maintenance' : 'unprepared'
  const reason = status === 'needs_login'
    ? requiresHumanAuth ? '等待人工登录' : '登录已失效，可尝试自动续登'
    : status === 'identity_mismatch' ? '登录身份与预期不符'
      : status === 'lost' ? '浏览器会话已失联'
        : status === 'needs_check' ? '登录状态需要核验'
          : status === 'ready' ? '有空闲已登录会话'
            : status === 'executing' ? '账号正在执行任务'
              : status === 'maintenance' ? '账号正在准备或维护'
                : '尚未准备浏览器会话'
  return {
    preview: { targetAccountId: account.id, displayName: account.displayName, status, loginMode, requiresHumanAuth, reason },
    ready, needLogin, attention, needsCheck, identityMismatch, lost, unprepared, maintenance, occupied,
  }
}

const previewPriority: Record<TargetOverviewAccountPreview['status'], number> = {
  needs_login: 0,
  identity_mismatch: 1,
  lost: 2,
  needs_check: 3,
  executing: 4,
  maintenance: 5,
  unprepared: 6,
  ready: 7,
}

function accountSummary(target: TargetRow, accountRows: AccountRow[], factsByAccount: Map<string, AccountFacts>, now: Date) {
  const eligible = accountRows.filter((account) => account.status === 'active' && account.usage !== 'map')
  const signals = eligible.map((account) => classifyAccount(factsByAccount.get(account.id) ?? {
    account, sessions: [], leases: [], operations: [],
  }, target, now))
  const sorted = [...signals].sort((a, b) => {
    const rank = previewPriority[a.preview.status] - previewPriority[b.preview.status]
    return rank || Number(b.preview.requiresHumanAuth) - Number(a.preview.requiresHumanAuth) ||
      a.preview.displayName.localeCompare(b.preview.displayName) || a.preview.targetAccountId.localeCompare(b.preview.targetAccountId)
  })
  const preview = sorted.slice(0, 3).map((signal) => signal.preview)
  return {
    configuredTotal: accountRows.length,
    eligibleBusinessTotal: eligible.length,
    readyAccounts: signals.filter((signal) => signal.ready).length,
    needLoginAccounts: signals.filter((signal) => signal.needLogin).length,
    attentionAccounts: signals.filter((signal) => signal.attention).length,
    needsCheckAccounts: signals.filter((signal) => signal.needsCheck).length,
    identityMismatchAccounts: signals.filter((signal) => signal.identityMismatch).length,
    lostAccounts: signals.filter((signal) => signal.lost).length,
    unpreparedAccounts: signals.filter((signal) => signal.unprepared).length,
    maintenanceAccounts: signals.filter((signal) => signal.maintenance).length,
    occupiedAccounts: signals.filter((signal) => signal.occupied).length,
    preview,
    hiddenAttentionCount: Math.max(0, signals.filter((signal) => signal.attention).length - sorted.slice(0, 3).filter((signal) => signal.attention).length),
  }
}

type ActivityCandidate = TargetOverviewActivity & { targetId: string; stableId: string }

async function loadRunActivities(db: Db, targetIds: string[]): Promise<ActivityCandidate[]> {
  if (!targetIds.length) return []
  const { runEvents, runs, scenarios } = schemaFor(db)
  const status = driverOf(db) === 'postgres'
    ? sql<string>`${runEvents.payload}->>'status'`
    : driverOf(db) === 'mysql'
      ? sql<string>`json_unquote(json_extract(${runEvents.payload}, '$.status'))`
      : sql<string>`json_extract(${runEvents.payload}, '$.status')`
  const rankedByRun = db.select({
    targetId: runs.targetId,
    runId: runs.id,
    scenarioName: scenarios.name,
    eventId: runEvents.eventId,
    type: runEvents.type,
    payload: runEvents.payload,
    occurredAt: runEvents.occurredAt,
    runRank: sql<number>`row_number() over(partition by ${runs.id} order by ${runEvents.occurredAt} desc, ${runEvents.eventId} desc)`.as('run_rank'),
  }).from(runEvents)
    .innerJoin(runs, eq(runs.id, runEvents.runId))
    .innerJoin(scenarios, and(eq(scenarios.id, runs.scenarioId), eq(scenarios.targetId, runs.targetId)))
    .where(and(inArray(runs.targetId, targetIds), isNull(runs.deletedAt), userPurpose(scenarios.purpose),
      or(eq(runEvents.type, 'run.created'), eq(runEvents.type, 'run.auth_wait'),
        and(eq(runEvents.type, 'run.status_changed'), inArray(status, ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'])))))
    .as('ranked_by_run')
  const rankedByTarget = db.select({
    targetId: rankedByRun.targetId,
    runId: rankedByRun.runId,
    scenarioName: rankedByRun.scenarioName,
    eventId: rankedByRun.eventId,
    type: rankedByRun.type,
    payload: rankedByRun.payload,
    occurredAt: rankedByRun.occurredAt,
    targetRank: sql<number>`row_number() over(partition by ${rankedByRun.targetId} order by ${rankedByRun.occurredAt} desc, ${rankedByRun.eventId} desc)`.as('target_rank'),
  }).from(rankedByRun).where(eq(rankedByRun.runRank, 1)).as('ranked_by_target')
  const eventRows = await db.select().from(rankedByTarget).where(lte(rankedByTarget.targetRank, 6))
  const candidates: ActivityCandidate[] = []
  for (const row of eventRows) {
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : {}
    const kind = row.type === 'run.created' ? 'run_queued' : row.type === 'run.auth_wait' ? 'auth_wait'
      : payload.status === 'RUNNING' ? 'run_started'
        : ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(String(payload.status)) ? 'run_finished' : null
    if (!kind) continue
    const title = kind === 'run_queued' ? `${row.scenarioName} 已加入运行队列`
      : kind === 'run_started' ? `${row.scenarioName} 开始运行`
        : kind === 'auth_wait' ? `${row.scenarioName} 等待登录`
          : `${row.scenarioName} ${payload.status === 'SUCCEEDED' ? '运行成功' : payload.status === 'CANCELLED' ? '已取消' : '运行失败'}`
    candidates.push({ targetId: row.targetId, stableId: row.eventId, source: 'run', kind, occurredAt: row.occurredAt.toISOString(), title: text(title), runId: row.runId })
  }

  // Old events may have been retained for less time than their Run. Keep the durable terminal fact visible.
  const rankedTerminal = db.select({
    targetId: runs.targetId, runId: runs.id, scenarioName: scenarios.name,
    status: runs.status, finishedAt: runs.finishedAt,
    targetRank: sql<number>`row_number() over(partition by ${runs.targetId} order by ${runs.finishedAt} desc, ${runs.id} desc)`.as('target_rank'),
  }).from(runs).innerJoin(scenarios, and(eq(scenarios.id, runs.scenarioId), eq(scenarios.targetId, runs.targetId)))
    .where(and(inArray(runs.targetId, targetIds), isNull(runs.deletedAt), userPurpose(scenarios.purpose),
      inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED']), sql`${runs.finishedAt} is not null`))
    .as('ranked_terminal')
  const terminalRows = await db.select().from(rankedTerminal).where(lte(rankedTerminal.targetRank, 3))
  const latestRunEvent = new Map(candidates.filter((item) => item.runId).map((item) => [item.runId!, item.occurredAt]))
  for (const row of terminalRows) {
    if (!row.finishedAt || (latestRunEvent.get(row.runId) ?? '') >= row.finishedAt.toISOString()) continue
    const title = `${row.scenarioName} ${row.status === 'SUCCEEDED' ? '运行成功' : row.status === 'CANCELLED' ? '已取消' : '运行失败'}`
    candidates.push({ targetId: row.targetId, stableId: row.runId, source: 'run', kind: 'run_finished', occurredAt: row.finishedAt.toISOString(), title: text(title), runId: row.runId })
  }
  return candidates
}

async function loadSessionActivities(db: Db, targetIds: string[]): Promise<ActivityCandidate[]> {
  if (!targetIds.length) return []
  const { sessionEvents, targetAccounts } = schemaFor(db)
  const ranked = db.select({
    targetId: sessionEvents.targetId,
    targetAccountId: sessionEvents.targetAccountId,
    runId: sessionEvents.runId,
    eventId: sessionEvents.id,
    type: sessionEvents.type,
    occurredAt: sessionEvents.createdAt,
    accountName: targetAccounts.displayName,
    targetRank: sql<number>`row_number() over(partition by ${sessionEvents.targetId} order by ${sessionEvents.createdAt} desc, ${sessionEvents.id} desc)`.as('target_rank'),
  }).from(sessionEvents)
    .leftJoin(targetAccounts, and(eq(targetAccounts.id, sessionEvents.targetAccountId), eq(targetAccounts.targetId, sessionEvents.targetId)))
    .where(and(inArray(sessionEvents.targetId, targetIds), inArray(sessionEvents.type, ['auth.verified', 'session.lost', 'operation.waiting_for_auth'])))
    .as('ranked_session')
  const rows = await db.select().from(ranked).where(lte(ranked.targetRank, 6))
  return rows.map((row) => {
    const kind = row.type === 'auth.verified' ? 'auth_verified' as const
      : row.type === 'session.lost' ? 'session_lost' as const : 'auth_wait' as const
    const name = row.accountName ?? '目标账号'
    const title = kind === 'auth_verified' ? `${name} 登录已核验`
      : kind === 'session_lost' ? `${name} 浏览器会话失联` : `${name} 等待人工登录`
    return { targetId: row.targetId, stableId: row.eventId, source: 'session' as const, kind,
      occurredAt: row.occurredAt.toISOString(), title: text(title),
      ...(row.accountName ? { targetAccountId: row.targetAccountId } : {}),
      ...(row.runId ? { runId: row.runId } : {}) }
  })
}

function selectActivities(candidates: ActivityCandidate[]): TargetOverviewActivity[] {
  const runAuthWait = new Set(candidates.filter((item) => item.source === 'run' && item.kind === 'auth_wait' && item.runId).map((item) => item.runId!))
  const ordered = [...candidates].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.stableId.localeCompare(a.stableId))
  const seenRun = new Set<string>()
  const seenAuthWait = new Set<string>()
  const selected: TargetOverviewActivity[] = []
  for (const item of ordered) {
    if (item.source === 'session' && item.kind === 'auth_wait' && item.runId && runAuthWait.has(item.runId)) continue
    if (item.source === 'run' && item.runId) {
      if (seenRun.has(item.runId)) continue
      seenRun.add(item.runId)
    }
    if (item.kind === 'auth_wait' && item.runId) {
      if (seenAuthWait.has(item.runId)) continue
      seenAuthWait.add(item.runId)
    }
    const { targetId: _targetId, stableId: _stableId, ...dto } = item
    selected.push(dto)
    if (selected.length === 3) break
  }
  return selected
}

function makeReadiness(
  target: TargetRow,
  accounts: ReturnType<typeof accountSummary>,
  runningRunId: string | undefined,
  canControlSession: boolean,
  canManageSession: boolean,
) {
  const { eligibleBusinessTotal, readyAccounts, needLoginAccounts, identityMismatchAccounts, lostAccounts,
    needsCheckAccounts, occupiedAccounts, maintenanceAccounts, preview } = accounts
  const loginAccount = preview.find((account) => account.status === 'needs_login')
  const checkAccount = preview.find((account) => account.status === 'needs_check')
  const sessionsAction = { kind: canManageSession ? 'manage_sessions' as const : 'view_sessions' as const }
  if (target.status === 'disabled') return { state: 'disabled' as const, reason: '系统已停用', nextAction: { kind: 'view_target' as const } }
  if (eligibleBusinessTotal === 0) return { state: 'no_business_account' as const, reason: '暂无启用的浏览器业务账号；非浏览器场景不受此项限制', nextAction: { kind: 'view_conditions' as const } }
  if (readyAccounts > 0) return { state: 'ready' as const,
    reason: needLoginAccounts > 0 ? `${readyAccounts} 个账号有空闲登录会话，另有 ${needLoginAccounts} 个需登录` : `${readyAccounts} 个账号有空闲登录会话，执行时仍会复核`,
    nextAction: loginAccount
      ? canControlSession && loginAccount.requiresHumanAuth
        ? { kind: 'handle_login' as const, targetAccountId: loginAccount.targetAccountId }
        : { kind: 'view_login' as const, targetAccountId: loginAccount.targetAccountId }
      : sessionsAction,
  }
  if (needLoginAccounts > 0 && loginAccount) return { state: 'need_login' as const,
    reason: `${needLoginAccounts} 个账号需要登录${loginAccount.requiresHumanAuth ? '，等待人工处理' : '，可尝试自动续登'}`,
    nextAction: canControlSession && loginAccount.requiresHumanAuth
      ? { kind: 'handle_login' as const, targetAccountId: loginAccount.targetAccountId }
      : { kind: 'view_login' as const, targetAccountId: loginAccount.targetAccountId },
  }
  if (identityMismatchAccounts > 0) return { state: 'identity_mismatch' as const, reason: `${identityMismatchAccounts} 个账号登录身份不匹配`, nextAction: sessionsAction }
  if (lostAccounts > 0) return { state: 'lost' as const, reason: `${lostAccounts} 个账号的浏览器会话已失联`, nextAction: sessionsAction }
  if (needsCheckAccounts > 0) return { state: 'needs_check' as const, reason: `${needsCheckAccounts} 个账号需要核验登录状态`,
    nextAction: canControlSession && checkAccount ? { kind: 'check_login' as const, targetAccountId: checkAccount.targetAccountId } : sessionsAction }
  if (occupiedAccounts > 0 || maintenanceAccounts > 0) return { state: 'busy' as const,
    reason: occupiedAccounts ? `${occupiedAccounts} 个账号正在使用` : `${maintenanceAccounts} 个账号正在准备或维护`,
    nextAction: runningRunId ? { kind: 'view_run' as const, runId: runningRunId } : sessionsAction,
  }
  return { state: 'unprepared' as const, reason: '尚无空闲已登录会话，可在运行时按策略准备', nextAction: sessionsAction }
}

export async function readTargetOverview(db: Db, query: TargetOverviewQuery, actorId: string): Promise<TargetOverviewResponse> {
  const parsed = targetOverviewQuerySchema.parse(query)
  const config = driverOf(db) === 'postgres'
    ? { isolationLevel: 'repeatable read' as const, accessMode: 'read only' as const }
    : driverOf(db) === 'mysql' ? { isolationLevel: 'repeatable read' as const } : undefined
  return db.transaction(async (tx) => {
    const now = await clockNow(tx as Db)
    const { targets, targetAccounts, browserSessions, sessionLeases, sessionOperations, scenarios, runs } = schemaFor(tx)
    const grants = await loadAccountGrants(tx as Db, actorId)
    const readScope = scopeFromGrants(grants, 'target:read')
    const targetRows = await tx.select().from(targets)
      .where(and(isNull(targets.deletedAt), targetScopeFilter(targets.id, readScope)))
    const visibleIds = targetRows.map((target) => target.id)
    const inDomain = (id: string, permission: string) => {
      const scope = scopeFromGrants(grants, permission)
      return scope.all || scope.ids.includes(id)
    }
    const sessionIds = visibleIds.filter((id) => inDomain(id, 'session:read'))
    const workflowIds = visibleIds.filter((id) => inDomain(id, 'workflow:read'))
    const mapIds = visibleIds.filter((id) => inDomain(id, 'map:read'))
    const runIds = visibleIds.filter((id) => inDomain(id, 'run:read'))
    const domainSet = (ids: string[]) => new Set(ids)
    const sessionSet = domainSet(sessionIds)
    const workflowSet = domainSet(workflowIds)
    const mapSet = domainSet(mapIds)
    const runSet = domainSet(runIds)

    const accountRows = sessionIds.length
      ? await tx.select().from(targetAccounts).where(and(inArray(targetAccounts.targetId, sessionIds), isNull(targetAccounts.deletedAt)))
      : []
    const accountsByTarget = grouped(accountRows)
    const accountIds = accountRows.map((account) => account.id)
    const liveSessions = accountIds.length
      ? await tx.select().from(browserSessions).where(and(inArray(browserSessions.targetAccountId, accountIds), inArray(browserSessions.targetId, sessionIds), inArray(browserSessions.status, ['CREATING', 'OPEN', 'CLOSING', 'LOST'])))
      : []
    const accountTargetById = new Map(accountRows.map((account) => [account.id, account.targetId]))
    const matchedSessions = liveSessions.filter((session) => accountTargetById.get(session.targetAccountId) === session.targetId)
    const liveSessionIds = matchedSessions.map((session) => session.id)
    const leases = liveSessionIds.length
      ? await tx.select().from(sessionLeases).where(and(inArray(sessionLeases.sessionId, liveSessionIds), eq(sessionLeases.status, 'ACTIVE')))
      : []
    const operations = accountIds.length
      ? await tx.select().from(sessionOperations).where(and(inArray(sessionOperations.targetAccountId, accountIds), inArray(sessionOperations.targetId, sessionIds), or(inArray(sessionOperations.status, ['RUNNING', 'WAITING_FOR_AUTH']), and(eq(sessionOperations.status, 'QUEUED'), sql`${sessionOperations.queueDeadlineAt} > ${databaseNow(tx)}`))))
      : []
    const sessionsByAccount = new Map<string, SessionRow[]>()
    const leasesBySession = new Map<string, LeaseRow[]>()
    const operationsByAccount = new Map<string, OperationRow[]>()
    for (const row of matchedSessions) sessionsByAccount.set(row.targetAccountId, [...sessionsByAccount.get(row.targetAccountId) ?? [], row])
    for (const row of leases) leasesBySession.set(row.sessionId, [...leasesBySession.get(row.sessionId) ?? [], row])
    for (const row of operations) {
      if (accountTargetById.get(row.targetAccountId) !== row.targetId) continue
      operationsByAccount.set(row.targetAccountId, [...operationsByAccount.get(row.targetAccountId) ?? [], row])
    }
    const factsByAccount = new Map(accountRows.map((account) => [account.id, {
      account,
      sessions: sessionsByAccount.get(account.id) ?? [],
      leases: (sessionsByAccount.get(account.id) ?? []).flatMap((session) => leasesBySession.get(session.id) ?? []),
      operations: operationsByAccount.get(account.id) ?? [],
    }] as const))

    const scenarioRows = workflowIds.length
      ? await tx.select({ targetId: scenarios.targetId, status: scenarios.status })
        .from(scenarios).where(and(inArray(scenarios.targetId, workflowIds), isNull(scenarios.deletedAt), userPurpose(scenarios.purpose)))
      : []
    const scenariosByTarget = grouped(scenarioRows)
    const runningRows = runIds.length
      ? await tx.select({ id: runs.id, targetId: runs.targetId, createdAt: runs.createdAt })
        .from(runs).innerJoin(scenarios, and(eq(scenarios.id, runs.scenarioId), eq(scenarios.targetId, runs.targetId)))
        .where(and(inArray(runs.targetId, runIds), isNull(runs.deletedAt), eq(runs.status, 'RUNNING'), userPurpose(scenarios.purpose)))
        .orderBy(desc(runs.createdAt), desc(runs.id))
      : []
    const runningByTarget = grouped(runningRows)
    const runActivities = await loadRunActivities(tx as Db, runIds)
    const sessionActivities = await loadSessionActivities(tx as Db, sessionIds)
    const activitiesByTarget = grouped([...runActivities, ...sessionActivities])
    const allItems: TargetOverviewItem[] = targetRows.map((target) => {
      const canSession = sessionSet.has(target.id)
      const canWorkflow = workflowSet.has(target.id)
      const canRun = runSet.has(target.id)
      const accountData = canSession ? accountSummary(target, accountsByTarget.get(target.id) ?? [], factsByAccount, now) : null
      const visibleActivities = [canRun && 'run', canSession && 'session'].filter((source): source is 'run' | 'session' => Boolean(source))
      return {
        target: {
          id: target.id, code: target.code, name: target.name, status: target.status,
          entryUrl: target.entryUrl, authMethod: target.authMethod, captchaMode: target.captchaMode,
          iconKey: targetIconKeySchema.catch(DEFAULT_TARGET_ICON_KEY).parse(target.iconKey),
          accentKey: targetAccentKeySchema.catch(DEFAULT_TARGET_ACCENT_KEY).parse(target.accentKey),
          createdAt: target.createdAt.toISOString(), updatedAt: target.updatedAt.toISOString(),
        },
        readiness: accountData ? { state: 'available', value: makeReadiness(target, accountData,
          canRun ? runningByTarget.get(target.id)?.[0]?.id : undefined,
          inDomain(target.id, 'session:control'),
          inDomain(target.id, 'session:manage') || inDomain(target.id, 'target:write')) } : { state: 'forbidden' },
        accounts: accountData ? { state: 'available', value: accountData } : { state: 'forbidden' },
        scenarios: canWorkflow ? { state: 'available', value: {
          total: scenariosByTarget.get(target.id)?.length ?? 0,
          active: scenariosByTarget.get(target.id)?.filter((scenario) => scenario.status === 'active').length ?? 0,
        } } : { state: 'forbidden' },
        knowledge: { state: mapSet.has(target.id) ? 'available' : 'forbidden' },
        runs: canRun ? { state: 'available', value: { running: runningByTarget.get(target.id)?.length ?? 0 } } : { state: 'forbidden' },
        activities: visibleActivities.length ? { state: 'available', value: {
          sources: visibleActivities,
          items: selectActivities(activitiesByTarget.get(target.id) ?? []).map((activity) => {
            if (canRun || !activity.runId) return activity
            const { runId: _runId, ...sessionActivity } = activity
            return sessionActivity
          }),
        } } : { state: 'forbidden' },
      }
    })

    const readyTotal = allItems.filter((item) => item.readiness.state === 'available' && item.readiness.value.state === 'ready').length
    const needLoginTotal = allItems.filter((item) => item.accounts.state === 'available' && item.target.status === 'active' && item.accounts.value.needLoginAccounts > 0).length
    const runningTotal = allItems.filter((item) => item.runs.state === 'available' && item.runs.value.running > 0).length
    const needle = parsed.search?.toLowerCase().trim()
    const searched = allItems.filter((item) => {
      if (parsed.targetId && item.target.id !== parsed.targetId) return false
      if (parsed.status && item.target.status !== parsed.status) return false
      if (parsed.authMethod && item.target.authMethod !== parsed.authMethod) return false
      if (needle && !item.target.name.toLowerCase().includes(needle) && !item.target.code.toLowerCase().includes(needle) &&
        !(item.accounts.state === 'available' && (accountsByTarget.get(item.target.id) ?? []).some((account) => account.displayName.toLowerCase().includes(needle)))) return false
      if (parsed.filter === 'ready' && !(item.readiness.state === 'available' && item.readiness.value.state === 'ready')) return false
      if (parsed.filter === 'need_login' && !(item.accounts.state === 'available' && item.target.status === 'active' && item.accounts.value.needLoginAccounts > 0)) return false
      if (parsed.filter === 'running' && !(item.runs.state === 'available' && item.runs.value.running > 0)) return false
      return true
    })
    searched.sort(parsed.sort === 'name'
      ? (a, b) => a.target.name.localeCompare(b.target.name) || a.target.id.localeCompare(b.target.id)
      : (a, b) => b.target.createdAt.localeCompare(a.target.createdAt) || b.target.id.localeCompare(a.target.id))
    const summary = {
      totalTargets: targetRows.length,
      readyTargets: scopedCount(readyTotal, sessionIds.length, targetRows.length, scopeFromGrants(grants, 'session:read').all),
      needLoginTargets: scopedCount(needLoginTotal, sessionIds.length, targetRows.length, scopeFromGrants(grants, 'session:read').all),
      runningTargets: scopedCount(runningTotal, runIds.length, targetRows.length, scopeFromGrants(grants, 'run:read').all),
    }
    const filteredTotal = searched.length
    // Hash the authorized response fields only. A clock-only refresh must not announce a new snapshot.
    const snapshotToken = createHash('sha256')
      .update(JSON.stringify({ summary, filteredTotal, items: searched }))
      .digest('hex')
    return targetOverviewResponseSchema.parse({
      asOf: now.toISOString(), summary, filteredTotal, items: searched,
      nextCursor: null,
      snapshotToken,
    })
  }, config)
}
