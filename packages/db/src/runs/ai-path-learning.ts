import { and, asc, desc, eq, gt, gte, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  AI_PATH_INSIGHT_MAX_ROWS,
  AI_PATH_INSIGHT_MIN_SAMPLES,
  BROWSER_AI_SDK_VERSION,
  aiTaskEventSchema,
  computeAiPathSignature,
  computeNamespaceDigest,
  computeStepDefinitionDigest,
  evaluateSolidifiableLevel,
  MAX_AI_TASK_EVENTS_PER_ATTEMPT,
  type AiElementBinding,
  type AiPageObservation,
  type AiPathObservation,
  type AiTaskEvent,
  type AiTaskEventPhase,
  type AiValueProvenance,
  type JsonValue,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
  type SolidifiableLevel,
  type Step,
  type TraceIntegrityState,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { atomic, insertIgnoreRows, schemaFor } from '../native.js'
import { lockRunRow, verifyRunLeaseForWrite } from '../leases/leases.js'
import { verifySessionLeaseForCommit } from '../sessions/sessions.js'
import { newId } from '../id.js'
import { notFound } from './errors.js'

/** 用 z.input：带 .default() 的字段（writeSignalCount 等）在调用方可省略。 */
export type AppendAiTaskEventInput = Omit<z.input<typeof aiTaskEventSchema>, 'id' | 'timestamp'> & {
  grant: RunGrant
  sessionLease?: SessionGrant & { holderWorkerId: string }
}

/**
 * 追加一条 AI 动作事实。prepared 在动作派发前调用：租约校验失败即抛错，
 * 调用方不得派发动作。上限按动作序号计（同一动作的 prepared/completed 不重复计数），
 * 达到上限返回 limited，动作不受影响。
 */
export async function appendAiTaskEvent(
  db: Db,
  input: AppendAiTaskEventInput,
): Promise<{ ok: true; eventId: string } | { ok: true; limited: true }> {
  const { grant: _grant, sessionLease: _sessionLease, ...eventInput } = input
  const parsed = aiTaskEventSchema.safeParse({ ...eventInput, timestamp: new Date().toISOString() })
  if (!parsed.success) {
    throw Object.assign(new Error(`AI 动作事实不符合契约：${parsed.error.issues[0]?.message}`), {
      code: 'AI_TASK_EVENT_INVALID',
    })
  }
  const event = parsed.data
  return atomic(db, async (tx) => {
    const run = await lockRunRow(tx as unknown as Db, event.runId)
    if (!run || run.status !== 'RUNNING') {
      throw Object.assign(new Error('运行不可写或已终止'), { code: 'RUN_NOT_WRITABLE' })
    }
    if (!(await verifyRunLeaseForWrite(tx as unknown as Db, input.grant))) {
      throw Object.assign(new Error('Run 租约已失效'), { code: 'RUN_LEASE_LOST' })
    }
    if (input.sessionLease) {
      const held = await verifySessionLeaseForCommit(tx, input.sessionLease)
      if (!held) {
        throw Object.assign(new Error('Session 租约已失效'), { code: 'SESSION_LEASE_LOST' })
      }
    }

    const { aiTaskEvents: table } = schemaFor(tx as unknown as Db)

    // 上限按动作（agentInstanceId + ordinal）计，不按事件行计
    const [countResult] = await tx
      .select({
        count: sql<number>`count(distinct (${table.agentInstanceId}, ${table.ordinal}))`,
      })
      .from(table)
      .where(eq(table.attemptId, event.attemptId))
    if (Number(countResult?.count ?? 0) >= MAX_AI_TASK_EVENTS_PER_ATTEMPT) {
      return { ok: true as const, limited: true as const }
    }

    const eventId = newId()
    await insertIgnoreRows(tx as unknown as Db, table, {
      id: eventId,
      attemptId: event.attemptId,
      runId: event.runId,
      stepRunId: event.stepRunId,
      agentInstanceId: event.agentInstanceId,
      ordinal: event.ordinal,
      phase: event.phase,
      source: event.source,
      actionName: event.actionName,
      sdkVersion: event.sdkVersion,
      elementDescription: event.elementDescription ?? null,
      bindingJson: event.binding,
      valueProvenanceJson: event.valueProvenance,
      paramsSummaryJson: event.paramsSummary ?? null,
      pageBeforeJson: event.pageBefore,
      pageAfterJson: event.pageAfter ?? null,
      writeSignalCount: event.writeSignalCount ?? 0,
      writeSignalPathsJson: event.writeSignalPaths ?? [],
      durationMs: event.durationMs ?? null,
      errorCode: event.errorCode ?? null,
      createdAt: new Date(),
    })

    return { ok: true as const, eventId }
  })
}

export type SettleAiActionTraceInput = {
  attemptId: string
  runId: string
  stepRunId: string
  step: Step
  snapshot: RunSnapshot
  stepResult: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN'
  errorCode?: string | null
  /** 提供时校验 Run 租约；回收路径在同一恢复事务内调用，可省略。 */
  grant?: RunGrant
}

function rowToEvent(r: Awaited<ReturnType<typeof selectEvents>>[number]): AiTaskEvent {
  return {
    id: r.id,
    attemptId: r.attemptId,
    runId: r.runId,
    stepRunId: r.stepRunId,
    agentInstanceId: r.agentInstanceId,
    ordinal: r.ordinal,
    phase: r.phase as AiTaskEventPhase,
    source: 'action_edge',
    actionName: r.actionName,
    sdkVersion: r.sdkVersion,
    elementDescription: r.elementDescription,
    binding: r.bindingJson as AiElementBinding,
    valueProvenance: r.valueProvenanceJson as AiValueProvenance,
    paramsSummary: r.paramsSummaryJson as Record<string, JsonValue> | null,
    pageBefore: r.pageBeforeJson as AiPageObservation,
    pageAfter: (r.pageAfterJson as AiPageObservation | null) ?? undefined,
    writeSignalCount: r.writeSignalCount,
    writeSignalPaths: r.writeSignalPathsJson as string[],
    durationMs: r.durationMs,
    errorCode: r.errorCode,
    timestamp: r.createdAt.toISOString(),
  }
}

async function selectEvents(db: Db, attemptId: string) {
  const { aiTaskEvents: table } = schemaFor(db)
  return db
    .select()
    .from(table)
    .where(eq(table.attemptId, attemptId))
    .orderBy(asc(table.ordinal), asc(table.createdAt))
}

/**
 * 收尾 AI 动作轨迹：把仍为 prepared 的事件记为 interrupted / unknown，并计算本 Attempt
 * 的路径观察。重复提交幂等（观察行按 attemptId 主键 insertIgnore）。
 */
export async function settleAiActionTrace(
  db: Db,
  input: SettleAiActionTraceInput,
): Promise<{ ok: true; observation: AiPathObservation | null }> {
  return atomic(db, async (tx) => settleAiActionTraceTx(tx as unknown as Db, input))
}

/** 事务内版本：回收路径在自己的恢复事务里调用，与状态迁移同生共死。 */
export async function settleAiActionTraceTx(
  tx: Db,
  input: SettleAiActionTraceInput,
): Promise<{ ok: true; observation: AiPathObservation | null }> {
  if (input.grant) {
    if (!(await verifyRunLeaseForWrite(tx, input.grant))) {
      throw Object.assign(new Error('Run 租约已失效，拒绝提交 AI 轨迹收尾'), { code: 'RUN_LEASE_LOST' })
    }
  }

  const {
    aiTaskEvents: eventsTable,
    aiPathObservations: obsTable,
    scenarioAiCalls: callsTable,
  } = schemaFor(tx)

  const rawRows = await selectEvents(tx, input.attemptId)
  if (rawRows.length === 0) {
    return { ok: true, observation: null }
  }

  // 没有终态事件的 prepared 动作收尾为 interrupted（取消/超时/丢租）或 unknown（其余，含崩溃）
  const ordinalsWithTerminal = new Set<number>()
  for (const r of rawRows) {
    if (r.phase !== 'prepared') ordinalsWithTerminal.add(r.ordinal)
  }
  const unfinalized = rawRows.filter((r) => r.phase === 'prepared' && !ordinalsWithTerminal.has(r.ordinal))
  if (unfinalized.length > 0) {
    const terminalPhase: AiTaskEventPhase =
      input.stepResult === 'CANCELLED' ||
      input.errorCode === 'TIMEOUT' ||
      input.errorCode === 'SESSION_LEASE_LOST'
        ? 'interrupted'
        : 'unknown'
    for (const item of unfinalized) {
      await insertIgnoreRows(tx, eventsTable, {
        id: newId(),
        attemptId: item.attemptId,
        runId: item.runId,
        stepRunId: item.stepRunId,
        agentInstanceId: item.agentInstanceId,
        ordinal: item.ordinal,
        phase: terminalPhase,
        source: item.source,
        actionName: item.actionName,
        sdkVersion: item.sdkVersion,
        elementDescription: item.elementDescription,
        bindingJson: item.bindingJson,
        valueProvenanceJson: item.valueProvenanceJson,
        paramsSummaryJson: item.paramsSummaryJson,
        pageBeforeJson: item.pageBeforeJson,
        pageAfterJson: null,
        writeSignalCount: 0,
        writeSignalPathsJson: [],
        durationMs: null,
        errorCode: input.errorCode ?? terminalPhase,
        createdAt: new Date(),
      })
    }
  }

  const finalRows = await selectEvents(tx, input.attemptId)
  const aiEvents = finalRows.map(rowToEvent)

  const distinctActions = new Set(aiEvents.map((e) => `${e.agentInstanceId}:${e.ordinal}`))
  const reachedLimit = distinctActions.size >= MAX_AI_TASK_EVENTS_PER_ATTEMPT
  const hasInterruptedOrUnknown = aiEvents.some((e) => e.phase === 'interrupted' || e.phase === 'unknown')
  const traceIntegrity: TraceIntegrityState =
    reachedLimit || hasInterruptedOrUnknown ? 'partial' : 'complete'

  const stepDefinitionDigest = computeStepDefinitionDigest(input.step)
  const sdkVersion = aiEvents[0]?.sdkVersion ?? BROWSER_AI_SDK_VERSION
  const namespaceDigest = computeNamespaceDigest({
    targetId: input.snapshot.targetId,
    targetAccountId: input.snapshot.targetAccountId ?? null,
    scenarioId: input.snapshot.scenarioId,
    stepId: input.step.id,
    stepDefinitionDigest,
    sdkVersion,
    modelName: input.snapshot.aiExecution?.modelName ?? 'unknown',
    modelFamily: input.snapshot.aiExecution?.modelFamily ?? 'unknown',
  })

  const signature = computeAiPathSignature(aiEvents)
  const solidifiable = evaluateSolidifiableLevel(aiEvents, input.stepResult, traceIntegrity)

  const callRows = await tx
    .select({
      inputTokens: sql<number>`coalesce(sum(${callsTable.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${callsTable.outputTokens}), 0)`,
      durationMs: sql<number>`coalesce(sum(${callsTable.durationMs}), 0)`,
      calls: sql<number>`count(*)`,
    })
    .from(callsTable)
    .where(eq(callsTable.attemptId, input.attemptId))

  const observation: AiPathObservation = {
    attemptId: input.attemptId,
    runId: input.runId,
    stepRunId: input.stepRunId,
    stepId: input.step.id,
    scenarioId: input.snapshot.scenarioId,
    scenarioVersion: null,
    targetId: input.snapshot.targetId,
    targetAccountId: input.snapshot.targetAccountId ?? null,
    stepDefinitionDigest,
    namespaceDigest,
    signature,
    actionCount: aiEvents.filter((e) => e.phase === 'completed' || e.phase === 'failed').length,
    solidifiableLevel: solidifiable.level,
    solidifiableReasons: solidifiable.reasons,
    traceIntegrity,
    modelCalls: Number(callRows[0]?.calls ?? 0),
    inputTokens: Number(callRows[0]?.inputTokens ?? 0),
    outputTokens: Number(callRows[0]?.outputTokens ?? 0),
    durationMs: Number(callRows[0]?.durationMs ?? 0),
    stepResult: input.stepResult,
    recordedAt: new Date().toISOString(),
  }

  await insertIgnoreRows(tx, obsTable, {
    attemptId: observation.attemptId,
    runId: observation.runId,
    stepRunId: observation.stepRunId,
    stepId: observation.stepId,
    scenarioId: observation.scenarioId,
    scenarioVersion: observation.scenarioVersion,
    targetId: observation.targetId,
    targetAccountId: observation.targetAccountId,
    stepDefinitionDigest: observation.stepDefinitionDigest,
    namespaceDigest: observation.namespaceDigest,
    signature: observation.signature,
    actionCount: observation.actionCount,
    solidifiableLevel: observation.solidifiableLevel,
    solidifiableReasonsJson: observation.solidifiableReasons,
    traceIntegrity: observation.traceIntegrity,
    modelCalls: observation.modelCalls,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    durationMs: observation.durationMs,
    stepResult: observation.stepResult,
    recordedAt: new Date(observation.recordedAt),
  })

  return { ok: true, observation }
}

export type ListAiTaskEventsInput = {
  runId?: string
  attemptId: string
  limit?: number
  /** 上一页返回的 nextCursor；语义为「该序号（含）之前已读」，下一页从其后开始。 */
  cursorOrdinal?: number
}

export async function listAiTaskEvents(
  db: Db,
  arg1: string | ListAiTaskEventsInput,
  arg2?: { limit?: number; cursorOrdinal?: number },
): Promise<{ events: AiTaskEvent[]; nextCursor?: number; observation?: AiPathObservation | null }> {
  const attemptId = typeof arg1 === 'string' ? arg1 : arg1.attemptId
  const runId = typeof arg1 === 'object' ? arg1.runId : undefined
  const opts = typeof arg1 === 'object' ? arg1 : arg2 ?? {}
  const { aiTaskEvents: table, aiPathObservations: obsTable, runs } = schemaFor(db)

  if (runId) {
    const [run] = await db
      .select({ id: runs.id, deletedAt: runs.deletedAt })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
    if (!run || run.deletedAt) throw notFound('RUN_NOT_FOUND', '运行不存在')
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)

  const whereConditions = [eq(table.attemptId, attemptId)]
  if (runId) {
    whereConditions.push(eq(table.runId, runId))
  }
  if (opts.cursorOrdinal !== undefined) {
    whereConditions.push(gt(table.ordinal, opts.cursorOrdinal))
  }

  const rows = await db
    .select()
    .from(table)
    .where(and(...whereConditions))
    .orderBy(asc(table.ordinal), asc(table.createdAt))
    .limit(limit * 2 + 1)

  // 页按完整动作序号切：多读一些行，再把跨界序号整组留下或整组推到下一页，避免同一动作拆页重复。
  const ordinals = [...new Set(rows.map((r) => r.ordinal))]
  let pageOrdinals = ordinals.slice(0, limit)
  let nextCursor: number | undefined
  if (ordinals.length > pageOrdinals.length) {
    nextCursor = pageOrdinals[pageOrdinals.length - 1]
  }
  const pageOrdinalSet = new Set(pageOrdinals)
  const sliced = rows.filter((r) => pageOrdinalSet.has(r.ordinal))

  let observation: AiPathObservation | null = null
  const obsConditions = [eq(obsTable.attemptId, attemptId)]
  if (runId) {
    obsConditions.push(eq(obsTable.runId, runId))
  }
  const [obsRow] = await db
    .select()
    .from(obsTable)
    .where(and(...obsConditions))
    .limit(1)

  if (obsRow) {
    observation = {
      attemptId: obsRow.attemptId,
      runId: obsRow.runId,
      stepRunId: obsRow.stepRunId,
      stepId: obsRow.stepId,
      scenarioId: obsRow.scenarioId,
      scenarioVersion: obsRow.scenarioVersion,
      targetId: obsRow.targetId,
      targetAccountId: obsRow.targetAccountId,
      stepDefinitionDigest: obsRow.stepDefinitionDigest,
      namespaceDigest: obsRow.namespaceDigest,
      signature: obsRow.signature,
      actionCount: obsRow.actionCount,
      solidifiableLevel: obsRow.solidifiableLevel as SolidifiableLevel,
      solidifiableReasons: obsRow.solidifiableReasonsJson as string[],
      traceIntegrity: obsRow.traceIntegrity as TraceIntegrityState,
      modelCalls: obsRow.modelCalls,
      inputTokens: obsRow.inputTokens,
      outputTokens: obsRow.outputTokens,
      durationMs: obsRow.durationMs,
      stepResult: obsRow.stepResult as AiPathObservation['stepResult'],
      recordedAt: obsRow.recordedAt.toISOString(),
    }
  }

  return {
    events: sliced.map(rowToEvent),
    nextCursor,
    observation,
  }
}

export type StepAiPathInsight = {
  stepId: string
  attemptsCount: number
  successRate: number
  topSignatureRatio: number
  solidifiableLevelDistribution: Record<SolidifiableLevel, number>
  medianCalls: number
  medianTokens: number
  medianDurationMs: number
  insufficientData: boolean
  latestEligibleAttempt: {
    attemptId: string
    runId: string
    signature: string | null
    solidifiableLevel: SolidifiableLevel
    recordedAt: string
  } | null
}

/**
 * 路径洞察：从路径观察、调用账本与 Attempt 终态实时重算的只读投影。
 * 成功率以 attempts 表的最终状态为准（AI 端口收尾后的认证失败、范围检查失败
 * 不再把观察误记成成功）；行数有界，不新增后台作业或评分表。
 */
export async function queryAiPathInsights(
  db: Db,
  scenarioId: string,
  options: { windowDays?: number } = {},
): Promise<StepAiPathInsight[]> {
  const { aiPathObservations: table, scenarios, runs, attempts } = schemaFor(db)
  const [scenario] = await db
    .select({ id: scenarios.id, deletedAt: scenarios.deletedAt })
    .from(scenarios)
    .where(eq(scenarios.id, scenarioId))
    .limit(1)
  if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

  const windowDays = Math.min(Math.max(options.windowDays ?? 30, 1), 90)
  const cutoff = new Date(Date.now() - windowDays * 24 * 3600 * 1000)

  const rows = await db
    .select({
      attemptId: table.attemptId,
      runId: table.runId,
      stepRunId: table.stepRunId,
      stepId: table.stepId,
      namespaceDigest: table.namespaceDigest,
      signature: table.signature,
      solidifiableLevel: table.solidifiableLevel,
      traceIntegrity: table.traceIntegrity,
      modelCalls: table.modelCalls,
      inputTokens: table.inputTokens,
      outputTokens: table.outputTokens,
      durationMs: table.durationMs,
      recordedAt: table.recordedAt,
      attemptStatus: attempts.status,
    })
    .from(table)
    .innerJoin(runs, eq(runs.id, table.runId))
    .innerJoin(attempts, eq(attempts.id, table.attemptId))
    .where(
      and(
        eq(table.scenarioId, scenarioId),
        gte(table.recordedAt, cutoff),
        isNull(runs.deletedAt),
      ),
    )
    .orderBy(desc(table.recordedAt))
    .limit(AI_PATH_INSIGHT_MAX_ROWS)

  const byStep = new Map<string, typeof rows>()
  for (const r of rows) {
    const list = byStep.get(r.stepId) ?? []
    list.push(r)
    byStep.set(r.stepId, list)
  }

  const results: StepAiPathInsight[] = []
  for (const [stepId, stepRows] of byStep.entries()) {
    const total = stepRows.length
    if (total === 0) continue

    const succeededRows = stepRows.filter((r) => r.attemptStatus === 'SUCCEEDED')
    const successRate = succeededRows.length / total

    const sigCounts = new Map<string, number>()
    for (const r of succeededRows) {
      if (r.signature) {
        sigCounts.set(r.signature, (sigCounts.get(r.signature) ?? 0) + 1)
      }
    }
    let topSigCount = 0
    for (const count of sigCounts.values()) {
      if (count > topSigCount) topSigCount = count
    }
    const topSignatureRatio = succeededRows.length > 0 ? topSigCount / succeededRows.length : 0

    const solidifiableDistribution: Record<SolidifiableLevel, number> = {
      full: 0,
      partial: 0,
      blocked: 0,
    }
    for (const r of stepRows) {
      const lvl = r.solidifiableLevel as SolidifiableLevel
      if (solidifiableDistribution[lvl] !== undefined) {
        solidifiableDistribution[lvl] += 1
      }
    }

    const median = (arr: number[]) => (arr.length > 0 ? arr[Math.floor(arr.length / 2)]! : 0)
    const calls = stepRows.map((r) => r.modelCalls).sort((a, b) => a - b)
    const tokens = stepRows.map((r) => r.inputTokens + r.outputTokens).sort((a, b) => a - b)
    const durations = stepRows.map((r) => r.durationMs).sort((a, b) => a - b)

    // 最近一次可作为固化来源的 Attempt：Attempt 终态成功、轨迹完整、可固化等级不是 blocked
    const eligible = stepRows.find(
      (r) =>
        r.attemptStatus === 'SUCCEEDED' &&
        r.traceIntegrity === 'complete' &&
        r.solidifiableLevel !== 'blocked',
    )

    results.push({
      stepId,
      attemptsCount: total,
      successRate,
      topSignatureRatio,
      solidifiableLevelDistribution: solidifiableDistribution,
      medianCalls: median(calls),
      medianTokens: median(tokens),
      medianDurationMs: median(durations),
      insufficientData: total < AI_PATH_INSIGHT_MIN_SAMPLES,
      latestEligibleAttempt: eligible
        ? {
            attemptId: eligible.attemptId,
            runId: eligible.runId,
            signature: eligible.signature,
            solidifiableLevel: eligible.solidifiableLevel as SolidifiableLevel,
            recordedAt: eligible.recordedAt.toISOString(),
          }
        : null,
    })
  }

  return results
}
