import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  DEFAULT_SUITE_DEADLINE_MS,
  MAX_SUITE_MEMBERS,
  MAX_SUITE_SNAPSHOT_BYTES,
  SUITE_ADMISSION_PROTOCOL,
  aggregateSuiteVerdict,
  createSuiteRunBodySchema,
  mergeSuiteMemberInput,
  resolveSuiteMemberAccountId,
  suiteRunListQuerySchema,
  suiteRunListResponseSchema,
  suiteRunObservationSchema,
  type CreateSuiteRunBody,
  type ExecutionActor,
  type JsonValue,
  type RunEvidenceStatus,
  type SuiteDocument,
  type SuiteMemberAdmission,
  type SuiteRunCounts,
  type SuiteRunEventDto,
  type SuiteRunItemDto,
  type SuiteRunListQuery,
  type SuiteRunObservation,
  type SuiteRunPreviewResponse,
  type SuiteRunStatus,
  type SuiteValidationIssue,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { assertTargetPermission, lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { cursorFilter, paginateResults } from '../cursor.js'
import { newId } from '../id.js'
import { atomic, inTransaction, locked, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { badRequest, conflict, DomainError, mapRestriction, notFound } from '../runs/errors.js'
import { resolveRunTargetAccountId, writeRunWithSnapshot } from '../runs/runs.js'
import { requestRunCancel } from '../runs/runs.js'
import { validateSuiteDocument } from './validate.js'
import { lockReportDefaults, resolveReportProfile } from '../reports/profiles.js'
import { assertReportDeploymentReady } from '../reports/protocol.js'

const OPEN_SUITE_STATUSES: SuiteRunStatus[] = ['QUEUED', 'RUNNING', 'WAITING', 'NEEDS_REVIEW']
const CHILD_TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED'])

function rethrow(error: unknown): never {
  const mapped = mapRestriction(error)
  if (mapped) throw mapped
  throw error
}

function countsOf(items: SuiteRunItemDto[]): SuiteRunCounts {
  return {
    planned: items.length,
    succeeded: items.filter((item) => item.admission === 'SETTLED' && item.runStatus === 'SUCCEEDED').length,
    failed: items.filter((item) => item.admission === 'SETTLED' && item.runStatus === 'FAILED').length,
    cancelled: items.filter((item) => item.admission === 'SETTLED' && item.runStatus === 'CANCELLED').length,
    skipped: items.filter((item) => item.admission === 'SKIPPED').length,
    pending: items.filter((item) => item.admission === 'PENDING').length,
    active: items.filter((item) => item.admission === 'ACTIVE').length,
  }
}

function evidenceOf(statuses: RunEvidenceStatus[]): RunEvidenceStatus {
  if (statuses.some((item) => item === 'PENDING')) return 'PENDING'
  if (statuses.some((item) => item === 'INCOMPLETE')) return 'INCOMPLETE'
  return statuses.length ? 'COMPLETE' : 'PENDING'
}

export async function appendSuiteEvents(
  tx: Db,
  suiteRunId: string,
  drafts: { type: string; payload?: Record<string, JsonValue> }[],
) {
  if (!drafts.length) return
  const { suiteRuns, suiteRunEvents } = schemaFor(tx)
  const [current] = await locked(tx, tx.select({ eventSeq: suiteRuns.eventSeq }).from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)))
  if (!current) return
  let seq = current.eventSeq
  const now = new Date()
  const rows = drafts.map((draft) => {
    seq += 1
    return {
      suiteRunId,
      seq,
      type: draft.type,
      payload: draft.payload,
      createdAt: now,
    }
  })
  await tx.insert(suiteRunEvents).values(rows)
  await tx
    .update(suiteRuns)
    .set({ eventSeq: seq, revision: sql`${suiteRuns.revision} + 1`, updatedAt: now })
    .where(eq(suiteRuns.id, suiteRunId))
}

async function loadObservationTx(db: Db, suiteRunId: string): Promise<SuiteRunObservation> {
  const { suiteRuns, suiteRunItems, runs, scenarioSuites, suiteReportTriggers } = schemaFor(db)
  const [parent] = await db
    .select({ run: suiteRuns, suiteName: scenarioSuites.name })
    .from(suiteRuns)
    .innerJoin(scenarioSuites, eq(scenarioSuites.id, suiteRuns.suiteId))
    .where(eq(suiteRuns.id, suiteRunId))
    .limit(1)
  if (!parent) throw notFound('SUITE_RUN_NOT_FOUND', '集合运行不存在')
  const [trigger] = await db.select().from(suiteReportTriggers).where(eq(suiteReportTriggers.suiteRunId, suiteRunId)).limit(1)
  const rows = await db
    .select({ item: suiteRunItems, child: runs })
    .from(suiteRunItems)
    .innerJoin(runs, eq(runs.id, suiteRunItems.childRunId))
    .where(eq(suiteRunItems.suiteRunId, suiteRunId))
    .orderBy(asc(suiteRunItems.ordinal))
  const items: SuiteRunItemDto[] = rows.map(({ item, child }) => ({
    memberId: item.memberId,
    ordinal: item.ordinal,
    groupId: item.groupId,
    displayName: item.displayName,
    scenarioId: item.scenarioId,
    scenarioVersionId: item.scenarioVersionId,
    childRunId: item.childRunId,
    admission: item.admissionStatus,
    skipReason: item.skipReason,
    runStatus: child.status,
    outcomeStatus: child.outcomeStatus,
    evidenceStatus: child.evidenceStatus,
    targetAccountId: item.targetAccountId,
  }))
  const started = parent.run.startedAt?.getTime() ?? parent.run.createdAt.getTime()
  const finished = parent.run.finishedAt?.getTime() ?? null
  const childDurations = rows.flatMap(({ child }) => child.startedAt && child.finishedAt
    ? [child.finishedAt.getTime() - child.startedAt.getTime()] : [])
  // Legacy/clock-skewed timestamps must not break observation and orchestration.
  // Keep the underlying facts; an invalid duration is unknown, never negative.
  const childDuration = childDurations.length && childDurations.every((duration) => duration >= 0)
    ? childDurations.reduce((sum, duration) => sum + duration, 0) : null
  return suiteRunObservationSchema.parse({
    id: parent.run.id,
    suiteId: parent.run.suiteId,
    suiteVersionId: parent.run.suiteVersionId,
    targetId: parent.run.targetId,
    status: parent.run.status,
    verdict: parent.run.verdict,
    evidenceStatus: parent.run.evidenceStatus,
    cancelRequested: parent.run.cancelRequestedAt != null,
    reason: parent.run.reason,
    failurePolicy: parent.run.failurePolicy,
    deadlineAt: parent.run.deadlineAt.toISOString(),
    startedAt: parent.run.startedAt?.toISOString() ?? null,
    finishedAt: parent.run.finishedAt?.toISOString() ?? null,
    wallClockMs: finished !== null && finished >= started ? finished - started : null,
    childDurationMs: childDuration,
    counts: countsOf(items),
    revision: parent.run.revision,
    eventSeq: parent.run.eventSeq,
    items,
    readAt: new Date().toISOString(),
    createdAt: parent.run.createdAt.toISOString(),
    automaticReport: trigger ? { status: trigger.status, reportId: trigger.reportId, reason: trigger.reason } : null,
  })
}

export async function getSuiteRunObservation(db: Db, suiteRunId: string, actorId?: string) {
  const observation = await loadObservationTx(db, suiteRunId)
  if (actorId) {
    await assertTargetPermission(db, actorId, observation.targetId, 'suite:read')
    await assertTargetPermission(db, actorId, observation.targetId, 'run:read')
  }
  return observation
}

export async function listSuiteRuns(db: Db, query: Partial<SuiteRunListQuery> = {}, actorId?: string) {
  const parsed = suiteRunListQuerySchema.parse(query)
  const { suiteRuns, scenarioSuites } = schemaFor(db)
  const filters: (SQL | undefined)[] = [
    await scopedTargetFilter(db, actorId, suiteRuns.targetId, 'suite:read'),
    await scopedTargetFilter(db, actorId, suiteRuns.targetId, 'run:read'),
    parsed.targetId ? eq(suiteRuns.targetId, parsed.targetId) : undefined,
    parsed.suiteId ? eq(suiteRuns.suiteId, parsed.suiteId) : undefined,
    parsed.status ? eq(suiteRuns.status, parsed.status) : undefined,
    cursorFilter(suiteRuns.createdAt, suiteRuns.id, parsed.cursor),
  ]
  const rows = await db
    .select({ run: suiteRuns, suiteName: scenarioSuites.name })
    .from(suiteRuns)
    .innerJoin(scenarioSuites, eq(scenarioSuites.id, suiteRuns.suiteId))
    .where(and(...filters.filter((item): item is SQL => item !== undefined)))
    .orderBy(desc(suiteRuns.createdAt), desc(suiteRuns.id))
    .limit(parsed.limit + 1)
  const page = paginateResults(
    rows.map((row) => ({ id: row.run.id, createdAt: row.run.createdAt, suiteName: row.suiteName })),
    parsed.limit,
  )
  const observations = await Promise.all(page.items.map((row) => loadObservationTx(db, row.id)))
  return suiteRunListResponseSchema.parse({
    items: observations.map((observation, index) => {
      const { items: _members, ...summary } = observation
      return {
        ...summary,
        suiteName: page.items[index]!.suiteName,
        plannedCount: observation.counts.planned,
      }
    }),
    nextCursor: page.nextCursor,
  })
}

export async function listSuiteRunEventsAfter(
  db: Db,
  suiteRunId: string,
  afterSeq: number,
): Promise<SuiteRunEventDto[]> {
  const { suiteRunEvents } = schemaFor(db)
  const rows = await db
    .select()
    .from(suiteRunEvents)
    .where(and(eq(suiteRunEvents.suiteRunId, suiteRunId), sql`${suiteRunEvents.seq} > ${afterSeq}`))
    .orderBy(asc(suiteRunEvents.seq))
    .limit(200)
  return rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    payload: row.payload ?? undefined,
    createdAt: row.createdAt.toISOString(),
  }))
}

async function resolvePublishedVersion(db: Db, suiteId: string, suiteVersionId?: string) {
  const { scenarioSuites, scenarioSuiteVersions } = schemaFor(db)
  const [suite] = await db.select().from(scenarioSuites).where(eq(scenarioSuites.id, suiteId)).limit(1)
  if (!suite || suite.deletedAt) throw notFound('SUITE_NOT_FOUND', '场景集不存在')
  if (suite.status === 'disabled') throw conflict('SUITE_DISABLED', '场景集已停用')
  const [version] = suiteVersionId
    ? await db.select().from(scenarioSuiteVersions).where(eq(scenarioSuiteVersions.id, suiteVersionId)).limit(1)
    : await db
        .select()
        .from(scenarioSuiteVersions)
        .where(eq(scenarioSuiteVersions.suiteId, suiteId))
        .orderBy(desc(scenarioSuiteVersions.versionNo))
        .limit(1)
  if (!version || version.suiteId !== suiteId) throw badRequest('SUITE_NOT_PUBLISHED', '场景集尚未发布，不能启动')
  return { suite, version, document: version.document }
}

export async function previewSuiteRun(
  db: Db,
  body: CreateSuiteRunBody,
  actorId?: string,
): Promise<SuiteRunPreviewResponse> {
  const input = createSuiteRunBodySchema.parse(body)
  const { suite, version, document } = await resolvePublishedVersion(db, input.suiteId, input.suiteVersionId)
  if (actorId) await assertTargetPermission(db, actorId, suite.targetId, 'run:execute')
  const deadlineAt = new Date(Date.now() + (input.deadlineMs ?? DEFAULT_SUITE_DEADLINE_MS))
  const issues: SuiteValidationIssue[] = await validateSuiteDocument(db, suite.targetId, {
    ...document,
    sharedInput: { ...document.sharedInput, ...input.sharedInput },
    defaultTargetAccountId: input.defaultTargetAccountId ?? document.defaultTargetAccountId,
    members: document.members.map((member) => ({
      ...member,
      input: { ...member.input, ...input.memberOverrides?.[member.memberId]?.input },
      targetAccountId: input.memberOverrides?.[member.memberId]?.targetAccountId ?? member.targetAccountId,
    })),
  })
  for (const memberId of Object.keys(input.memberOverrides ?? {})) {
    if (!document.members.some((member) => member.memberId === memberId)) {
      issues.push({ memberId, code: 'SUITE_MEMBER_NOT_FOUND', message: '运行覆盖引用了不存在的成员', severity: 'error' })
    }
  }
  const { scenarios } = schemaFor(db)
  const members = []
  for (const member of [...document.members].sort((a, b) => a.ordinal - b.ordinal)) {
    const override = input.memberOverrides?.[member.memberId]
    const effectiveInput = mergeSuiteMemberInput({
      sharedInput: { ...document.sharedInput, ...input.sharedInput },
      memberInput: member.input,
      runOverride: override?.input,
    })
    let targetAccountId: string | null = null
    try {
      targetAccountId = await resolveRunTargetAccountId(db, { targetId: suite.targetId, requestedAccountId: resolveSuiteMemberAccountId({
        runMemberAccountId: override?.targetAccountId,
        memberAccountId: member.targetAccountId,
        runDefaultAccountId: input.defaultTargetAccountId,
        suiteDefaultAccountId: document.defaultTargetAccountId,
      }) }) ?? null
    } catch (error) {
      issues.push({ memberId: member.memberId, code: 'RUN_ACCOUNT_REQUIRED', message: error instanceof Error ? error.message : '请选择目标账号', severity: 'error' })
    }
    const [scenario] = await db.select({ name: scenarios.name }).from(scenarios).where(eq(scenarios.id, member.scenarioId)).limit(1)
    const memberIssues = issues.filter((item) => item.memberId === member.memberId)
    members.push({
      memberId: member.memberId,
      ordinal: member.ordinal,
      displayName: member.displayName ?? scenario?.name ?? member.memberId,
      scenarioId: member.scenarioId,
      scenarioName: scenario?.name ?? member.memberId,
      scenarioVersionId: member.scenarioVersionId,
      effectiveInput,
      targetAccountId,
      issues: memberIssues,
      entryNavigationWarning: memberIssues.some((item) => item.code === 'ENTRY_NAVIGATION_WARNING'),
    })
  }
  return {
    suiteId: suite.id,
    suiteVersionId: version.id,
    targetId: suite.targetId,
    failurePolicy: document.failurePolicy,
    deadlineAt: deadlineAt.toISOString(),
    accountInterleaveHint: true,
    aiBudgetNotReserved: true,
    notificationNote: '每个子运行会按自身场景通知策略单独发送，集合不会合并成一条通知。',
    members,
    issues,
  }
}

export async function createSuiteRun(db: Db, body: CreateSuiteRunBody, actor: ExecutionActor) {
  const input = createSuiteRunBodySchema.parse(body)
  if (actor.kind === 'service') throw badRequest('SUITE_SERVICE_FORBIDDEN', '开放服务不能创建集合运行')
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actor.id)
    const { suiteRuns } = schemaFor(tx)
    const digest = sha256Hex(input)
    const [existing] = await tx.select().from(suiteRuns)
      .where(and(eq(suiteRuns.createdByConsoleAccountId, actor.id), eq(suiteRuns.idempotencyKey, input.idempotencyKey))).limit(1)
    if (existing) {
      await assertTargetPermission(tx, actor.id, existing.targetId, 'run:execute')
      if (existing.idempotencyDigest !== digest) throw conflict('SUITE_RUN_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的集合运行输入')
      return { observation: await getSuiteRunObservation(tx, existing.id), created: false }
    }
    return createSuiteRunTx(tx, input, actor, digest)
  })
}

async function createSuiteRunTx(db: Db, input: CreateSuiteRunBody, actor: ExecutionActor, digest: string) {
  await assertReportDeploymentReady(db, true)
  const preview = await previewSuiteRun(db, input, actor.id)
  if (preview.issues.some((item) => item.severity === 'error')) {
    throw badRequest('SUITE_VALIDATION_FAILED', '场景集运行预览未通过', preview.issues)
  }
  if (preview.members.length === 0 || preview.members.length > MAX_SUITE_MEMBERS) {
    throw badRequest('SUITE_MEMBER_LIMIT', `成员数须为 1–${MAX_SUITE_MEMBERS}`)
  }
  const { suite, version, document } = await resolvePublishedVersion(db, input.suiteId, preview.suiteVersionId)
  await lockReportDefaults(db, document.members.map((member) => member.scenarioId), [document.reportProfileId, ...document.members.map((member) => member.reportProfileId)].filter((id): id is string => !!id))
  await assertTargetPermission(db, actor.id, suite.targetId, 'run:execute')
  const now = new Date()
  const deadlineAt = new Date(now.getTime() + (input.deadlineMs ?? DEFAULT_SUITE_DEADLINE_MS))
  const reportDefaults = await resolveReportProfile(db, suite.targetId, document.reportProfileId)
  const snapshot = {
    suiteId: suite.id,
    suiteName: suite.name,
    suiteVersionId: version.id,
    document,
    sharedInput: input.sharedInput ?? {},
    defaultTargetAccountId: input.defaultTargetAccountId ?? document.defaultTargetAccountId ?? null,
    memberOverrides: input.memberOverrides ?? {},
    deadlineAt: deadlineAt.toISOString(),
    failurePolicy: document.failurePolicy,
    reportConfig: reportDefaults.config,
    reportConfigSource: reportDefaults.source,
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SUITE_SNAPSHOT_BYTES) {
    throw badRequest('SUITE_SNAPSHOT_TOO_LARGE', '集合快照超过上限')
  }

  const suiteRunId = newId()
  try {
    await atomic(db, async (tx) => {
      const { suiteRuns, suiteRunItems, runs, suiteReportTriggers } = schemaFor(tx)
      const [existing] = await tx
        .select()
        .from(suiteRuns)
        .where(and(eq(suiteRuns.createdByConsoleAccountId, actor.id), eq(suiteRuns.idempotencyKey, input.idempotencyKey)))
        .limit(1)
      if (existing) {
        if (existing.idempotencyDigest !== digest) throw conflict('SUITE_RUN_IDEMPOTENCY_CONFLICT', '相同幂等键对应不同的集合运行输入')
        return
      }
      await tx.insert(suiteRuns).values({
        id: suiteRunId,
        suiteId: suite.id,
        suiteVersionId: version.id,
        targetId: suite.targetId,
        createdByConsoleAccountId: actor.id,
        status: 'QUEUED',
        evidenceStatus: 'PENDING',
        failurePolicy: document.failurePolicy,
        deadlineAt,
        snapshot,
        snapshotDigest: sha256Hex(snapshot),
        idempotencyKey: input.idempotencyKey,
        idempotencyDigest: digest,
        createdAt: now,
        updatedAt: now,
      })
      if (document.autoGenerateFinalReport) await tx.insert(suiteReportTriggers).values({ suiteRunId, status: 'pending', createdAt: now, updatedAt: now })
      const created: { memberId: string; ordinal: number; runId: string; skip: string | null }[] = []
      let snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
      for (const member of preview.members) {
        const written = await writeRunWithSnapshot(tx, {
          scenarioId: member.scenarioId,
          scenarioVersionId: member.scenarioVersionId,
          targetAccountId: member.targetAccountId ?? undefined,
          input: member.effectiveInput,
          actor,
          deadlineAt,
          executionOrigin: 'suite_member',
          suiteRunId,
          suiteMemberId: member.memberId,
          reportDefaults: { profileId: document.members.find((entry) => entry.memberId === member.memberId)?.reportProfileId, displayName: member.displayName },
          suiteAdmission: {
            protocol: SUITE_ADMISSION_PROTOCOL,
            suiteRunId,
            memberId: member.memberId,
          },
        })
        const skip = deadlineAt.getTime() <= now.getTime() ? 'deadline_elapsed' : null
        const [child] = await tx.select({ snapshot: runs.snapshot, targetAccountId: runs.targetAccountId }).from(runs).where(eq(runs.id, written.runId))
        snapshotBytes += Buffer.byteLength(JSON.stringify(child!.snapshot), 'utf8')
        if (snapshotBytes > MAX_SUITE_SNAPSHOT_BYTES) throw badRequest('SUITE_SNAPSHOT_TOO_LARGE', '集合及子运行快照总量超过上限')
        created.push({ memberId: member.memberId, ordinal: member.ordinal, runId: written.runId, skip })
        await tx.insert(suiteRunItems).values({
          id: newId(),
          suiteRunId,
          memberId: member.memberId,
          ordinal: member.ordinal,
          groupId: document.members.find((item) => item.memberId === member.memberId)?.groupId ?? null,
          displayName: member.displayName,
          scenarioId: member.scenarioId,
          scenarioVersionId: member.scenarioVersionId,
          childRunId: written.runId,
          admissionStatus: skip ? 'SKIPPED' : 'PENDING',
          skipReason: skip,
          targetAccountId: child!.targetAccountId,
        })
        if (skip) {
          await requestRunCancel(tx, written.runId, actor)
        }
      }
      const first = created.find((item) => !item.skip)
      if (first) {
        await tx
          .update(suiteRunItems)
          .set({ admissionStatus: 'ACTIVE' })
          .where(and(eq(suiteRunItems.suiteRunId, suiteRunId), eq(suiteRunItems.memberId, first.memberId)))
        await tx
          .update(suiteRuns)
          .set({ status: 'RUNNING', startedAt: now, updatedAt: now })
          .where(eq(suiteRuns.id, suiteRunId))
      } else {
        await finalizeSuiteTx(tx, suiteRunId, now, 'deadline_elapsed')
      }
      await appendSuiteEvents(tx, suiteRunId, [
        { type: 'suite_run.created', payload: { status: first ? 'RUNNING' : 'COMPLETED' } },
        ...(first ? [{ type: 'suite_run.admitted', payload: { memberId: first.memberId } }] : []),
      ])
      await recordAudit(tx, actor, 'suite.run', 'suite_run', suiteRunId, `启动场景集「${suite.name}」`)
    })
  } catch (error) {
    rethrow(error)
  }
  const { suiteRuns } = schemaFor(db)
  const [row] = await db
    .select({ id: suiteRuns.id })
    .from(suiteRuns)
    .where(and(eq(suiteRuns.createdByConsoleAccountId, actor.id), eq(suiteRuns.idempotencyKey, input.idempotencyKey)))
    .limit(1)
  return { observation: await getSuiteRunObservation(db, row?.id ?? suiteRunId), created: row?.id === suiteRunId }
}

async function finalizeSuiteTx(tx: Db, suiteRunId: string, now: Date, reason?: string) {
  const observation = await loadObservationTx(tx, suiteRunId)
  const verdict = aggregateSuiteVerdict(
    observation.items.map((item) => ({
      admission: item.admission,
      runStatus: item.runStatus,
      outcomeStatus: item.outcomeStatus,
    })),
  )
  const cancelled = observation.cancelRequested
  const { suiteRuns } = schemaFor(tx)
  await tx
    .update(suiteRuns)
    .set({
      status: cancelled ? 'CANCELLED' : 'COMPLETED',
      verdict,
      evidenceStatus: evidenceOf(observation.items.map((item) => item.evidenceStatus)),
      reason: reason ?? observation.reason,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(suiteRuns.id, suiteRunId))
}

export async function advanceSuiteRun(db: Db, suiteRunId: string): Promise<SuiteRunObservation> {
  await atomic(db, async (tx) => {
    const { suiteRuns, suiteRunItems, runs, targets, scenarios, targetAccounts } = schemaFor(tx)
    const [parent] = await locked(tx, tx.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)))
    if (!parent) return
    const now = new Date()
    const rows = await tx
      .select({ item: suiteRunItems, child: runs })
      .from(suiteRunItems)
      .innerJoin(runs, eq(runs.id, suiteRunItems.childRunId))
      .where(eq(suiteRunItems.suiteRunId, suiteRunId))
      .orderBy(asc(suiteRunItems.ordinal))

    const evidenceStatus = evidenceOf(rows.map(({ child }) => child.evidenceStatus))
    // Evidence can settle after execution. Terminal parents must still converge.
    await tx.update(suiteRuns).set({ evidenceStatus, updatedAt: now }).where(eq(suiteRuns.id, suiteRunId))
    if (!OPEN_SUITE_STATUSES.includes(parent.status)) {
      if (evidenceStatus !== parent.evidenceStatus) await appendSuiteEvents(tx, suiteRunId, [{ type: 'suite_run.evidence_changed', payload: { evidenceStatus } }])
      return
    }

    const expired = parent.deadlineAt.getTime() <= now.getTime()
    if (expired && !parent.cancelRequestedAt) {
      parent.cancelRequestedAt = now
      await tx.update(suiteRuns).set({ cancelRequestedAt: now, reason: 'deadline_elapsed' }).where(eq(suiteRuns.id, suiteRunId))
    }
    if (parent.cancelRequestedAt) {
      for (const { item, child } of rows) {
        if (item.admissionStatus === 'ACTIVE' && !CHILD_TERMINAL.has(child.status)) {
          const cancelled = await requestRunCancel(tx, child.id, { kind: 'console', id: parent.createdByConsoleAccountId })
          child.status = cancelled.status
          child.evidenceStatus = cancelled.evidenceStatus
        }
      }
    }

    const events: { type: string; payload?: Record<string, JsonValue> }[] = []
    let review = false
    let waiting = false
    for (const { item, child } of rows) {
      if (item.admissionStatus === 'ACTIVE' && CHILD_TERMINAL.has(child.status)) {
        await tx
          .update(suiteRunItems)
          .set({ admissionStatus: 'SETTLED' })
          .where(eq(suiteRunItems.id, item.id))
        item.admissionStatus = 'SETTLED'
        events.push({ type: 'suite_run.settled', payload: { memberId: item.memberId, runStatus: child.status } })
      }
      if (item.admissionStatus === 'ACTIVE' && child.status === 'NEEDS_REVIEW') review = true
      if (item.admissionStatus === 'ACTIVE' && ['WAITING_FOR_AUTH', 'RECOVERING', 'HOLDING'].includes(child.status)) waiting = true
    }

    const stopFailed =
      parent.failurePolicy === 'stop' &&
      rows.some(
        ({ item, child }) =>
          item.admissionStatus === 'SETTLED' && (child.status === 'FAILED' || child.status === 'CANCELLED' || child.outcomeStatus === 'FAIL'),
      )
    const cancel = parent.cancelRequestedAt != null
    for (const { item } of rows) {
      if (item.admissionStatus !== 'PENDING') continue
      if (cancel || stopFailed || parent.deadlineAt.getTime() <= now.getTime()) {
        const reason = expired ? 'deadline_elapsed' : cancel ? 'suite_cancelled' : 'failure_policy_stop'
        await tx
          .update(suiteRunItems)
          .set({ admissionStatus: 'SKIPPED', skipReason: reason })
          .where(eq(suiteRunItems.id, item.id))
        item.admissionStatus = 'SKIPPED'
        events.push({ type: 'suite_run.skipped', payload: { memberId: item.memberId, reason } })
        const childId = item.childRunId
        await requestRunCancel(tx, childId, { kind: 'console', id: parent.createdByConsoleAccountId })
      }
    }

    const refreshed = await tx.select().from(suiteRunItems).where(eq(suiteRunItems.suiteRunId, suiteRunId))
    const hasActive = refreshed.some((item) => item.admissionStatus === 'ACTIVE')
    const next = refreshed
      .filter((item) => item.admissionStatus === 'PENDING')
      .sort((a, b) => a.ordinal - b.ordinal)[0]
    let admissionFailure: string | undefined
    if (!hasActive && !review && next && !cancel) {
      try { await assertTargetPermission(tx, parent.createdByConsoleAccountId, parent.targetId, 'run:execute') }
      catch (error) {
        if (!(error instanceof DomainError)) throw error
        admissionFailure = 'authorization_changed'
      }
      const [target] = await tx.select().from(targets).where(eq(targets.id, parent.targetId)).limit(1)
      const [scenario] = await tx.select().from(scenarios).where(eq(scenarios.id, next.scenarioId)).limit(1)
      if (!target || target.deletedAt || target.status !== 'active') admissionFailure = 'target_unavailable'
      if (!scenario || scenario.deletedAt || scenario.status !== 'active') admissionFailure = 'scenario_unavailable'
      if (next.targetAccountId) {
        const [account] = await tx.select().from(targetAccounts).where(eq(targetAccounts.id, next.targetAccountId)).limit(1)
        if (!account || account.deletedAt || account.status !== 'active') admissionFailure = 'account_unavailable'
      }
      if (admissionFailure) {
        for (const item of refreshed.filter((item) => item.admissionStatus === 'PENDING')) {
          await tx.update(suiteRunItems).set({ admissionStatus: 'SKIPPED', skipReason: admissionFailure }).where(eq(suiteRunItems.id, item.id))
          await requestRunCancel(tx, item.childRunId, { kind: 'console', id: parent.createdByConsoleAccountId })
          events.push({ type: 'suite_run.skipped', payload: { memberId: item.memberId, reason: admissionFailure } })
        }
      } else {
        const nextChild = rows.find((row) => row.item.id === next.id)!.child
        if (CHILD_TERMINAL.has(nextChild.status)) {
          await tx.update(suiteRunItems).set({ admissionStatus: 'SKIPPED', skipReason: 'member_already_ended' }).where(eq(suiteRunItems.id, next.id))
          events.push({ type: 'suite_run.skipped', payload: { memberId: next.memberId, reason: 'member_already_ended' } })
        } else {
          await tx.update(suiteRunItems).set({ admissionStatus: 'ACTIVE' }).where(eq(suiteRunItems.id, next.id))
          events.push({ type: 'suite_run.admitted', payload: { memberId: next.memberId } })
        }
      }
    }

    const after = await tx.select().from(suiteRunItems).where(eq(suiteRunItems.suiteRunId, suiteRunId))
    const remaining = after.some((item) => item.admissionStatus === 'PENDING' || item.admissionStatus === 'ACTIVE')
    let status: SuiteRunStatus = parent.status
    if (!remaining) {
      await finalizeSuiteTx(tx, suiteRunId, now)
      status = cancel ? 'CANCELLED' : 'COMPLETED'
      if (admissionFailure) {
        status = 'FAILED'
        await tx.update(suiteRuns).set({ status, reason: admissionFailure }).where(eq(suiteRuns.id, suiteRunId))
      }
      events.push({ type: 'suite_run.finished', payload: { status } })
    } else if (review) {
      status = 'NEEDS_REVIEW'
    } else if (waiting) {
      status = 'WAITING'
    } else {
      status = 'RUNNING'
    }
    if (status !== parent.status && remaining) {
      await tx
        .update(suiteRuns)
        .set({
          status,
          startedAt: parent.startedAt ?? now,
          updatedAt: now,
          evidenceStatus: evidenceOf(
            rows.map((row) => row.child.evidenceStatus),
          ),
        })
        .where(eq(suiteRuns.id, suiteRunId))
      events.push({ type: 'suite_run.status_changed', payload: { status } })
    }
    await appendSuiteEvents(tx, suiteRunId, events)
  })
  return loadObservationTx(db, suiteRunId)
}

export async function cancelSuiteRun(db: Db, suiteRunId: string, actor: ExecutionActor) {
  await atomic(db, async (tx) => {
    const { suiteRuns } = schemaFor(tx)
    const [parent] = await locked(tx, tx.select().from(suiteRuns).where(eq(suiteRuns.id, suiteRunId)))
    if (!parent) throw notFound('SUITE_RUN_NOT_FOUND', '集合运行不存在')
    await assertTargetPermission(tx, actor.id, parent.targetId, 'run:cancel')
    if (!OPEN_SUITE_STATUSES.includes(parent.status)) return
    const now = new Date()
    await tx
      .update(suiteRuns)
      .set({ cancelRequestedAt: parent.cancelRequestedAt ?? now, updatedAt: now })
      .where(eq(suiteRuns.id, suiteRunId))
    await appendSuiteEvents(tx, suiteRunId, [{ type: 'suite_run.cancel_requested' }])
    await recordAudit(tx, actor, 'suite.cancel', 'suite_run', suiteRunId, '取消集合运行')
  })
  return advanceSuiteRun(db, suiteRunId)
}

export async function advanceDueSuiteRuns(db: Db, limit = 16): Promise<number> {
  const { suiteRuns, suiteRunItems, runs } = schemaFor(db)
  const due = await db
    .select({ id: suiteRuns.id })
    .from(suiteRuns)
    .where(or(inArray(suiteRuns.status, OPEN_SUITE_STATUSES), eq(suiteRuns.evidenceStatus, 'PENDING')))
    .orderBy(asc(suiteRuns.updatedAt))
    .limit(limit)
  const settledActive = await db
    .select({ id: suiteRuns.id })
    .from(suiteRunItems)
    .innerJoin(runs, eq(runs.id, suiteRunItems.childRunId))
    .innerJoin(suiteRuns, eq(suiteRuns.id, suiteRunItems.suiteRunId))
    .where(and(eq(suiteRunItems.admissionStatus, 'ACTIVE'), inArray(runs.status, ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW', 'WAITING_FOR_AUTH'])))
    .limit(limit)
  const ids = [...new Set([...due.map((row) => row.id), ...settledActive.map((row) => row.id)])]
  let advanced = 0
  for (const id of ids) {
    try {
      await advanceSuiteRun(db, id)
      advanced += 1
    } catch (error) {
      console.error('[suites] advanceDueSuiteRuns failed', id, error)
    }
  }
  return advanced
}

export async function scheduleSuiteAdvanceForChild(db: Db, runId: string) {
  const { runs } = schemaFor(db)
  const [row] = await db.select({ suiteRunId: runs.suiteRunId }).from(runs).where(eq(runs.id, runId)).limit(1)
  if (!row?.suiteRunId) return
  const suiteRunId = row.suiteRunId
  if (inTransaction(db)) {
    // The durable sweeper will advance after commit. A transaction handle must
    // never escape into an after-commit callback (nor recursively lock the parent).
    return
  }
  await advanceSuiteRun(db, suiteRunId)
}

export function emptySuiteDocumentMembers(_document: SuiteDocument) {
  return undefined
}
