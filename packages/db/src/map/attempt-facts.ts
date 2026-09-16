import { eq } from 'drizzle-orm'
import {
  MAP_FACT_BATCH_MAX,
  isMapCaptureEnabled,
  mapConditionSnapshot,
  mapGapObservation,
  mapRunFactKey,
  mapRunSourceType,
  type MapFactBatchItem,
  type MapRunSourceType,
  type RunGrant,
  type RunSnapshot,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DomainError } from './errors.js'
import { appendMapFactsTx, isMapFactWriteOpen } from './facts.js'

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

function dropUntrustedSuccess(facts: MapFactBatchItem[], untrusted: boolean): MapFactBatchItem[] {
  if (!untrusted) return facts
  return facts.filter((fact) => {
    if (fact.type !== 'verification') return true
    return !(
      (fact.verification.dimension === 'action' || fact.verification.dimension === 'business') &&
      fact.verification.verdict === 'confirmed'
    )
  })
}

export async function resolveMapRunSourceType(tx: Db, scenarioVersionId: string): Promise<MapRunSourceType> {
  const { scenarioVersions } = schemaFor(tx)
  const [version] = await tx
    .select({ kind: scenarioVersions.kind })
    .from(scenarioVersions)
    .where(eq(scenarioVersions.id, scenarioVersionId))
    .limit(1)
  return mapRunSourceType(version?.kind)
}

export async function appendFinishAttemptMapFactsTx(
  tx: Db,
  input: {
    grant: RunGrant
    snapshot: RunSnapshot
    scenarioVersionId: string
    runId: string
    attemptId: string
    stepRunId: string
    facts?: MapFactBatchItem[]
    skipped: { id: string; stepId: string }[]
    untrustedOutcome: boolean
    now: Date
  },
): Promise<void> {
  if (!isMapFactWriteOpen() || !isMapCaptureEnabled(input.snapshot)) return
  const sourceType = await resolveMapRunSourceType(tx, input.scenarioVersionId)
  const facts = dropUntrustedSuccess(input.facts ?? [], input.untrustedOutcome)
  for (const skipped of input.skipped) {
    const key = mapRunFactKey({ runId: input.runId, stepRunId: skipped.id, phase: 'step_skipped' })
    facts.push({
      type: 'observation',
      observation: mapGapObservation({
        id: newId(),
        targetId: input.snapshot.targetId,
        sourceType,
        sourceRef: { sourceType, runId: input.runId, stepRunId: skipped.id },
        phase: 'step_skipped',
        dedupeKey: key,
        observedAt: input.now.toISOString(),
        collectorVersion: input.snapshot.mapCapturePolicy?.collectorVersion,
        conditionSnapshot: mapConditionSnapshot({
          targetId: input.snapshot.targetId,
          targetAccountId: input.snapshot.targetAccountId,
        }),
        reason: 'NOT_APPLICABLE',
      }),
    })
  }
  if (facts.length === 0) return
  try {
    for (const batch of chunk(facts, MAP_FACT_BATCH_MAX)) {
      await appendMapFactsTx(tx, { caller: { kind: 'run', grant: input.grant }, facts: batch })
    }
  } catch (error) {
    if (error instanceof DomainError) return
    throw error
  }
}

export async function appendOrphanAfterGapTx(
  tx: Db,
  input: {
    grant: RunGrant
    snapshot: RunSnapshot
    scenarioVersionId: string
    runId: string
    stepRunId: string
    attemptId: string
    now: Date
  },
): Promise<void> {
  if (!isMapFactWriteOpen() || !isMapCaptureEnabled(input.snapshot)) return
  const sourceType = await resolveMapRunSourceType(tx, input.scenarioVersionId)
  const key = mapRunFactKey({
    runId: input.runId,
    attemptId: input.attemptId,
    phase: 'after_action',
  })
  try {
    await appendMapFactsTx(tx, {
      caller: { kind: 'run', grant: input.grant },
      facts: [
        {
          type: 'observation',
          observation: mapGapObservation({
            id: newId(),
            targetId: input.snapshot.targetId,
            sourceType,
            sourceRef: {
              sourceType,
              runId: input.runId,
              stepRunId: input.stepRunId,
              attemptId: input.attemptId,
            },
            phase: 'after_action',
            dedupeKey: key,
            observedAt: input.now.toISOString(),
            collectorVersion: input.snapshot.mapCapturePolicy?.collectorVersion,
            conditionSnapshot: mapConditionSnapshot({
              targetId: input.snapshot.targetId,
              targetAccountId: input.snapshot.targetAccountId,
            }),
            reason: 'PROCESS_LOST',
          }),
        },
      ],
    })
  } catch (error) {
    if (error instanceof DomainError) return
    throw error
  }
}
