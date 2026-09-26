import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  type ExecutionError,
  type JsonValue,
  type Step,
  type StepIterationDetailDto,
  type StepIterationDto,
  type StepIterationStatus,
  type StepRunDto,
  type StepSkipReason,
} from '@cairn/shared'
import { newId } from '../id.js'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import type { StepIterationRow, StepRunRow } from '../schema/execution.js'
import { appendRunEvents } from '../observe/events.js'

export function formatScopePath(headerOrdinal: number, iterationIndex: number): string {
  return `L${headerOrdinal}#${iterationIndex}`
}

export type StartIterationInput = {
  runId: string
  blockId: string
  headerStepId: string
  headerOrdinal: number
  iterationIndex: number
  item?: JsonValue
  frame: Record<string, unknown>
  bodySteps: Step[]
  stepIndices: Map<string, number>
}

export type StartIterationResult = {
  iteration: StepIterationRow
  stepRuns: StepRunRow[]
  allDisabled: boolean
  alreadyStarted: boolean
}

export async function startIterationTx(
  tx: Db,
  input: StartIterationInput,
): Promise<StartIterationResult> {
  const { stepIterations, stepRuns } = schemaFor(tx)
  const now = new Date()
  const scopePath = formatScopePath(input.headerOrdinal, input.iterationIndex)

  // 幂等检查：是否已存在本项迭代记录
  const [existing] = await tx
    .select()
    .from(stepIterations)
    .where(
      and(
        eq(stepIterations.runId, input.runId),
        eq(stepIterations.blockId, input.blockId),
        eq(stepIterations.scopePath, scopePath),
        eq(stepIterations.iterationIndex, input.iterationIndex),
      ),
    )
    .limit(1)

  if (existing) {
    const existingStepRuns = await tx
      .select()
      .from(stepRuns)
      .where(and(eq(stepRuns.runId, input.runId), eq(stepRuns.scopePath, scopePath)))
      .orderBy(asc(stepRuns.ordinal))
    return {
      iteration: existing,
      stepRuns: existingStepRuns,
      allDisabled: false,
      alreadyStarted: true,
    }
  }

  const allDisabled =
    input.bodySteps.length > 0 && input.bodySteps.every((s) => s.disabled)

  const iterationId = newId()
  const iterationRow = {
    id: iterationId,
    runId: input.runId,
    blockId: input.blockId,
    headerStepId: input.headerStepId,
    scopePath,
    iterationIndex: input.iterationIndex,
    status: allDisabled ? ('SUCCEEDED' as const) : ('RUNNING' as const),
    item: input.item ?? null,
    frame: input.frame,
    stopDecision: null,
    startedAt: now,
    finishedAt: allDisabled ? now : null,
    createdAt: now,
    updatedAt: now,
  }
  await tx.insert(stepIterations).values(iterationRow)

  await appendRunEvents(tx, input.runId, [
    {
      type: 'iteration.started',
      payload: {
        iterationId,
        blockId: input.blockId,
        scopePath,
        iterationIndex: input.iterationIndex,
        ...(input.item !== undefined ? { item: input.item } : {}),
      },
    },
  ])

  if (allDisabled) {
    await appendRunEvents(tx, input.runId, [
      {
        type: 'iteration.finished',
        payload: {
          iterationId,
          blockId: input.blockId,
          scopePath,
          iterationIndex: input.iterationIndex,
          status: 'SUCCEEDED',
        },
      },
    ])
  }

  const insertedStepRuns: StepRunRow[] = []
  if (input.bodySteps.length > 0) {
    const rows = input.bodySteps.map((step) => {
      const ordinal = input.stepIndices.get(step.id) ?? 0
      return {
        id: newId(),
        runId: input.runId,
        stepId: step.id,
        name: step.name,
        ordinal,
        scopePath,
        status: step.disabled ? ('SKIPPED' as const) : ('PENDING' as const),
        skipReason: step.disabled ? ('disabled' as const) : null,
        outcomeStatus: 'NOT_EVALUATED' as const,
        startedAt: null,
        finishedAt: step.disabled ? now : null,
        createdAt: now,
        updatedAt: now,
      }
    })
    await tx.insert(stepRuns).values(rows)
    insertedStepRuns.push(...rows)
  }

  return {
    iteration: iterationRow,
    stepRuns: insertedStepRuns,
    allDisabled,
    alreadyStarted: false,
  }
}

export async function startIteration(
  db: Db,
  input: StartIterationInput,
): Promise<StartIterationResult> {
  return db.transaction((tx) => startIterationTx(tx as unknown as Db, input))
}

export type FinishIterationInput = {
  iterationId: string
  status: StepIterationStatus
  frame?: Record<string, unknown>
  stopDecision?: JsonValue
}

export async function finishIterationTx(
  tx: Db,
  input: FinishIterationInput,
): Promise<void> {
  const { stepIterations } = schemaFor(tx)
  const now = new Date()
  const [iter] = await tx
    .select({ runId: stepIterations.runId, blockId: stepIterations.blockId, scopePath: stepIterations.scopePath, iterationIndex: stepIterations.iterationIndex })
    .from(stepIterations)
    .where(eq(stepIterations.id, input.iterationId))
    .limit(1)

  await tx
    .update(stepIterations)
    .set({
      status: input.status,
      ...(input.frame ? { frame: input.frame } : {}),
      ...(input.stopDecision !== undefined ? { stopDecision: input.stopDecision } : {}),
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(stepIterations.id, input.iterationId))

  if (iter) {
    await appendRunEvents(tx, iter.runId, [
      {
        type: 'iteration.finished',
        payload: {
          iterationId: input.iterationId,
          blockId: iter.blockId,
          scopePath: iter.scopePath,
          iterationIndex: iter.iterationIndex,
          status: input.status,
          ...(input.stopDecision !== undefined ? { stopDecision: input.stopDecision } : {}),
        },
      },
    ])
  }
}

export async function finishIteration(
  db: Db,
  input: FinishIterationInput,
): Promise<void> {
  return db.transaction((tx) => finishIterationTx(tx as unknown as Db, input))
}

export function mapStepIterationDto(iter: StepIterationRow): StepIterationDto {
  return {
    id: iter.id,
    runId: iter.runId,
    blockId: iter.blockId,
    headerStepId: iter.headerStepId,
    scopePath: iter.scopePath,
    iterationIndex: iter.iterationIndex,
    status: iter.status as StepIterationStatus,
    item: (iter.item as JsonValue) ?? undefined,
    stopDecision: (iter.stopDecision as JsonValue) ?? undefined,
    startedAt: iter.startedAt.toISOString(),
    finishedAt: iter.finishedAt ? iter.finishedAt.toISOString() : null,
  }
}

export async function loadRunIterations(
  db: Db,
  runId: string,
  options?: { blockId?: string; scopePath?: string; limit?: number; offset?: number },
): Promise<{ iterations: StepIterationDto[]; total: number; offset: number; limit: number }> {
  const { stepIterations } = schemaFor(db)
  const limit = options?.limit ?? 50
  const offset = options?.offset ?? 0
  const conditions = [
    eq(stepIterations.runId, runId),
    ...(options?.blockId ? [eq(stepIterations.blockId, options.blockId)] : []),
    ...(options?.scopePath ? [eq(stepIterations.scopePath, options.scopePath)] : []),
  ]
  const rows = await db
    .select()
    .from(stepIterations)
    .where(and(...conditions))
    .orderBy(asc(stepIterations.iterationIndex))
    .limit(limit)
    .offset(offset)

  const [countRes] = await db
    .select({ count: count() })
    .from(stepIterations)
    .where(and(...conditions))
  const total = Number(countRes?.count ?? rows.length)

  return { iterations: rows.map(mapStepIterationDto), total, offset, limit }
}

const iso = (date: Date | null | undefined): string | null => (date ? date.toISOString() : null)

export async function loadIterationDetail(
  db: Db,
  runId: string,
  iterationId: string,
): Promise<StepIterationDetailDto | null> {
  const { stepIterations, stepRuns, attempts, runs } = schemaFor(db)
  const [iter] = await db
    .select()
    .from(stepIterations)
    .where(and(eq(stepIterations.id, iterationId), eq(stepIterations.runId, runId)))
    .limit(1)
  if (!iter) return null

  const [run] = await db
    .select({ snapshot: runs.snapshot })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  const stepsById = new Map((run?.snapshot.steps ?? []).map((s) => [s.id, s]))

  const sRows = await db
    .select()
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.scopePath, iter.scopePath)))
    .orderBy(asc(stepRuns.ordinal))

  const aRows =
    sRows.length === 0
      ? []
      : await db
          .select()
          .from(attempts)
          .where(
            inArray(
              attempts.stepRunId,
              sRows.map((s) => s.id),
            ),
          )
          .orderBy(asc(attempts.attemptNo))

  const mappedSteps: StepRunDto[] = sRows.map((s) => {
    const def = stepsById.get(s.stepId)
    return {
      id: s.id,
      stepId: s.stepId,
      name: def?.name ?? s.stepId,
      type: def?.type ?? 'unknown',
      ordinal: s.ordinal,
      scopePath: s.scopePath || undefined,
      status: s.status,
      skipReason: (s.skipReason as StepSkipReason | null) ?? undefined,
      outcomeStatus: s.outcomeStatus ?? 'NOT_EVALUATED',
      startedAt: iso(s.startedAt),
      finishedAt: iso(s.finishedAt),
      attempts: aRows
        .filter((a) => a.stepRunId === s.id)
        .map((a) => ({
          id: a.id,
          attemptNo: a.attemptNo,
          status: a.status,
          startedAt: a.startedAt.toISOString(),
          finishedAt: iso(a.finishedAt),
          output: a.output ?? null,
          error: (a.error as ExecutionError | null) ?? null,
        })),
    }
  })

  return {
    iteration: {
      id: iter.id,
      runId: iter.runId,
      blockId: iter.blockId,
      headerStepId: iter.headerStepId,
      scopePath: iter.scopePath,
      iterationIndex: iter.iterationIndex,
      status: iter.status as any,
      item: (iter.item as any) ?? undefined,
      stopDecision: (iter.stopDecision as any) ?? undefined,
      startedAt: iter.startedAt.toISOString(),
      finishedAt: iter.finishedAt ? iter.finishedAt.toISOString() : null,
    },
    stepRuns: mappedSteps,
  }
}

export async function loadLoopFrozenItems(
  db: Db,
  runId: string,
  headerStepId: string,
): Promise<JsonValue[] | null> {
  const { stepRuns, attempts } = schemaFor(db)
  const [stepRun] = await db
    .select({ id: stepRuns.id })
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, runId), eq(stepRuns.stepId, headerStepId), eq(stepRuns.scopePath, '')))
    .limit(1)
  if (!stepRun) return null
  const [attempt] = await db
    .select({ output: attempts.output })
    .from(attempts)
    .where(eq(attempts.stepRunId, stepRun.id))
    .orderBy(desc(attempts.attemptNo))
    .limit(1)
  if (!attempt || !attempt.output || typeof attempt.output !== 'object') return null
  return ((attempt.output as any).frozenItems as JsonValue[]) ?? null
}

