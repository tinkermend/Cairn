import { freezeAuthVerificationForRun } from '../sessions/auth-profile.js'
import { assembleRunSnapshot, AssembleRunSnapshotError, resolveAssembledAiExecution } from './assemble-snapshot.js'
import { ensureFrozenAccessPolicyTx } from '../map/access.js'
import { expireRunDeadlines } from './deadline.js'
import { settleRunCancellationTx } from './recover.js'
import { lockRunAccountScope } from './lock-scope.js'
import { atomic, databaseNow, locked, schemaFor, updateRows } from '../native.js'
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max, ne, or, sql, type SQL } from 'drizzle-orm'
import {
  CANCELLED_ATTEMPT_ERROR,
  TERMINAL_RUN_STATUSES,
  cleanupStatusResponseSchema,
  deletePreviewResponseSchema,
  executionActorSchema,
  serviceAdmissionSchema,
  ScenarioValidationError,
  assertRunFromResolved,
  isFinishedRunStatus,
  redactJson,
  resolverDiagnosticsSchema,
  isHaltedRunStatus,
  FACTORY_PLATFORM_CONFIG,
  idempotentRequestMatches,
  runDetailSchema,
  runEvidenceListResponseSchema,
  runListQuerySchema,
  runListResponseSchema,
  authCheckpointSchema,
  authGateClosedError,
  computeContextVersion,
  type AiExecutionConfig,
  type CleanupStatus,
  type CleanupStatusResponse,
  type CreateRunBody,
  type DeletePreviewResponse,
  type ExecutionActor,
  type ServiceAdmission,
  type EvidenceType,
  type ExecutionError,
  type ExecutionPolicy,
  type JsonValue,
  type MapFactBatchItem,
  type RunDetailDto,
  type RunGrant,
  type RunListQuery,
  type RunListResponse,
  type RunPlacement,
  type RunSnapshot,
  type ResolverDiagnostics,
  type RunStatus,
  type ScreenshotPointer,
  type SessionGrant,
  type StepRunStatus,
  type DebugMode,
  type DebugCheckpoint,
  type DebugOverlay,
  type AuthCheckpoint,
  type FrozenMapJob,
  type SelectionDecision,
  selectionDecisionSchema,
} from '@cairn/shared'
import { cursorFilter, paginateResults } from '../cursor.js'
import {
  assertExpectedCounts,
  assertResourceIdle,
  createdAtBounds,
  pendingWriteBlockers,
  resourceDeletedConflict,
  revokeExternalEvidence,
  snapshotDeletedBy,
} from '../lifecycle.js'
import { recordAudit, type AuditActor } from '../audit/record.js'
import {
  findActiveLeaseForRun,
  listActiveLeasesByRunIds,
  lockRunRow,
  releaseRunLeaseTx,
  verifyRunLeaseForWrite,
} from '../leases/leases.js'
import { findLiveSession, verifySessionLeaseForCommit } from '../sessions/sessions.js'
import { computeOccupancyPlacement } from '../sessions/occupancy.js'
import { runLeases, workers } from '../schema/worker.js'
import type { Db } from '../client.js'
import { cancelPendingStepRunsTx, skipRemainingStepRunsTx, skipStepRunsTx } from './step-status.js'
import { newId } from '../id.js'
import { attempts, evidences, runs, scenarios, stepRuns } from '../schema/execution.js'
import { targetAccounts, targets } from '../schema/targets.js'
import { getPlatformConfig } from '../platform-config/store.js'
import { appendFinishAttemptMapFactsTx } from '../map/attempt-facts.js'
import { freezeMapConsumptionTx, insertMapRunReleaseRefTx } from '../map/consumption.js'
import { computeIdempotencyDigest } from './digest.js'
import { badRequest, conflict, mapRestriction, notFound } from './errors.js'
import { toEvidenceMetadata } from '../objects/evidence-map.js'
import { appendRunEvents } from '../observe/events.js'
import { loadScenarioVersion, prepareTrialVersion } from './scenarios.js'
import { deriveOutcomeManifest, deriveRuntimeInvariantManifest } from '@cairn/authoring'
import {
  saveStepOutcomeResultsTx,
  recalculateRunOutcomeTx,
  settleRunOutcome,
  type OutcomeResultInsertItem,
} from './outcome-results.js'

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

function rethrow(error: unknown): never {
  const mapped = mapRestriction(error)
  if (mapped) throw mapped
  throw error
}

export async function countRunsForAccount(db: Db, accountId: string): Promise<number> {
  const { runs } = schemaFor(db)
  const [row] = await db
    .select({ n: count() })
    .from(runs)
    .where(eq(runs.targetAccountId, accountId))
  return Number(row?.n ?? 0)
}

export async function getRun(db: Db, runId: string): Promise<RunDetailDto> {
  const detail = await loadRunDetail(db, runId)
  if (!detail) throw notFound('RUN_NOT_FOUND', '运行不存在')
  return detail
}

export async function listRuns(
  db: Db,
  query: RunListQuery = {},
): Promise<RunListResponse> {
  const parsed = runListQuerySchema.parse(query)
  const { runs, scenarioVersions, scenarios, targetAccounts, targets } = schemaFor(db)
  const limit = parsed.limit
  const filters: (SQL | undefined)[] = [
    isNull(runs.deletedAt),
    parsed.targetId ? eq(runs.targetId, parsed.targetId) : undefined,
    parsed.scenarioId ? eq(runs.scenarioId, parsed.scenarioId) : undefined,
    parsed.status ? eq(runs.status, parsed.status) : undefined,
    parsed.sourceKind === 'service'
      ? isNotNull(runs.serviceCallerId)
      : parsed.sourceKind === 'console'
        ? isNull(runs.serviceCallerId)
        : undefined,
    parsed.search
      ? or(
          sql`lower(${runs.id}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
          sql`lower(${scenarios.name}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
          sql`lower(${targets.name}) like ${'%' + parsed.search.toLowerCase() + '%'}`,
        )
      : undefined,
    parsed.evidenceStatus ? eq(runs.evidenceStatus, parsed.evidenceStatus) : undefined,
    parsed.outcomeStatus ? eq(runs.outcomeStatus, parsed.outcomeStatus) : undefined,
    parsed.isTrial === true
      ? eq(scenarioVersions.kind, 'trial')
      : parsed.isTrial === false
        ? ne(scenarioVersions.kind, 'trial')
        : undefined,
    ...createdAtBounds(runs.createdAt, parsed.from, parsed.to),
    cursorFilter(runs.createdAt, runs.id, parsed.cursor),
  ]

  const rows = await db
    .select({
      run: runs,
      scenarioName: scenarios.name,
      targetName: targets.name,
      targetAccountName: targetAccounts.displayName,
      scenarioVersionKind: scenarioVersions.kind,
      scenarioDeletedAt: scenarios.deletedAt,
      targetDeletedAt: targets.deletedAt,
      targetAccountDeletedAt: targetAccounts.deletedAt,
    })
    .from(runs)
    .innerJoin(scenarios, eq(scenarios.id, runs.scenarioId))
    .innerJoin(targets, eq(targets.id, runs.targetId))
    .innerJoin(scenarioVersions, eq(scenarioVersions.id, runs.scenarioVersionId))
    .leftJoin(targetAccounts, eq(targetAccounts.id, runs.targetAccountId))
    .where(and(...filters.filter((f): f is SQL => f !== undefined)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(limit + 1)

  const leases = await listActiveLeasesByRunIds(
    db,
    rows.map((row) => row.run.id),
  )

  const paginated = paginateResults(
    rows.map((r) => ({
      ...r,
      id: r.run.id,
      createdAt: r.run.createdAt,
    })),
    limit,
  )

  return runListResponseSchema.parse({
    items: paginated.items.map(
      ({
        run: row,
        scenarioName,
        targetName,
        targetAccountName,
        scenarioVersionKind,
        scenarioDeletedAt,
        targetDeletedAt,
        targetAccountDeletedAt,
      }) => ({
        source: row.serviceCallerId
          ? {
              kind: 'service',
              callerId: row.serviceCallerId,
              credentialId: row.serviceCredentialId,
            }
          : { kind: 'console' },
        id: row.id,
        status: row.status,
        outcomeStatus: row.outcomeStatus,
        cancelRequested: row.cancelRequestedAt !== null,
        targetId: row.targetId,
        targetName,
        targetDeleted: Boolean(targetDeletedAt),
        targetAccountId: row.targetAccountId,
        targetAccountName,
        targetAccountDeleted: Boolean(targetAccountDeletedAt),
        scenarioId: row.scenarioId,
        scenarioName,
        scenarioDeleted: Boolean(scenarioDeletedAt),
        scenarioVersionId: row.scenarioVersionId,
        scenarioVersionKind,
        createdAt: row.createdAt.toISOString(),
        startedAt: iso(row.startedAt),
        finishedAt: iso(row.finishedAt),
        evidenceStatus: row.evidenceStatus,
        debugMode: row.debugMode ?? 'runThrough',
        lease: leases.get(row.id) ? { holderWorkerId: leases.get(row.id)!.holderWorkerId } : null,
      }),
    ),
    nextCursor: paginated.nextCursor,
    hasMore: paginated.hasMore,
  })
}

export async function previewDeleteRun(db: Db, runId: string): Promise<DeletePreviewResponse> {
  const { runs, runLeases, storedObjects } = schemaFor(db)
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .limit(1)
  if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')

  const activeBlockers: { id: string; code: string; message: string }[] = []
  if (!TERMINAL_RUN_STATUSES.includes(run.status as any)) {
    activeBlockers.push({
      id: 'run_not_terminal',
      code: 'RUN_NOT_TERMINAL',
      message: '仅终态（成功、失败、已取消）运行允许删除',
    })
  }

  const activeLeases = await db
    .select({ id: runLeases.id })
    .from(runLeases)
    .where(and(eq(runLeases.runId, runId), eq(runLeases.status, 'ACTIVE')))
  if (activeLeases.length > 0) {
    activeBlockers.push({
      id: 'run_busy',
      code: 'RESOURCE_BUSY',
      message: '该运行仍有关联活跃任务租约',
    })
  }

  activeBlockers.push(...(await pendingWriteBlockers(db, [runId])))

  const objects = await db
    .select({ id: storedObjects.id, byteSize: storedObjects.byteSize })
    .from(storedObjects)
    .where(and(eq(storedObjects.runId, runId), isNull(storedObjects.purgedAt)))

  const totalBytes = objects.reduce((sum, o) => sum + (o.byteSize ?? 0), 0)

  return deletePreviewResponseSchema.parse({
    previewToken: newId(),
    counts: {
      storedObjects: objects.length,
      totalBytes,
    },
    blockers: activeBlockers,
  })
}

export async function deleteRun(
  db: Db,
  runId: string,
  actor: AuditActor,
  input: { expectedCounts?: { runs?: number } } = {},
): Promise<CleanupStatusResponse> {
  const { runs, storedObjects } = schemaFor(db)
  try {
    await db.transaction(async (tx) => {
      const [run] = await locked(tx, tx.select().from(runs).where(eq(runs.id, runId)))
      if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')
      if (run.deletedAt) return
      if (!TERMINAL_RUN_STATUSES.includes(run.status as any)) {
        throw conflict('RUN_NOT_TERMINAL', '仅终态（成功、失败、已取消）运行允许删除')
      }
      await assertResourceIdle(tx as unknown as Db, { runIds: [runId], checkPendingWrites: true })
      assertExpectedCounts({ runs: 1 }, input.expectedCounts)

      const now = new Date()
      const deletedBy = await snapshotDeletedBy(tx as unknown as Db, actor)
      await tx
        .update(runs)
        .set({ deletedAt: now, deletedBy, updatedAt: now })
        .where(eq(runs.id, runId))

      await revokeExternalEvidence(tx as unknown as Db, [runId])
      await tx
        .update(storedObjects)
        .set({ deleteRequestedAt: now })
        .where(
          and(
            eq(storedObjects.runId, runId),
            isNull(storedObjects.deleteRequestedAt),
            isNull(storedObjects.purgedAt),
          ),
        )

      const [objectRow] = await tx
        .select({
          n: sql<number>`count(*)`,
          bytes: sql<number>`coalesce(sum(${storedObjects.byteSize}), 0)`,
        })
        .from(storedObjects)
        .where(eq(storedObjects.runId, runId))
      await recordAudit(
        tx as unknown as Db,
        actor,
        'run.delete',
        'run',
        runId,
        `删除运行 ${runId.slice(0, 8)}：对象 ${Number(objectRow?.n ?? 0)}、${Number(objectRow?.bytes ?? 0)} 字节`,
      )
    })
  } catch (error) {
    throw mapRestriction(error) ?? error
  }

  return getRunCleanupStatus(db, runId)
}

export async function getRunCleanupStatus(db: Db, runId: string): Promise<CleanupStatusResponse> {
  const { runs, storedObjects } = schemaFor(db)
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).limit(1)
  if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')
  const objects = await db
    .select({
      status: storedObjects.status,
      byteSize: storedObjects.byteSize,
      purgeAttempts: storedObjects.purgeAttempts,
      lastPurgeErrorAt: storedObjects.lastPurgeErrorAt,
    })
    .from(storedObjects)
    .where(eq(storedObjects.runId, runId))

  const total = objects.length
  const purged = objects.filter((o) => o.status === 'purged').length
  const failed = objects.filter(
    (o) => o.status !== 'purged' && (o.purgeAttempts >= 5 || o.lastPurgeErrorAt !== null),
  ).length
  const totalBytes = objects.reduce((sum, o) => sum + (o.byteSize ?? 0), 0)
  const purgedBytes = objects
    .filter((o) => o.status === 'purged')
    .reduce((sum, o) => sum + (o.byteSize ?? 0), 0)

  const status: CleanupStatus =
    failed > 0
      ? 'failed'
      : total === purged || total === 0
        ? 'completed'
        : purged > 0
          ? 'in_progress'
          : 'pending'

  return cleanupStatusResponseSchema.parse({
    resourceId: runId,
    resourceType: 'run',
    status,
    totalObjects: total,
    purgedObjects: purged,
    failedObjects: failed,
    totalBytes,
    purgedBytes,
    lastError: failed > 0 ? '部分对象文件清理失败，请重试' : null,
    completedAt: status === 'completed' ? new Date().toISOString() : null,
  })
}

export async function retryRunCleanup(
  db: Db,
  runId: string,
  actor: AuditActor,
): Promise<CleanupStatusResponse> {
  await getRunCleanupStatus(db, runId)
  const { storedObjects } = schemaFor(db)
  await db
    .update(storedObjects)
    .set({ purgeAttempts: 0, lastPurgeErrorAt: null })
    .where(and(eq(storedObjects.runId, runId), ne(storedObjects.status, 'purged')))
  await recordAudit(db, actor, 'run.cleanup_retry', 'run', runId, '重试对象清理')
  return getRunCleanupStatus(db, runId)
}

export async function listRunEvidence(db: Db, runId: string) {
  const { evidences } = schemaFor(db)
  await getRun(db, runId)
  const rows = await db
    .select()
    .from(evidences)
    .where(eq(evidences.runId, runId))
    .orderBy(asc(evidences.createdAt), asc(evidences.id))
  return runEvidenceListResponseSchema.parse({
    items: rows.map((row) => toEvidenceMetadata(row)),
  })
}

export async function computeRunPlacement(
  db: Db,
  run: {
    status: RunStatus
    createdAt?: Date
    targetId: string
    targetAccountId: string | null
    hasActiveLease: boolean
  },
): Promise<RunPlacement> {
  return computeOccupancyPlacement(db, {
    status: run.status,
    createdAt: run.createdAt ?? new Date(0),
    targetId: run.targetId,
    targetAccountId: run.targetAccountId,
    hasActiveLease: run.hasActiveLease,
  })
}

export async function loadRunDetail(db: Db, runId: string): Promise<RunDetailDto | null> {
  const { attempts, outcomeResults, runs, scenarioVersions, scenarios, stepRuns, targetAccounts, targets } =
    schemaFor(db)
  const [joined] = await db
    .select({
      run: runs,
      scenarioName: scenarios.name,
      targetName: targets.name,
      targetAccountName: targetAccounts.displayName,
      scenarioVersionKind: scenarioVersions.kind,
      scenarioDeletedAt: scenarios.deletedAt,
      targetDeletedAt: targets.deletedAt,
      targetAccountDeletedAt: targetAccounts.deletedAt,
    })
    .from(runs)
    .innerJoin(scenarios, eq(scenarios.id, runs.scenarioId))
    .innerJoin(targets, eq(targets.id, runs.targetId))
    .innerJoin(scenarioVersions, eq(scenarioVersions.id, runs.scenarioVersionId))
    .leftJoin(targetAccounts, eq(targetAccounts.id, runs.targetAccountId))
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .limit(1)
  if (!joined) return null
  const row = joined.run
  const stepRows = await db
    .select()
    .from(stepRuns)
    .where(eq(stepRuns.runId, runId))
    .orderBy(asc(stepRuns.ordinal))
  const attemptRows =
    stepRows.length === 0
      ? []
      : await db
          .select()
          .from(attempts)
          .where(
            inArray(
              attempts.stepRunId,
              stepRows.map((step) => step.id),
            ),
          )
  const snapshot = row.snapshot
  const stepsById = new Map(snapshot.steps.map((step) => [step.id, step]))
  const lease = await findActiveLeaseForRun(db, runId)
  const placement = await computeRunPlacement(db, {
    status: row.status,
    createdAt: row.createdAt,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    hasActiveLease: lease !== null,
  })
  const outcomeResultRows = await db
    .select()
    .from(outcomeResults)
    .where(eq(outcomeResults.runId, runId))
    .orderBy(asc(outcomeResults.evaluatedAt))

  return runDetailSchema.parse({
    source: row.serviceCallerId ? { kind: 'service', callerId: row.serviceCallerId, credentialId: row.serviceCredentialId } : { kind: 'console' },
    id: row.id,
    status: row.status,
    outcomeStatus: row.outcomeStatus ?? 'NOT_EVALUATED',
    cancelRequested: row.cancelRequestedAt !== null,
    targetId: row.targetId,
    targetName: joined.targetName,
    targetDeleted: Boolean(joined.targetDeletedAt),
    targetAccountId: row.targetAccountId,
    targetAccountName: joined.targetAccountName,
    targetAccountDeleted: Boolean(joined.targetAccountDeletedAt),
    scenarioId: row.scenarioId,
    scenarioName: joined.scenarioName,
    scenarioDeleted: Boolean(joined.scenarioDeletedAt),
    scenarioVersionId: row.scenarioVersionId,
    scenarioVersionKind: joined.scenarioVersionKind,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    evidenceStatus: row.evidenceStatus,
    debugMode: row.debugMode ?? 'runThrough',
    lease: lease
      ? {
          holderWorkerId: lease.holderWorkerId,
          fencingToken: lease.fencingToken,
          expiresAt: lease.expiresAt,
        }
      : null,
    placement,
    snapshot,
    context: row.context,
    outcomeResults: outcomeResultRows.map((r) => ({
      id: r.id,
      runId: r.runId,
      stepRunId: r.stepRunId,
      attemptId: r.attemptId,
      contractId: r.contractId,
      scope: r.scope,
      meaning: r.meaning,
      severity: r.severity,
      onViolation: r.onViolation,
      provenance: r.provenance,
      verdict: r.verdict,
      expected: r.expected ?? null,
      actual: r.actual ?? null,
      evidenceId: r.evidenceId ?? null,
      details: r.details ?? null,
      evaluatedAt: r.evaluatedAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
    checkpoint: row.checkpoint ?? null,
    debugOverlay: row.debugOverlay ?? null,
    authCheckpoint: parseAuthCheckpoint(row.authCheckpoint),
    stepRuns: stepRows.map((step) => {
      const definition = stepsById.get(step.stepId)
      return {
        id: step.id,
        stepId: step.stepId,
        name: definition?.name ?? step.stepId,
        type: definition?.type ?? 'unknown',
        ordinal: step.ordinal,
        status: step.status,
        outcomeStatus: step.outcomeStatus ?? 'NOT_EVALUATED',
        startedAt: iso(step.startedAt),
        finishedAt: iso(step.finishedAt),
        attempts: attemptRows
          .filter((attempt) => attempt.stepRunId === step.id)
          .sort((a, b) => a.attemptNo - b.attemptNo)
          .map((attempt) => ({
            id: attempt.id,
            attemptNo: attempt.attemptNo,
            status: attempt.status,
            startedAt: attempt.startedAt.toISOString(),
            finishedAt: iso(attempt.finishedAt),
            output: attempt.output ?? null,
            error: (attempt.error as ExecutionError | null) ?? null,
          })),
      }
    }),
  })
}

async function resolveRunTargetAccountId(
  db: Db,
  input: { targetId: string; requestedAccountId?: string },
): Promise<string | undefined> {
  if (input.requestedAccountId) return input.requestedAccountId
  const { targetAccounts } = schemaFor(db)
  const rows = await db
    .select()
    .from(targetAccounts)
    .where(
      and(
        eq(targetAccounts.targetId, input.targetId),
        eq(targetAccounts.status, 'active'),
        isNull(targetAccounts.deletedAt),
      ),
    )
  const withSecret = rows.filter((row) => row.secretId && row.secretProvider)
  if (withSecret.length === 1) return withSecret[0]!.id
  if (withSecret.length > 1) {
    throw badRequest('RUN_ACCOUNT_REQUIRED', '目标系统有多个已保存口令的账号，请指定本次使用的目标账号')
  }
  return undefined
}

export async function createRunWithSnapshot(
  db: Db,
  input: CreateRunBody & {
    actor: ExecutionActor
    serviceAdmission?: ServiceAdmission
    externalIdempotencyDigest?: string
    deadlineAt?: Date
    allowTrialVersion?: boolean
    aiExecution?: AiExecutionConfig
    hangWaitMs?: number
    mapJob?: FrozenMapJob
  },
): Promise<{ detail: RunDetailDto; created: boolean }> {
  input = { ...input, actor: executionActorSchema.parse(input.actor), ...(input.serviceAdmission ? { serviceAdmission: serviceAdmissionSchema.parse(input.serviceAdmission) } : {}) }
  const { runs, stepRuns, targetAccounts, targets } = schemaFor(db)
  const { scenario, version } = await loadScenarioVersion(
    db,
    input.scenarioId,
    input.scenarioVersionId,
  )
  if (version.kind === 'trial' && !input.allowTrialVersion) {
    throw badRequest('SCENARIO_VERSION_NOT_PUBLISHED', '正式运行只能使用已发布版本')
  }
  const isTrial = version.kind === 'trial' && Boolean(input.allowTrialVersion)
  if (!isTrial && input.debugMode && input.debugMode !== 'runThrough') {
    throw badRequest('DEBUG_MODE_NOT_ALLOWED', '正式运行只能使用 runThrough 模式')
  }
  const debugMode: DebugMode = isTrial ? (input.debugMode ?? 'holdOnFailure') : 'runThrough'

  if (scenario.status === 'disabled')
    throw conflict('SCENARIO_DISABLED', '场景已停用，不能创建新运行')

  const [target] = await db.select().from(targets).where(eq(targets.id, scenario.targetId)).limit(1)
  if (!target || target.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled')
    throw conflict('TARGET_DISABLED', '目标系统已停用，不能创建新运行')

  const runInput = input.input ?? {}
  try {
    assertRunFromResolved(version.definition.steps, runInput)
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      throw badRequest(error.code, error.message)
    }
    throw error
  }

  const targetAccountId = await resolveRunTargetAccountId(db, {
    targetId: scenario.targetId,
    requestedAccountId: input.targetAccountId,
  })

  let secretRef: RunSnapshot['secretRef']
  if (targetAccountId) {
    const [account] = await db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, targetAccountId))
      .limit(1)
    if (!account || account.deletedAt || account.targetId !== scenario.targetId) {
      throw badRequest('RUN_ACCOUNT_MISMATCH', '目标账号不属于该场景绑定的目标系统')
    }
    if (account.status === 'disabled') throw conflict('RUN_ACCOUNT_DISABLED', '目标账号已停用')
    if (account.secretId && account.secretProvider) {
      secretRef = { provider: account.secretProvider, secretId: account.secretId }
    }
  }

  const platform = await getPlatformConfig(db)
  const document = platform?.document ?? FACTORY_PLATFORM_CONFIG
  const authVerification = await freezeAuthVerificationForRun(db, {
    targetId: scenario.targetId,
    targetAccountId,
    loginFields: target.loginFields ?? null,
    platformRevision: platform?.revision ?? 1,
    sessionAuth: document.sessionAuth,
  })

  const idempotencyDigest = input.externalIdempotencyDigest ?? (input.idempotencyKey
    ? computeIdempotencyDigest({
        scenarioVersionId: version.id,
        input: runInput,
        targetAccountId,
        policy: input.policy,
        sessionPolicy: input.sessionPolicy ?? null,
        evidencePolicy: input.evidencePolicy ?? null,
        mapCapturePolicy: input.mapCapturePolicy ?? null,
        mapConsumption: input.mapConsumption ?? null,
      })
    : null)

  if (input.idempotencyKey) {
    const existing = await findIdempotent(db, input.actor, input.idempotencyKey)
    if (existing) {
      const same = input.externalIdempotencyDigest
        ? existing.idempotencyDigest === idempotencyDigest
        : idempotentRequestMatches({
            existingDigest: existing.idempotencyDigest ?? '',
            rawDigest: idempotencyDigest ?? '',
            legacyDigest: computeIdempotencyDigest({
              scenarioVersionId: version.id,
              input: runInput,
              targetAccountId,
              policy: input.policy,
              sessionPolicy: existing.snapshot.sessionPolicy ?? null,
              evidencePolicy: existing.snapshot.evidencePolicy ?? null,
            }),
            mapCaptureOverride: input.mapCapturePolicy ?? null,
            sessionOverride: input.sessionPolicy,
            evidenceOverride: input.evidencePolicy,
            policyOverride: input.policy,
            snapshotSession: existing.snapshot.sessionPolicy,
            snapshotEvidence: existing.snapshot.evidencePolicy,
            snapshotPolicy: existing.snapshot.policy,
            snapshotMapCapture: existing.snapshot.mapCapturePolicy,
          })
      if (existing.deletedAt) resourceDeletedConflict()
      if (!same) {
        throw conflict('RUN_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的运行输入')
      }
      const detail = await getRun(db, existing.id)
      return { detail, created: false }
    }
  }

  const runId = newId()
  const now = new Date()
  let aiExecution = input.aiExecution
  try {
    aiExecution = resolveAssembledAiExecution({
      steps: version.definition.steps,
      platformDocument: document,
      platformRevision: platform?.revision,
      aiExecution: input.aiExecution,
      hangWaitMs: input.hangWaitMs,
      executionPolicyOverride: input.policy,
    })
  } catch (error) {
    if (error instanceof AssembleRunSnapshotError) throw badRequest(error.code, error.message)
    throw error
  }
  try {
    await atomic(db, async (tx) => {
      const access = await ensureFrozenAccessPolicyTx(tx as unknown as Db, {
        targetId: scenario.targetId,
        actorId: input.actor.id,
        mapJob: Boolean(input.mapJob),
      })
      const mapConsumption = await freezeMapConsumptionTx(tx as unknown as Db, {
        targetId: scenario.targetId,
        scenarioId: scenario.id,
        scenarioVersionId: version.id,
        override: input.mapJob ? { mode: 'off' } : input.mapConsumption,
      })
      let snapshot
      try {
        const outcomeManifest = deriveOutcomeManifest({
          definition: version.definition,
          authoringDocument: version.authoringDocument,
        })
        const runtimeInvariantManifest = deriveRuntimeInvariantManifest(
          version.authoringDocument ?? null,
        )
        snapshot = assembleRunSnapshot({
          runId,
          createdAt: now,
          deadlineAt: input.deadlineAt,
          targetId: scenario.targetId,
          targetAccountId,
          secretRef,
          scenarioId: scenario.id,
          scenarioVersionId: version.id,
          steps: version.definition.steps,
          moduleManifest: version.moduleManifest,
          outcomeManifest,
          runtimeInvariantManifest,
          input: runInput,
          sessionPolicyOverride: input.sessionPolicy,
          evidencePolicyOverride: input.evidencePolicy,
          executionPolicyOverride: input.policy,
          mapCapturePolicyOverride: input.mapCapturePolicy,
          mapJob: input.mapJob,
          target,
          platformDocument: document,
          platformRevision: platform?.revision,
          aiExecution,
          hangWaitMs: input.hangWaitMs,
          authVerification,
          allowedOrigins: access.allowedOrigins,
          accessPolicy: access.frozen,
          mapConsumption,
        })
      } catch (error) {
        if (error instanceof AssembleRunSnapshotError) throw badRequest(error.code, error.message)
        throw error
      }
      const digest = snapshot.digest
      await tx.insert(runs).values({
        id: runId,
        targetId: scenario.targetId,
        scenarioId: scenario.id,
        scenarioVersionId: version.id,
        targetAccountId,
        createdByConsoleAccountId: input.actor.kind === 'service' ? null : input.actor.id,
        serviceCallerId: input.actor.kind === 'service' ? input.actor.id : null,
        serviceCredentialId: input.actor.kind === 'service' ? input.actor.credentialId : null,
        serviceAdmission: input.serviceAdmission,
        deadlineAt: input.deadlineAt,
        status: 'QUEUED',
        evidenceStatus: 'PENDING',
        debugMode,
        snapshot,
        snapshotDigest: digest,
        context: runInput,
        idempotencyKey: input.idempotencyKey,
        idempotencyDigest,
        createdAt: now,
        updatedAt: now,
      })
      await insertMapRunReleaseRefTx(tx as unknown as Db, { runId, frozen: mapConsumption })
      if (snapshot.steps.length > 0) {
        await tx.insert(stepRuns).values(
          snapshot.steps.map((step, ordinal) => ({
            id: newId(),
            runId,
            stepId: step.id,
            ordinal,
            status: 'PENDING' as const,
          })),
        )
      }
      await recordAudit(
        tx as unknown as Db,
        input.actor,
        'run.create',
        'run',
        runId,
        `创建运行（场景 ${scenario.name}）`,
      )
      await appendRunEvents(tx as unknown as Db, runId, [
        { type: 'run.created', payload: { status: 'QUEUED' } },
      ])
    })
  } catch (error) {
    if (input.idempotencyKey && mapRestriction(error)?.code === 'RUN_IDEMPOTENCY_CONFLICT') {
      const raced = await findIdempotent(db, input.actor, input.idempotencyKey)
      if (raced && raced.idempotencyDigest === idempotencyDigest) {
        if (raced.deletedAt) resourceDeletedConflict()
        return { detail: await getRun(db, raced.id), created: false }
      }
    }
    rethrow(error)
  }

  return { detail: await getRun(db, runId), created: true }
}

export async function createTrialRunFromDraft(
  db: Db,
  scenarioId: string,
  input: {
    revision: number
    targetAccountId?: string
    input?: Record<string, JsonValue>
    policy?: ExecutionPolicy
    sessionPolicy?: CreateRunBody['sessionPolicy']
    evidencePolicy?: CreateRunBody['evidencePolicy']
    mapCapturePolicy?: CreateRunBody['mapCapturePolicy']
    mapConsumption?: CreateRunBody['mapConsumption']
    idempotencyKey?: string
    actor: AuditActor
    executableTypes?: readonly string[]
    aiExecution?: AiExecutionConfig
    hangWaitMs?: number
    debugMode?: DebugMode
  },
): Promise<{ detail: RunDetailDto; created: boolean }> {
  try {
    return await atomic(db, async (tx) => {
      const prepared = await prepareTrialVersion(tx, scenarioId, {
        revision: input.revision,
        runInput: input.input ?? {},
        actor: input.actor,
        executableTypes: input.executableTypes,
      })
      return createRunWithSnapshot(tx, {
        scenarioId,
        scenarioVersionId: prepared.versionId,
        targetAccountId: input.targetAccountId,
        input: input.input,
        policy: input.policy,
        sessionPolicy: input.sessionPolicy,
        evidencePolicy: input.evidencePolicy,
        mapCapturePolicy: input.mapCapturePolicy,
        mapConsumption: input.mapConsumption,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        aiExecution: input.aiExecution,
        hangWaitMs: input.hangWaitMs,
        allowTrialVersion: true,
        debugMode: input.debugMode,
      })
    })
  } catch (error) {
    rethrow(error)
  }
}

async function findIdempotent(db: Db, actor: ExecutionActor, key: string) {
  const { runs } = schemaFor(db)
  const [row] = await db
    .select()
    .from(runs)
    .where(and(eq(actor.kind === 'service' ? runs.serviceCallerId : runs.createdByConsoleAccountId, actor.id), eq(runs.idempotencyKey, key)))
    .limit(1)
  return row
}

export async function requestRunCancel(
  db: Db,
  runId: string,
  actor: ExecutionActor,
): Promise<RunDetailDto> {
  const { runs } = schemaFor(db)
  const now = new Date()
  await atomic(db, async (tx) => {
    await lockRunAccountScope(tx, runId)
    const current = await lockRunRow(tx as unknown as Db, runId)
    if (!current) throw notFound('RUN_NOT_FOUND', '运行不存在')
    if (isFinishedRunStatus(current.status) || current.status === 'NEEDS_REVIEW') return

    const firstCancel = current.cancelRequestedAt == null
    await tx
      .update(runs)
      .set({
        cancelRequestedAt: current.cancelRequestedAt ?? now,
        updatedAt: now,
      })
      .where(eq(runs.id, runId))
    if (firstCancel) {
      await appendRunEvents(tx as unknown as Db, runId, [
        { type: 'run.cancel_requested', payload: { cancelRequested: true } },
      ])
    }
    await settleRunCancellationTx(tx as unknown as Db, runId, now)
    await recordAudit(tx as unknown as Db, actor, 'run.cancel', 'run', runId, '取消运行')
  })
  return getRun(db, runId)
}

export async function startAttempt(
  db: Db,
  input: {
    runId: string
    stepRunId: string
    inputPayload: JsonValue
    grant: RunGrant
    secrets?: readonly string[]
  },
): Promise<{ attemptId: string; attemptNo: number } | null> {
  const { attempts, evidences, runs, stepRuns } = schemaFor(db)
  return db.transaction(async (tx) => {
    await expireRunDeadlines(tx as unknown as Db, input.runId)
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run || (run.status !== 'RUNNING' && run.status !== 'HOLDING') || run.cancelRequestedAt) return null
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, input.grant))) return null
    const [full] = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1)
    if (!full) return null
    const [step] = await tx.select().from(stepRuns).where(eq(stepRuns.id, input.stepRunId)).limit(1)
    if (!step || (step.status !== 'PENDING' && step.status !== 'RUNNING' && step.status !== 'FAILED')) return null
    if (step.status === 'FAILED' && full.status !== 'HOLDING') return null

    const stepNeedsStart = step.status === 'PENDING' || step.status === 'FAILED'
    if (stepNeedsStart) {
      const moved = await updateRows(
        tx,
        stepRuns,
        { status: 'RUNNING', startedAt: step.startedAt ?? new Date() },
        and(eq(stepRuns.id, input.stepRunId), inArray(stepRuns.status, ['PENDING', 'FAILED'])),
        { id: stepRuns.id },
      )
      if (moved.length === 0) return null
    }

    const wasHolding = full.status === 'HOLDING'
    const now = new Date()
    if (wasHolding) {
      await tx
        .update(runs)
        .set({ status: 'RUNNING', updatedAt: now })
        .where(eq(runs.id, input.runId))
    }

    const [agg] = await tx
      .select({ n: max(attempts.attemptNo) })
      .from(attempts)
      .where(eq(attempts.stepRunId, input.stepRunId))
    const attemptNo = Number(agg?.n ?? 0) + 1
    const attemptId = newId()
    await tx.insert(attempts).values({
      id: attemptId,
      stepRunId: input.stepRunId,
      attemptNo,
      status: 'RUNNING',
      startedAt: now,
    })
    const inputEvidenceId = newId()
    await tx.insert(evidences).values({
      id: inputEvidenceId,
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId,
      type: 'input',
      status: 'available',
      schemaVersion: 1,
      payload: redactJson(input.inputPayload, input.secrets ?? []),
      createdAt: now,
    })
    await appendRunEvents(tx as unknown as Db, input.runId, [
      ...(wasHolding
        ? [
            { type: 'run.status_changed' as const, payload: { status: 'RUNNING' } },
            { type: 'run.debug_resumed' as const, payload: { action: 'retry_current', stepRunId: input.stepRunId } },
          ]
        : []),
      ...(stepNeedsStart
        ? [{ type: 'step_run.started' as const, stepRunId: input.stepRunId, payload: { status: 'RUNNING' } }]
        : []),
      {
        type: 'attempt.started',
        stepRunId: input.stepRunId,
        attemptId,
        payload: { attemptNo },
      },
      {
        type: 'evidence.recorded',
        stepRunId: input.stepRunId,
        attemptId,
        payload: { evidenceId: inputEvidenceId, type: 'input', status: 'available' },
      },
    ])
    return { attemptId, attemptNo }
  })
}

export type FinishAttemptInput = {
  runId: string
  attemptId: string
  attemptStatus: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  output?: JsonValue | null
  error?: ExecutionError | null
  context?: Record<string, JsonValue>
  stepRunStatus: StepRunStatus
  runStatus?: RunStatus
  skipRemaining?: boolean
  skipStepIds?: string[]
  selectionDecision?: SelectionDecision
  cancelPending?: boolean
  checkpoint?: DebugCheckpoint | null
  debugOverlay?: DebugOverlay | null
  authCheckpoint?: AuthCheckpoint | null
  /**
   * 浏览器步骤提交边界：若提供，写 SUCCEEDED 前在事务内校验租约仍有效。
   * 丢租时 SIDE_EFFECT → NEEDS_REVIEW，其余 → FAILED，不写成功结果。
   */
  sessionLease?: SessionGrant & {
    holderWorkerId: string
    effectType?: 'READ_ONLY' | 'IDEMPOTENT' | 'SIDE_EFFECT'
  }
  /** 浏览器定位诊断。失败时另写一条 log 证据，不塞进 error 契约。 */
  diagnostics?: ResolverDiagnostics
  /** 失败截图指针。已落对象的行由 ObjectService 写；这里只补 missingReason。 */
  screenshot?: ScreenshotPointer
  /** 失败 Trace 指针。与 screenshot 同一套：有行不插，无行且 missingReason 则补 missing。 */
  trace?: ScreenshotPointer
  secrets?: readonly string[]
  grant: RunGrant
  /** 仅测试：Evidence 写完后抛错，验证整单回滚 */
  injectFailure?: Error
  /**
   * 仅测试：Run 行已锁、租约已验、尚未写入任何事实时暂停。
   *
   * 这是 D5 的 TOCTOU 窗口。没有 `lockRunRow` 的话，回收与接管会正好挤进这里：
   * 谓词读到的「租约仍有效」在 COMMIT 前就已经过时，旧 owner 照样提交 SUCCEEDED。
   * 屏障必须留在生产代码里，否则这条不变量只能靠人看，没有任何检查卡得住。
   */
  barrierAfterVerify?: () => Promise<void>
  /** 动作后预构建的地图事实，与 Attempt 同事务写入；地图契约错误不得回滚 Attempt。 */
  mapFacts?: MapFactBatchItem[]
  /** 本次 Attempt 产生的结果轴评价项（若有），与 Attempt 同事务持久化 */
  outcomeResults?: OutcomeResultInsertItem[]
}

/**
 * `updated: false` = Attempt 已不是 RUNNING（迟到回调），调用方必须停手。
 * `cancelled: true` = 写入被改写成取消，调用方同样必须停手。
 */
export type FinishAttemptResult = { updated: boolean; cancelled: boolean }

export async function finishAttempt(
  db: Db,
  input: FinishAttemptInput,
): Promise<FinishAttemptResult> {
  return db.transaction((tx) => finishAttemptTx(tx as unknown as Db, input))
}

export async function finishAttemptTx(
  tx: Db,
  input: FinishAttemptInput,
): Promise<FinishAttemptResult> {
  if (input.authCheckpoint) input = { ...input, authCheckpoint: authCheckpointSchema.parse(input.authCheckpoint) }
  const { attempts, evidences, runs, stepRuns } = schemaFor(tx)
  const now = new Date()
  await expireRunDeadlines(tx, input.runId)
  const locked = await lockRunRow(tx, input.runId)
  if (!locked || isHaltedRunStatus(locked.status)) return { updated: false, cancelled: false }
  if (!(await verifyRunLeaseForWrite(tx, input.grant))) return { updated: false, cancelled: false }
  if (input.barrierAfterVerify) await input.barrierAfterVerify()
  const [run] = await tx.select().from(runs).where(eq(runs.id, input.runId)).limit(1)
  if (!run) return { updated: false, cancelled: false }

  const [attempt] = await tx
    .select()
    .from(attempts)
    .where(eq(attempts.id, input.attemptId))
    .limit(1)
  if (!attempt || attempt.status !== 'RUNNING') return { updated: false, cancelled: false }

  /**
   * 取消请求已到达：本次尝试的结论一律作废。
   *
   * 迟到的成功（Delay 跑完才看到取消请求）不得写成 SUCCEEDED，重试也不得再发起——
   * 这是「Running 中取消不出现迟到 SUCCEEDED」的唯一收口点，放在事务里与状态同生共死。
   * 例外是 NEEDS_REVIEW：副作用结果未知优先于取消，不能被取消洗成干净终态。
   */
  let cancelled = run.cancelRequestedAt !== null && input.runStatus !== 'NEEDS_REVIEW'
  if (cancelled) input = { ...input, authCheckpoint: undefined }

  let attemptStatus = input.attemptStatus
  let output = input.output
  let error = input.error
  let stepRunStatus = input.stepRunStatus
  let runStatus = input.runStatus
  let skipRemaining = input.skipRemaining
  let context = input.context

  /**
   * 浏览器步骤提交边界：丢租后的结果不可信。
   * SIDE_EFFECT → NEEDS_REVIEW；其余 → FAILED。不得写成 SUCCEEDED。
   */
  if (attemptStatus === 'SUCCEEDED' && input.sessionLease) {
    const held = await verifySessionLeaseForCommit(tx, input.sessionLease)
    if (!held) {
      const sideEffect = input.sessionLease.effectType === 'SIDE_EFFECT'
      attemptStatus = 'FAILED'
      output = null
      error = {
        code: 'SESSION_LEASE_LOST',
        category: sideEffect ? 'UNKNOWN' : 'INFRASTRUCTURE',
        retryable: false,
        safeMessage: '提交结果前会话租约已失效',
      }
      stepRunStatus = 'FAILED'
      runStatus = sideEffect ? 'NEEDS_REVIEW' : 'FAILED'
      // Cancellation cannot turn an untrusted side-effect result into a clean terminal state.
      if (sideEffect) cancelled = false
      skipRemaining = true
      context = undefined
    }
  }

  const closed = await updateRows(
    tx,
    attempts,
    {
      status: cancelled ? 'CANCELLED' : attemptStatus,
      output: cancelled ? null : (output ?? null),
      error: cancelled ? CANCELLED_ATTEMPT_ERROR : (error ?? null),
      finishedAt: now,
    },
    and(eq(attempts.id, input.attemptId), eq(attempts.status, 'RUNNING')),
    { id: attempts.id },
  )
  if (closed.length === 0) return { updated: false, cancelled: false }

  const evidenceType: EvidenceType | undefined = cancelled
    ? 'error'
    : attemptStatus === 'SUCCEEDED'
      ? 'output'
      : error
        ? 'error'
        : undefined
  const secrets = input.secrets ?? []
  const recorded: { evidenceId: string; type: EvidenceType; status: 'available' | 'missing' }[] = []
  if (evidenceType) {
    const rawPayload = cancelled
      ? CANCELLED_ATTEMPT_ERROR
      : evidenceType === 'output'
        ? (output ?? null)
        : (error ?? null)
    const evidenceId = newId()
    await tx.insert(evidences).values({
      id: evidenceId,
      runId: input.runId,
      stepRunId: attempt.stepRunId,
      attemptId: input.attemptId,
      type: evidenceType,
      status: 'available',
      schemaVersion: 1,
      payload: redactJson(rawPayload, secrets),
      createdAt: now,
    })
    recorded.push({ evidenceId, type: evidenceType, status: 'available' })
  }

  if (!cancelled && input.selectionDecision) {
    const evidenceId = newId()
    await tx.insert(evidences).values({
      id: evidenceId,
      runId: input.runId,
      stepRunId: attempt.stepRunId,
      attemptId: input.attemptId,
      type: 'log',
      status: 'available',
      schemaVersion: 1,
      payload: redactJson(selectionDecisionSchema.parse(input.selectionDecision), secrets),
      createdAt: now,
    })
    recorded.push({ evidenceId, type: 'log', status: 'available' })
  }

  if (!cancelled && attemptStatus !== 'SUCCEEDED' && input.diagnostics) {
    const evidenceId = newId()
    await tx.insert(evidences).values({
      id: evidenceId,
      runId: input.runId,
      stepRunId: attempt.stepRunId,
      attemptId: input.attemptId,
      type: 'log',
      status: 'available',
      schemaVersion: 1,
      payload: redactJson(resolverDiagnosticsSchema.parse(input.diagnostics), secrets),
      createdAt: now,
    })
    recorded.push({ evidenceId, type: 'log', status: 'available' })
  }
  if (!cancelled) {
    const screenshotId = await insertMissingObjectEvidence(tx, {
      runId: input.runId,
      stepRunId: attempt.stepRunId,
      attemptId: input.attemptId,
      type: 'screenshot',
      pointer: input.screenshot,
      now,
    })
    if (screenshotId) recorded.push({ evidenceId: screenshotId, type: 'screenshot', status: 'missing' })
    const traceId = await insertMissingObjectEvidence(tx, {
      runId: input.runId,
      stepRunId: attempt.stepRunId,
      attemptId: input.attemptId,
      type: 'trace',
      pointer: input.trace,
      now,
    })
    if (traceId) recorded.push({ evidenceId: traceId, type: 'trace', status: 'missing' })
  }

  // 取消时不采纳输出：context 保持取消前已提交的值。
  if (context && !cancelled) {
    await tx.update(runs).set({ context, updatedAt: now }).where(eq(runs.id, input.runId))
  }

  const finalStepStatus = cancelled ? 'CANCELLED' : stepRunStatus
  const stepTerminal = finalStepStatus !== 'RUNNING' && finalStepStatus !== 'PENDING'
  await tx
    .update(stepRuns)
    .set({
      status: finalStepStatus,
      ...(stepTerminal ? { finishedAt: now } : {}),
    })
    .where(eq(stepRuns.id, attempt.stepRunId))

  let skipped: { id: string; stepId: string }[] = []
  if (cancelled || input.cancelPending) await cancelPendingStepRunsTx(tx, input.runId, now)
  else if (skipRemaining) skipped = await skipRemainingStepRunsTx(tx, input.runId, now)
  else if (input.skipStepIds?.length) skipped = await skipStepRunsTx(tx, input.runId, input.skipStepIds, now)

  const untrustedOutcome =
    cancelled || (input.attemptStatus === 'SUCCEEDED' && attemptStatus !== 'SUCCEEDED')
  await saveStepOutcomeResultsTx(tx, {
    runId: input.runId,
    stepRunId: attempt.stepRunId,
    attemptId: input.attemptId,
    results: input.outcomeResults,
    snapshot: run.snapshot as RunSnapshot,
    now,
  })
  await appendFinishAttemptMapFactsTx(tx, {
    grant: input.grant,
    snapshot: run.snapshot as RunSnapshot,
    scenarioVersionId: run.scenarioVersionId,
    runId: input.runId,
    attemptId: input.attemptId,
    stepRunId: attempt.stepRunId,
    facts: input.mapFacts,
    skipped,
    untrustedOutcome,
    now,
  })

  const finalRunStatus = cancelled ? 'CANCELLED' : runStatus
  if (finalRunStatus) {
    await tx
      .update(runs)
      .set({
        status: finalRunStatus,
        updatedAt: now,
        // finished_at 表示「已有最终结论」，按 FINISHED 而不是 HALTED 判定：
        // NEEDS_REVIEW 只是停下来等人，结论要等 reviewRun 才写，否则耗时统计会把待核查
        // 算成已完成，同一条 Run 还会先后写两个不同的完成时间。
        ...(isFinishedRunStatus(finalRunStatus) ? { finishedAt: now } : {}),
        ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}),
        ...(input.debugOverlay !== undefined ? { debugOverlay: input.debugOverlay } : {}),
        ...(input.authCheckpoint !== undefined ? { authCheckpoint: input.authCheckpoint } : {}),
      })
      .where(eq(runs.id, input.runId))
    if (isHaltedRunStatus(finalRunStatus) || input.authCheckpoint) {
      await recalculateRunOutcomeTx(tx, input.runId, run.snapshot as RunSnapshot, now)
    }
    if (isHaltedRunStatus(finalRunStatus) || finalRunStatus === 'WAITING_FOR_AUTH') {
      await releaseRunLeaseTx(
        tx,
        input.grant,
        finalRunStatus === 'WAITING_FOR_AUTH' ? 'waiting_for_auth' : 'run_halted',
      )
    }
  } else if (input.checkpoint !== undefined || input.debugOverlay !== undefined || input.authCheckpoint !== undefined) {
    await tx
      .update(runs)
      .set({
        ...(input.checkpoint !== undefined ? { checkpoint: input.checkpoint } : {}),
        ...(input.debugOverlay !== undefined ? { debugOverlay: input.debugOverlay } : {}),
        ...(input.authCheckpoint !== undefined ? { authCheckpoint: input.authCheckpoint } : {}),
        updatedAt: now,
      })
      .where(eq(runs.id, input.runId))
    if (input.authCheckpoint) {
      await recalculateRunOutcomeTx(tx, input.runId, run.snapshot as RunSnapshot, now)
    }
  }

  if (input.injectFailure) throw input.injectFailure

  await appendRunEvents(tx, input.runId, [
    {
      type: 'attempt.finished',
      stepRunId: attempt.stepRunId,
      attemptId: input.attemptId,
      workerId: input.grant.holderWorkerId,
      payload: { status: cancelled ? 'CANCELLED' : attemptStatus },
    },
    ...recorded.map((item) => ({
      type: item.status === 'missing' ? ('evidence.missing' as const) : ('evidence.recorded' as const),
      stepRunId: attempt.stepRunId,
      attemptId: input.attemptId,
      payload: item,
    })),
    ...(stepTerminal
      ? [
          {
            type: 'step_run.finished' as const,
            stepRunId: attempt.stepRunId,
            payload: { status: finalStepStatus },
          },
        ]
      : []),
    ...(finalRunStatus
      ? [{ type: 'run.status_changed' as const, payload: { status: finalRunStatus } }]
      : []),
    ...(finalRunStatus === 'HOLDING'
      ? [{ type: 'run.holding' as const, payload: { checkpoint: input.checkpoint ?? null } }]
      : []),
    ...(input.authCheckpoint && input.authCheckpoint.status !== 'closed' &&
      !['closed', 'recovering'].includes(parseAuthCheckpoint(run.authCheckpoint)?.status ?? '')
      ? [{ type: 'run.auth_gate_closed' as const, payload: { ...input.authCheckpoint, status: 'closed' } }] : []),
    ...authCheckpointEvents(input.authCheckpoint),
  ])

  return { updated: true, cancelled }
}

async function insertMissingObjectEvidence(
  tx: Db,
  input: {
    runId: string
    stepRunId: string
    attemptId: string
    type: 'screenshot' | 'trace'
    pointer?: ScreenshotPointer
    now: Date
  },
): Promise<string | null> {
  const { evidences } = schemaFor(tx)
  if (!input.pointer?.missingReason || input.pointer.objectKey) return null
  const existing = await tx
    .select({ id: evidences.id })
    .from(evidences)
    .where(and(eq(evidences.attemptId, input.attemptId), eq(evidences.type, input.type)))
    .limit(1)
  if (existing.length > 0) return null
  const id = newId()
  await tx.insert(evidences).values({
    id,
    runId: input.runId,
    stepRunId: input.stepRunId,
    attemptId: input.attemptId,
    type: input.type,
    status: 'missing',
    schemaVersion: 1,
    missingReason: input.pointer.missingReason,
    createdAt: input.now,
  })
  return id
}

/**
 * 步骤已全部成功但 Run 仍停在 `RUNNING` 时补写终态（§7 第 4 步「没有 PENDING 则成功」）。
 *
 * 最后一步成功已能在同一事务里直接写 SUCCEEDED；这条覆盖续跑与恢复路径。单条条件更新，
 * 只要还有非 SUCCEEDED 的 step_run（含 PENDING / RUNNING / FAILED / SKIPPED / CANCELLED）
 * 或有取消请求就 0 行，不会把没跑完的 Run 判成成功。
 */
export async function finishRunIfDrained(db: Db, grant: RunGrant): Promise<{ finished: boolean }> {
  const { runs, stepRuns } = schemaFor(db)
  const now = new Date()
  return db.transaction(async (tx) => {
    await expireRunDeadlines(tx as unknown as Db, grant.runId)
    const locked = await lockRunRow(tx as unknown as Db, grant.runId)
    if (!locked || locked.status !== 'RUNNING') return { finished: false }
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, grant))) return { finished: false }
    const drained = await updateRows(
      tx,
      runs,
      { status: 'SUCCEEDED', finishedAt: now, updatedAt: now },
      and(
        eq(runs.id, grant.runId),
        eq(runs.status, 'RUNNING'),
        isNull(runs.cancelRequestedAt),
        sql`EXISTS (SELECT 1 FROM ${stepRuns} WHERE run_id = ${grant.runId} AND status = 'SUCCEEDED')`,
        sql`NOT EXISTS (SELECT 1 FROM ${stepRuns} WHERE run_id = ${grant.runId} AND status <> 'SUCCEEDED')`,
      ),
      { id: runs.id },
    )
    if (drained.length === 0) return { finished: false }
    const [run] = await tx.select().from(runs).where(eq(runs.id, grant.runId)).limit(1)
    if (run) {
      await recalculateRunOutcomeTx(tx as unknown as Db, grant.runId, run.snapshot as RunSnapshot, now)
    }
    await releaseRunLeaseTx(tx as unknown as Db, grant, 'run_halted')
    await appendRunEvents(tx as unknown as Db, grant.runId, [
      { type: 'run.status_changed', payload: { status: 'SUCCEEDED' } },
    ])
    return { finished: true }
  })
}

export async function skipRemainingStepRuns(db: Db, runId: string): Promise<void> {
  await skipRemainingStepRunsTx(db, runId, new Date())
}

export async function skipStepRuns(db: Db, runId: string, stepIds: readonly string[]): Promise<void> {
  await skipStepRunsTx(db, runId, stepIds, new Date())
}

export async function cancelPendingStepRuns(db: Db, runId: string): Promise<void> {
  await cancelPendingStepRunsTx(db, runId, new Date())
}

export type RunWriteAuthority = { grant: RunGrant } | { recover: true }

async function assertWriteAuthority(
  tx: Db,
  runId: string,
  authority: RunWriteAuthority,
): Promise<boolean> {
  const locked = await lockRunRow(tx, runId)
  if (!locked) return false
  if ('grant' in authority) return verifyRunLeaseForWrite(tx, authority.grant)
  const active = await findActiveLeaseForRun(tx, runId)
  return active === null
}

export async function markRunCancelled(
  db: Db,
  runId: string,
  authority: RunWriteAuthority,
): Promise<void> {
  const { runs } = schemaFor(db)
  const now = new Date()
  await db.transaction(async (tx) => {
    if (!(await assertWriteAuthority(tx as unknown as Db, runId, authority))) return
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run || isHaltedRunStatus(run.status)) return
    if ('grant' in authority) {
      await releaseRunLeaseTx(tx as unknown as Db, authority.grant, 'run_halted')
    }
    await settleRunCancellationTx(tx as unknown as Db, runId, now)
    await recalculateRunOutcomeTx(tx as unknown as Db, runId, run.snapshot as RunSnapshot, now)
  })
}

const RUN_VALIDATION_FAILED_ERROR: ExecutionError = {
  code: 'RUN_VALIDATION_FAILED',
  category: 'VALIDATION',
  retryable: false,
  safeMessage: '运行在步骤开始前因配置校验失败',
}

export async function failRunValidation(
  db: Db,
  runId: string,
  authority: RunWriteAuthority,
  error: ExecutionError = RUN_VALIDATION_FAILED_ERROR,
  options?: { skipRemaining?: boolean; runStatus?: 'FAILED' | 'NEEDS_REVIEW'; authCheckpoint?: AuthCheckpoint; stepRunId?: string },
): Promise<void> {
  const { evidences, runs, stepRuns } = schemaFor(db)
  const status = options?.runStatus ?? 'FAILED'
  const checkpoint = options?.authCheckpoint ? authCheckpointSchema.parse(options.authCheckpoint) : undefined
  const now = new Date()
  await db.transaction(async (tx) => {
    if (!(await assertWriteAuthority(tx as unknown as Db, runId, authority))) return
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1)
    if (!run || isHaltedRunStatus(run.status)) return
    if (run.cancelRequestedAt && status !== 'NEEDS_REVIEW') {
      await settleRunCancellationTx(tx as unknown as Db, runId, now)
      return
    }
    await tx
      .update(runs)
      .set({ status, ...(status === 'FAILED' ? { finishedAt: now } : {}), ...(checkpoint ? { authCheckpoint: checkpoint } : {}), updatedAt: now })
      .where(eq(runs.id, runId))
    await recalculateRunOutcomeTx(tx as unknown as Db, runId, run.snapshot as RunSnapshot, now)
    if (options?.stepRunId) {
      await tx.update(stepRuns).set({ status: 'FAILED', finishedAt: now }).where(and(eq(stepRuns.id, options.stepRunId), eq(stepRuns.runId, runId), eq(stepRuns.status, 'RUNNING')))
    }
    await tx.insert(evidences).values({
      id: newId(),
      runId,
      type: 'error',
      schemaVersion: 1,
      payload: {
        code: error.code,
        category: error.category,
        retryable: error.retryable,
        safeMessage: error.safeMessage,
        ...(error.cause ? { cause: error.cause } : {}),
      },
      createdAt: now,
    })
    if (options?.skipRemaining !== false) {
      await skipRemainingStepRunsTx(tx as unknown as Db, runId, now)
    }
    if ('grant' in authority) {
      await releaseRunLeaseTx(tx as unknown as Db, authority.grant, 'run_halted')
    }
    await appendRunEvents(tx as unknown as Db, runId, [
      { type: 'run.status_changed', payload: { status } },
      { type: 'evidence.recorded', payload: { type: 'error', status: 'available' } },
      ...authCheckpointEvents(checkpoint),
    ])
  })
}

/**
 * 开跑前转入 WAITING_FOR_AUTH 时，C0 仍要求 OutcomeResult 挂在 Attempt 上。
 * 若还没有任何 Attempt，给首步补一条 not_dispatched 的 AUTH_GATE_CLOSED，StepRun 保持 RUNNING，
 * 恢复后仍从该步继续。没有 auth_validity 时不写，避免改无约束场景的执行轴。
 */
export async function openPreStepAuthValidityWindow(
  db: Db,
  grant: RunGrant,
): Promise<string | null> {
  const { attempts, runs, stepRuns } = schemaFor(db)
  const [run] = await db.select().from(runs).where(eq(runs.id, grant.runId)).limit(1)
  if (!run) return null
  const snapshot = run.snapshot as RunSnapshot
  if (!snapshot.runtimeInvariantManifest?.entries.some((item) => item.kind === 'auth_validity')) {
    return null
  }
  const [existing] = await db
    .select({ id: attempts.id })
    .from(attempts)
    .innerJoin(stepRuns, eq(attempts.stepRunId, stepRuns.id))
    .where(eq(stepRuns.runId, grant.runId))
    .limit(1)
  if (existing) return existing.id
  const firstStep = snapshot.steps[0]
  if (!firstStep) return null
  const [stepRun] = await db
    .select()
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, grant.runId), eq(stepRuns.stepId, firstStep.id)))
    .limit(1)
  if (!stepRun) return null
  const started = await startAttempt(db, {
    runId: grant.runId,
    stepRunId: stepRun.id,
    inputPayload: { reason: 'auth_validity_window' },
    grant,
  })
  if (!started) return null
  const closed = await finishAttempt(db, {
    runId: grant.runId,
    attemptId: started.attemptId,
    attemptStatus: 'FAILED',
    error: authGateClosedError('not_dispatched'),
    stepRunStatus: 'RUNNING',
    grant,
  })
  return closed.updated ? started.attemptId : null
}

/**
 * 只改 Run 状态并释放执行租约，不写认证等待占用。
 * 生产进入等待必须走 `enterRunWaitingForAuth`；本函数留给引擎/夹具模拟“已经在等登录”。
 */
export async function markRunWaitingForAuth(db: Db, grant: RunGrant): Promise<boolean> {
  await openPreStepAuthValidityWindow(db, grant)
  const { runs } = schemaFor(db)
  const now = new Date()
  const ok = await db.transaction(async (tx) => {
    const locked = await lockRunRow(tx as unknown as Db, grant.runId)
    if (!locked || locked.status !== 'RUNNING') return false
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, grant))) return false
    const [row] = await updateRows(
      tx,
      runs,
      { status: 'WAITING_FOR_AUTH', updatedAt: now },
      and(eq(runs.id, grant.runId), eq(runs.status, 'RUNNING')),
      { id: runs.id },
    )
    if (!row) return false
    await releaseRunLeaseTx(tx as unknown as Db, grant, 'waiting_for_auth')
    await appendRunEvents(tx as unknown as Db, grant.runId, [
      { type: 'run.auth_wait', payload: { status: 'WAITING_FOR_AUTH' } },
    ])
    return true
  })
  if (ok) await settleRunOutcome(db, grant.runId)
  return ok
}

export async function updateRunDebugOverlay(
  db: Db,
  runId: string,
  overlay: DebugOverlay | null,
): Promise<RunDetailDto> {
  const { runs } = schemaFor(db)
  const now = new Date()
  await atomic(db, async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, runId)
    if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')
    if (run.status !== 'HOLDING') {
      throw conflict('RUN_NOT_HOLDING', '仅 HOLDING 状态的运行允许设置临时覆盖')
    }
    await tx
      .update(runs)
      .set({ debugOverlay: overlay, updatedAt: now })
      .where(eq(runs.id, runId))
  })
  return getRun(db, runId)
}

export async function enterRunHolding(
  db: Db,
  input: {
    runId: string
    grant: RunGrant
    checkpoint: DebugCheckpoint
    debugOverlay?: DebugOverlay | null
  },
): Promise<boolean> {
  const { runs } = schemaFor(db)
  const now = new Date()
  return db.transaction(async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run || run.status !== 'RUNNING' || run.cancelRequestedAt) return false
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, input.grant))) return false
    await tx
      .update(runs)
      .set({
        status: 'HOLDING',
        checkpoint: input.checkpoint,
        ...(input.debugOverlay !== undefined ? { debugOverlay: input.debugOverlay } : {}),
        updatedAt: now,
      })
      .where(eq(runs.id, input.runId))
    await appendRunEvents(tx as unknown as Db, input.runId, [
      { type: 'run.status_changed', payload: { status: 'HOLDING' } },
      { type: 'run.holding', payload: { checkpoint: input.checkpoint } },
    ])
    return true
  })
}

export async function stopRunDebug(
  db: Db,
  runId: string,
  actor: AuditActor,
): Promise<RunDetailDto> {
  const { runs } = schemaFor(db)
  const now = new Date()
  await atomic(db, async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, runId)
    if (!run) throw notFound('RUN_NOT_FOUND', '运行不存在')
    if (run.status !== 'HOLDING') {
      throw conflict('RUN_NOT_HOLDING', '仅 HOLDING 状态的运行允许结束调试会话')
    }
    const detail = await loadRunDetail(tx as unknown as Db, runId)
    const hasFailedStep = detail?.stepRuns.some((s) => s.status === 'FAILED')
    const hasSucceededStep = detail?.stepRuns.some((s) => s.status === 'SUCCEEDED')
    const finalStatus: RunStatus = hasFailedStep ? 'FAILED' : hasSucceededStep ? 'SUCCEEDED' : 'CANCELLED'

    await tx
      .update(runs)
      .set({
        status: finalStatus,
        finishedAt: now,
        debugOverlay: null,
        checkpoint: null,
        updatedAt: now,
      })
      .where(eq(runs.id, runId))

    const activeLease = await findActiveLeaseForRun(tx as unknown as Db, runId)
    if (activeLease) {
      await releaseRunLeaseTx(tx as unknown as Db, activeLease, 'run_halted')
    }

    await appendRunEvents(tx as unknown as Db, runId, [
      { type: 'run.status_changed', payload: { status: finalStatus } },
      { type: 'run.debug_stopped', payload: { reason: 'author_stop', finalStatus } },
    ])
    await recordAudit(tx as unknown as Db, actor, 'run.debug', 'run', runId, '结束调试会话')
  })
  return getRun(db, runId)
}

export async function continueRunDebug(
  db: Db,
  input: {
    runId: string
    grant: RunGrant
  },
): Promise<boolean> {
  const { runs } = schemaFor(db)
  const now = new Date()
  return db.transaction(async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, input.runId)
    if (!run || run.status !== 'HOLDING' || run.cancelRequestedAt) return false
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, input.grant))) return false
    const detail = await loadRunDetail(tx as unknown as Db, input.runId)
    const current = detail?.checkpoint
      ? detail.stepRuns.find((item) => item.stepId === detail.checkpoint?.stepId)
      : undefined
    if (!current) {
      throw conflict('STEP_CANNOT_RETRY', '没有可继续的当前步骤')
    }
    const pausePending = detail?.checkpoint?.reason === 'author_pause' && current.status === 'PENDING'
    if (!pausePending && current.status !== 'SUCCEEDED') {
      throw conflict('STEP_CANNOT_RETRY', '只有当前步骤已成功时才能继续下一步')
    }
    await tx
      .update(runs)
      .set({
        status: 'RUNNING',
        debugOverlay: null,
        updatedAt: now,
      })
      .where(eq(runs.id, input.runId))
    await appendRunEvents(tx as unknown as Db, input.runId, [
      { type: 'run.status_changed', payload: { status: 'RUNNING' } },
      { type: 'run.debug_resumed', payload: { action: 'continue', stepId: current.stepId } },
    ])
    return true
  })
}

function parseAuthCheckpoint(value: unknown): AuthCheckpoint | null {
  if (value == null) return null
  const raw = typeof value === 'string' ? JSON.parse(value) : value
  return authCheckpointSchema.parse(raw)
}

function authCheckpointEvents(checkpoint?: AuthCheckpoint | null) {
  if (!checkpoint) return []
  const type =
    checkpoint.status === 'closed'
      ? ('run.auth_gate_closed' as const)
      : checkpoint.status === 'recovering'
        ? ('run.auth_recovering' as const)
        : checkpoint.status === 'recovered'
          ? ('run.auth_recovered' as const)
          : ('run.auth_unrecoverable' as const)
  return [{ type, payload: checkpoint }]
}

export async function writeRunAuthCheckpoint(
  db: Db,
  input: { runId: string; checkpoint: AuthCheckpoint } & RunWriteAuthority,
): Promise<boolean> {
  input = { ...input, checkpoint: authCheckpointSchema.parse(input.checkpoint) }
  const { runs } = schemaFor(db)
  return db.transaction(async (tx) => {
    const locked = await lockRunRow(tx as unknown as Db, input.runId)
    if (!locked || locked.cancelRequestedAt || isHaltedRunStatus(locked.status)) return false
    if (!(await assertWriteAuthority(tx as unknown as Db, input.runId, input))) return false
    if (input.checkpoint.status === 'recovered' && input.checkpoint.contextVersion !== await computeContextVersion(locked.context)) return false
    const previous = parseAuthCheckpoint(locked.authCheckpoint)
    if (previous && (input.checkpoint.autoRecoveriesUsed < previous.autoRecoveriesUsed || input.checkpoint.manualRecoveriesUsed < previous.manualRecoveriesUsed)) return false
    const now = new Date()
    await tx
      .update(runs)
      .set({ authCheckpoint: input.checkpoint, updatedAt: now })
      .where(eq(runs.id, input.runId))
    await appendRunEvents(tx as unknown as Db, input.runId, authCheckpointEvents(input.checkpoint))
    const [run] = await tx.select({ snapshot: runs.snapshot }).from(runs).where(eq(runs.id, input.runId)).limit(1)
    if (run) {
      await recalculateRunOutcomeTx(tx as unknown as Db, input.runId, run.snapshot as RunSnapshot, now)
    }
    return true
  })
}

export async function loadRunRow(db: Db, runId: string) {
  const { runs } = schemaFor(db)
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1)
  return row ?? null
}

export type { ExecutionPolicy }
