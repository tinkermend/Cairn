import { and, eq, gt, isNull, sql } from 'drizzle-orm'
import {
  canonicalJson,
  resolutionDecisionListQuerySchema,
  resolutionDecisionListResponseSchema,
  resolutionDecisionSchema,
  resolutionStatsQuerySchema,
  resolutionStatsResponseSchema,
  type ResolutionDecision,
  type ResolutionDecisionListQuery,
  type ResolutionStatsQuery,
  type RunGrant,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { verifyRunLeaseForWrite } from '../leases/leases.js'
import { atomic, insertRows, locked, schemaFor } from '../native.js'
import { conflict, notFound } from '../runs/errors.js'

function staleOwner(message = '解析决策的运行所有权已失效'): never {
  throw conflict('RESOLUTION_FACT_STALE_OWNER', message)
}

function targetMismatch(message = '解析决策不属于该运行'): never {
  throw conflict('RESOLUTION_TARGET_MISMATCH', message)
}

export async function appendResolutionDecision(
  db: Db,
  input: { grant: RunGrant; decision: ResolutionDecision },
): Promise<ResolutionDecision> {
  const decision = resolutionDecisionSchema.parse(input.decision)
  return atomic(db, async (tx) => {
    const { attempts, resolutionDecisions, runs, stepRuns, runLeases } = schemaFor(tx)
    const [run] = await locked(tx, tx.select().from(runs).where(eq(runs.id, decision.runId)))
    if (!run) targetMismatch('运行不存在')
    await locked(tx, tx.select().from(runLeases).where(eq(runLeases.id, input.grant.leaseId)))
    if (input.grant.runId !== decision.runId || !(await verifyRunLeaseForWrite(tx, input.grant))) staleOwner()
    const [stepRun] = await tx.select().from(stepRuns).where(eq(stepRuns.id, decision.stepRunId)).limit(1)
    if (!stepRun || stepRun.runId !== decision.runId) targetMismatch('步骤运行不属于该 Run')
    if (stepRun.stepId !== decision.stepId) targetMismatch('步骤标识与步骤运行不一致')
    const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, decision.attemptId)).limit(1)
    if (!attempt || attempt.stepRunId !== decision.stepRunId) targetMismatch('Attempt 不属于该步骤')
    const [existing] = await tx
      .select()
      .from(resolutionDecisions)
      .where(eq(resolutionDecisions.attemptId, decision.attemptId))
      .limit(1)
    if (existing) {
      const previous = resolutionDecisionSchema.parse(existing.payloadJson)
      const { decisionId: _oldId, createdAt: _oldAt, ...old } = previous
      const { decisionId: _newId, createdAt: _newAt, ...next } = decision
      if (canonicalJson(old) !== canonicalJson(next)) {
        throw conflict('RESOLUTION_IDEMPOTENCY_CONFLICT', '同一 Attempt 已有不同的解析决策')
      }
      return previous
    }
    if (run.deletedAt || run.cancelRequestedAt || run.status !== 'RUNNING' || attempt.status !== 'RUNNING') {
      staleOwner()
    }
    await insertRows(tx, resolutionDecisions, {
      id: decision.decisionId,
      runId: decision.runId,
      stepRunId: decision.stepRunId,
      attemptId: decision.attemptId,
      stepId: decision.stepId,
      effectivePolicy: decision.effectivePolicy,
      decisionKind: decision.decision,
      reasonCode: decision.reasonCode,
      semanticDigest: decision.semanticDigest,
      rungsJson: decision.rungs,
      evidenceRefs: decision.evidenceRefs,
      payloadJson: decision,
    })
    return decision
  })
}

export async function listResolutionDecisions(db: Db, runId: string, query: ResolutionDecisionListQuery) {
  const parsed = resolutionDecisionListQuerySchema.parse(query)
  const { resolutionDecisions, runs } = schemaFor(db)
  const [run] = await db
    .select({ id: runs.id, deletedAt: runs.deletedAt })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  if (!run || run.deletedAt) throw notFound('RUN_NOT_FOUND', '运行不存在')
  const filter = and(
    eq(resolutionDecisions.runId, runId),
    parsed.stepRunId ? eq(resolutionDecisions.stepRunId, parsed.stepRunId) : undefined,
    parsed.attemptId ? eq(resolutionDecisions.attemptId, parsed.attemptId) : undefined,
  )
  const [after] = parsed.cursor
    ? await db.select().from(resolutionDecisions).where(and(filter, eq(resolutionDecisions.id, parsed.cursor))).limit(1)
    : []
  if (parsed.cursor && !after) targetMismatch('决策游标不属于当前查询')
  const page = await db
    .select()
    .from(resolutionDecisions)
    .where(and(filter, after ? gt(resolutionDecisions.id, after.id) : undefined))
    .orderBy(resolutionDecisions.id)
    .limit(parsed.limit + 1)
  const hasMore = page.length > parsed.limit
  const shown = hasMore ? page.slice(0, parsed.limit) : page
  return resolutionDecisionListResponseSchema.parse({
    items: shown.map((row) => resolutionDecisionSchema.parse(row.payloadJson)),
    nextCursor: hasMore ? shown.at(-1)!.id : undefined,
  })
}

export async function listResolutionStats(db: Db, scenarioId: string, query: ResolutionStatsQuery) {
  const parsed = resolutionStatsQuerySchema.parse(query)
  const { resolutionDecisions, runs, scenarios, stepRuns } = schemaFor(db)
  const [scenario] = await db
    .select({ id: scenarios.id, deletedAt: scenarios.deletedAt })
    .from(scenarios)
    .where(eq(scenarios.id, scenarioId))
    .limit(1)
  if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  const rows = await db
    .select({
      stepId: resolutionDecisions.stepId,
      stepName: sql<string | null>`max(${stepRuns.name})`,
      scenarioVersionId: runs.scenarioVersionId,
      targetId: runs.targetId,
      deterministic: sql<number>`sum(case when ${resolutionDecisions.decisionKind} = 'deterministic' then 1 else 0 end)`,
      map: sql<number>`sum(case when ${resolutionDecisions.decisionKind} = 'map' then 1 else 0 end)`,
      ai: sql<number>`sum(case when ${resolutionDecisions.decisionKind} = 'ai' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${resolutionDecisions.decisionKind} = 'failed' then 1 else 0 end)`,
    })
    .from(resolutionDecisions)
    .innerJoin(runs, eq(runs.id, resolutionDecisions.runId))
    .leftJoin(stepRuns, eq(stepRuns.id, resolutionDecisions.stepRunId))
    .where(
      and(
        eq(runs.scenarioId, scenarioId),
        isNull(runs.deletedAt),
        parsed.scenarioVersionId ? eq(runs.scenarioVersionId, parsed.scenarioVersionId) : undefined,
        parsed.targetId ? eq(runs.targetId, parsed.targetId) : undefined,
      ),
    )
    .groupBy(resolutionDecisions.stepId, runs.scenarioVersionId, runs.targetId)
    .orderBy(resolutionDecisions.stepId, runs.scenarioVersionId, runs.targetId)
    .limit(500)
  return resolutionStatsResponseSchema.parse({
    items: rows.map((row) => {
      const deterministic = Number(row.deterministic ?? 0)
      const map = Number(row.map ?? 0)
      const ai = Number(row.ai ?? 0)
      const failed = Number(row.failed ?? 0)
      const located = deterministic + map + ai
      return {
        stepId: row.stepId,
        stepName: row.stepName ?? null,
        scenarioVersionId: row.scenarioVersionId,
        targetId: row.targetId,
        deterministic,
        map,
        ai,
        failed,
        fallbackRate: located === 0 ? null : ai / located,
      }
    }),
  })
}
