import { randomUUID } from 'node:crypto'
import { DomainError, appendMapObservation, isMapFactWriteOpen, type DbHandle } from '@cairn/db'
import {
  isAiStepType,
  isMapCaptureEnabled,
  mapConditionSnapshot,
  mapGapObservation,
  mapObservationShell,
  mapRunFactKey,
  stepUsesBrowser,
  type MapFactBatchItem,
  type MapObservation,
  type RunGrant,
  type RunSnapshot,
  type SessionGrant,
  type Step,
} from '@cairn/shared'
import type {
  PassiveMapCaptureInput,
  PassiveMapCaptureResult,
  PassiveMapObservationPort,
} from '../engine/ports.js'

export type CapturePhaseBudget = {
  usedMs: number
}

function observationOf(result: PassiveMapCaptureResult): MapObservation {
  return 'observation' in result ? result.observation : result.gap
}

function sourceRef(request: Pick<PassiveMapCaptureInput, 'sourceType' | 'runId' | 'stepRunId' | 'attemptId'>) {
  return {
    sourceType: request.sourceType,
    runId: request.runId,
    stepRunId: request.stepRunId,
    attemptId: request.attemptId,
  } as const
}

export function timeBudgetGap(request: PassiveMapCaptureInput): MapObservation {
  return mapGapObservation({
    id: randomUUID(),
    targetId: request.targetId,
    sourceType: request.sourceType,
    sourceRef: sourceRef(request),
    phase: request.phase,
    dedupeKey: mapRunFactKey({
      runId: request.runId,
      attemptId: request.attemptId,
      phase: request.phase,
    }),
    collectorVersion: request.policy.collectorVersion,
    conditionSnapshot: request.condition,
    reason: 'TIME_BUDGET',
  })
}

function gap(request: PassiveMapCaptureInput, reason: 'NOT_APPLICABLE' | 'CAPABILITY_MISSING' | 'PROCESS_LOST') {
  return mapGapObservation({
    id: randomUUID(),
    targetId: request.targetId,
    sourceType: request.sourceType,
    sourceRef: sourceRef(request),
    phase: request.phase,
    dedupeKey: mapRunFactKey({
      runId: request.runId,
      attemptId: request.attemptId,
      phase: request.phase,
    }),
    collectorVersion: request.policy.collectorVersion,
    conditionSnapshot: request.condition,
    reason,
  })
}

export function captureRequest(input: {
  grant: RunGrant
  snapshot: RunSnapshot
  step: Step
  stepRunId: string
  attemptId: string
  phase: 'before_action' | 'after_action'
  sessionGrant?: SessionGrant
  remainingStepMs: number
  budgetUsedMs: number
  sourceType: PassiveMapCaptureInput['sourceType']
  signal?: AbortSignal
}): PassiveMapCaptureInput {
  return {
    grant: input.grant,
    sessionGrant: input.sessionGrant,
    runId: input.snapshot.runId,
    stepRunId: input.stepRunId,
    attemptId: input.attemptId,
    phase: input.phase,
    targetId: input.snapshot.targetId,
    policy: input.snapshot.mapCapturePolicy!,
    sourceType: input.sourceType,
    condition: mapConditionSnapshot({
      targetId: input.snapshot.targetId,
      targetAccountId: input.snapshot.targetAccountId,
    }),
    remainingStepMs: input.remainingStepMs,
    runBudgetUsedMs: input.budgetUsedMs,
    signal: input.signal,
    stepType: input.step.type,
    allowedOrigins: input.snapshot.allowedOrigins,
  }
}

export async function capturePhaseObservation(input: {
  port?: PassiveMapObservationPort
  request: PassiveMapCaptureInput
  budget: CapturePhaseBudget
}): Promise<{ observation: MapObservation; elapsedMs: number }> {
  const started = Date.now()
  const { request, port, budget } = input
  const remainingRun = request.policy.runBudgetMs - budget.usedMs
  if (request.remainingStepMs < request.policy.phaseBudgetMs || remainingRun < request.policy.phaseBudgetMs) {
    return { observation: timeBudgetGap(request), elapsedMs: Date.now() - started }
  }
  if (!stepUsesBrowser(request.stepType) || !request.sessionGrant) {
    return { observation: gap(request, 'NOT_APPLICABLE'), elapsedMs: Date.now() - started }
  }
  if (!port) {
    return { observation: gap(request, 'CAPABILITY_MISSING'), elapsedMs: Date.now() - started }
  }

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), request.policy.phaseBudgetMs)
  const combined = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal
  try {
    const result = await port.capture({ ...request, signal: combined })
    let observation = observationOf(result)
    if (isAiStepType(request.stepType)) {
      observation = {
        ...observation,
        completeness: 'none',
        truncated: true,
        semanticSummary: {
          predicates: [
            ...observation.semanticSummary.predicates,
            { name: 'aiStepResultOnly', value: true },
          ],
        },
      }
    }
    return { observation, elapsedMs: Date.now() - started }
  } catch {
    return { observation: timeBudgetGap(request), elapsedMs: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}

export async function persistBeforeObservation(input: {
  db: DbHandle
  grant: RunGrant
  snapshot: RunSnapshot
  step: Step
  stepRunId: string
  attemptId: string
  sessionGrant?: SessionGrant
  remainingStepMs: number
  budget: CapturePhaseBudget
  sourceType: PassiveMapCaptureInput['sourceType']
  port?: PassiveMapObservationPort
  signal?: AbortSignal
}): Promise<'continue' | 'abort'> {
  if (!isMapFactWriteOpen() || !isMapCaptureEnabled(input.snapshot) || !input.snapshot.mapCapturePolicy) {
    return 'continue'
  }
  const request = captureRequest({ ...input, phase: 'before_action', budgetUsedMs: input.budget.usedMs })
  const captured = await capturePhaseObservation({
    port: input.port,
    request,
    budget: input.budget,
  })
  input.budget.usedMs += captured.elapsedMs
  try {
    await appendMapObservation(input.db, {
      caller: { kind: 'run', grant: input.grant },
      observation: captured.observation,
    })
    return 'continue'
  } catch (error) {
    if (error instanceof DomainError && error.code === 'MAP_WRITE_CLOSED') return 'continue'
    if (!(error instanceof DomainError)) return 'abort'
    try {
      await appendMapObservation(input.db, {
        caller: { kind: 'run', grant: input.grant },
        observation: gap(request, 'PROCESS_LOST'),
      })
      return 'continue'
    } catch {
      return 'abort'
    }
  }
}

export async function buildAfterMapFacts(input: {
  grant: RunGrant
  snapshot: RunSnapshot
  step: Step
  stepRunId: string
  attemptId: string
  sessionGrant?: SessionGrant
  remainingStepMs: number
  budget: CapturePhaseBudget
  sourceType: PassiveMapCaptureInput['sourceType']
  port?: PassiveMapObservationPort
  signal?: AbortSignal
  extraFacts?: MapFactBatchItem[]
}): Promise<MapFactBatchItem[]> {
  if (!isMapFactWriteOpen() || !isMapCaptureEnabled(input.snapshot) || !input.snapshot.mapCapturePolicy) {
    return []
  }
  const request = captureRequest({ ...input, phase: 'after_action', budgetUsedMs: input.budget.usedMs })
  const captured = await capturePhaseObservation({
    port: input.port,
    request,
    budget: input.budget,
  })
  input.budget.usedMs += captured.elapsedMs
  return [{ type: 'observation', observation: captured.observation }, ...(input.extraFacts ?? [])]
}
