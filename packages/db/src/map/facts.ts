import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm'
import {
  MAP_FACT_BATCH_MAX,
  MAP_FACT_READ_LIMIT_DEFAULT,
  MAP_FACT_READ_LIMIT_MAX,
  MAP_RUN_SOURCE_TYPES,
  assertMapFactSize,
  containsSensitiveMapFields,
  mapFactCallerSchema,
  mapObservationDigestPayload,
  mapObservationSchema,
  mapVerificationDigestPayload,
  mapVerificationSchema,
  splitMapObservation,
  type MapContentAvailability,
  type MapFactBatchItem,
  type MapFactCaller,
  type MapFactType,
  type MapObservation,
  type MapSourceAvailability,
  type MapSourceRef,
  type MapVerification,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { verifyRunLeaseForWrite } from '../leases/leases.js'
import {
  atomic,
  clockNow,
  insertRows,
  locked,
  onCommit,
  schemaFor,
  updateRows,
} from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { isUniqueViolation } from '../runs/errors.js'
import { suspendMapConsumptionEligibilityForWrongMatchTx } from './consumption.js'
import {
  DomainError,
  mapBaselineUnavailable,
  mapFactNotFound,
  mapFactSensitive,
  mapFactTooLarge,
  mapIdempotencyConflict,
  mapSchemaUnsupported,
  mapSourceUnavailable,
  mapStaleOwner,
  mapTargetGone,
  mapTargetMismatch,
  mapWriteClosed,
  notFound,
} from './errors.js'

export const MAP_FACTS_PROTOCOL = 'map-facts@1' as const

let writeOpen = true
export function isMapFactWriteOpen(): boolean {
  return writeOpen
}
export function setMapFactWriteOpen(open: boolean): void {
  writeOpen = open
}

export const mapFactTestHooks = {
  beforeUpdateHead: null as null | (() => void | Promise<void>),
}

export type MapFactCommitHint = { targetId: string; ingestSeq: number }
type MapFactCommitListener = (hint: MapFactCommitHint) => void
let commitListener: MapFactCommitListener | undefined
export function setMapFactCommitListener(listener?: MapFactCommitListener): void {
  commitListener = listener
}

export type AppendMapFactResult = {
  outcome: 'created' | 'duplicate'
  factType: MapFactType
  id: string
  ingestSeq: number
  payloadDigest: string
}

export type MapStoredFact =
  | {
      type: 'observation'
      ingestSeq: number
      payloadDigest: string
      observation: MapObservation
      contentAvailability: MapContentAvailability
      sourceAvailability: MapSourceAvailability
    }
  | {
      type: 'verification'
      ingestSeq: number
      payloadDigest: string
      verification: MapVerification
      contentAvailability: MapContentAvailability
      sourceAvailability: MapSourceAvailability
    }

function parseObservation(raw: unknown): MapObservation {
  if (raw && typeof raw === 'object' && 'schemaVersion' in raw && raw.schemaVersion !== 1) {
    mapSchemaUnsupported(raw.schemaVersion)
  }
  const parsed = mapObservationSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DomainError('bad_request', 'BAD_REQUEST', '地图观察契约不成立')
  }
  if (containsSensitiveMapFields(parsed.data)) mapFactSensitive()
  try {
    assertMapFactSize(mapObservationDigestPayload(parsed.data), '观察')
  } catch {
    mapFactTooLarge()
  }
  return parsed.data
}

function parseVerification(raw: unknown): MapVerification {
  if (raw && typeof raw === 'object' && 'schemaVersion' in raw && raw.schemaVersion !== 1) {
    mapSchemaUnsupported(raw.schemaVersion)
  }
  const parsed = mapVerificationSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DomainError('bad_request', 'BAD_REQUEST', '地图评价契约不成立')
  }
  if (containsSensitiveMapFields(parsed.data)) mapFactSensitive()
  try {
    assertMapFactSize(mapVerificationDigestPayload(parsed.data), '评价')
  } catch {
    mapFactTooLarge()
  }
  return parsed.data
}

async function requireTarget(tx: Db, targetId: string, forWrite: boolean) {
  const { targets } = schemaFor(tx)
  const query = tx.select().from(targets).where(eq(targets.id, targetId))
  const [row] = forWrite ? await locked(tx, query) : await query
  if (!row) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (forWrite && row.deletedAt) mapTargetGone()
  return row
}

async function lockOrCreateHead(tx: Db, targetId: string, now: Date) {
  const { mapIngestHeads } = schemaFor(tx)
  const [existing] = await locked(
    tx,
    tx.select().from(mapIngestHeads).where(eq(mapIngestHeads.targetId, targetId)),
  )
  if (existing) return existing
  try {
    await tx.insert(mapIngestHeads).values({ targetId, committedSeq: 0, updatedAt: now })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
  const [head] = await locked(
    tx,
    tx.select().from(mapIngestHeads).where(eq(mapIngestHeads.targetId, targetId)),
  )
  if (!head) throw new Error('map ingest head missing after insert')
  return head
}

async function assertKnownAccount(tx: Db, targetId: string, targetAccountId: string) {
  const { targetAccounts } = schemaFor(tx)
  const [account] = await tx
    .select({ id: targetAccounts.id, targetId: targetAccounts.targetId })
    .from(targetAccounts)
    .where(eq(targetAccounts.id, targetAccountId))
    .limit(1)
  if (!account || account.targetId !== targetId) mapTargetMismatch('目标账号不属于该目标系统')
}

async function assertRunSource(
  tx: Db,
  targetId: string,
  source: Extract<MapSourceRef, { runId: string }>,
  caller: MapFactCaller,
) {
  const { attempts, runs, stepRuns } = schemaFor(tx)
  const [run] = await tx.select().from(runs).where(eq(runs.id, source.runId)).limit(1)
  if (!run || run.targetId !== targetId || run.deletedAt) mapSourceUnavailable('运行来源不存在或不属于该目标')
  const [step] = await tx.select().from(stepRuns).where(eq(stepRuns.id, source.stepRunId)).limit(1)
  if (!step || step.runId !== source.runId) mapSourceUnavailable('步骤运行不属于该运行')
  if (source.attemptId) {
    const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, source.attemptId)).limit(1)
    if (!attempt || attempt.stepRunId !== source.stepRunId) mapSourceUnavailable('尝试不属于该步骤运行')
  }
  if (caller.kind !== 'run') mapStaleOwner()
  if (caller.grant.runId !== source.runId) mapTargetMismatch('运行租约与事实来源不一致')
  if (!(await verifyRunLeaseForWrite(tx, caller.grant))) mapStaleOwner()
}

async function assertRecorderSource(tx: Db, targetId: string, recordingId: string) {
  const { recordingDrafts } = schemaFor(tx)
  const [draft] = await tx
    .select({ id: recordingDrafts.id })
    .from(recordingDrafts)
    .where(
      and(
        eq(recordingDrafts.recordingId, recordingId),
        eq(recordingDrafts.targetId, targetId),
        isNull(recordingDrafts.deletedAt),
      ),
    )
    .limit(1)
  if (!draft) mapSourceUnavailable('录制来源不存在或不属于该目标')
}

async function assertCallerForSource(sourceType: MapSourceRef['sourceType'], caller: MapFactCaller, source: MapSourceRef) {
  if (MAP_RUN_SOURCE_TYPES.includes(sourceType as (typeof MAP_RUN_SOURCE_TYPES)[number])) return
  if (sourceType === 'user_confirmed') {
    if (caller.kind !== 'console' || source.sourceType !== 'user_confirmed' || caller.actorId !== source.actorId) {
      throw new DomainError('forbidden', 'MAP_FACT_STALE_OWNER', '人工确认主体与来源不一致')
    }
    return
  }
  if (caller.kind === 'run') {
    throw new DomainError('bad_request', 'MAP_SOURCE_UNAVAILABLE', '非运行来源不能使用运行租约写入')
  }
}

async function assertBaseline(tx: Db, targetId: string, observation: MapObservation) {
  if (!observation.baselineRef) return
  if (observation.baselineRef.kind === 'observation') {
    const { mapFactContents, mapObservations } = schemaFor(tx)
    const [row] = await tx
      .select({ id: mapObservations.id, targetId: mapObservations.targetId })
      .from(mapObservations)
      .where(eq(mapObservations.id, observation.baselineRef.observationId))
      .limit(1)
    if (!row || row.targetId !== targetId) mapBaselineUnavailable()
    const [content] = await tx
      .select()
      .from(mapFactContents)
      .where(
        and(
          eq(mapFactContents.targetId, targetId),
          eq(mapFactContents.factType, 'observation'),
          eq(mapFactContents.factId, row.id),
        ),
      )
      .limit(1)
    if (!content || content.content == null) mapBaselineUnavailable()
    return
  }
  const { storedObjects } = schemaFor(tx)
  const [object] = await tx
    .select({ id: storedObjects.id, status: storedObjects.status })
    .from(storedObjects)
    .where(eq(storedObjects.id, observation.baselineRef.objectId))
    .limit(1)
  if (!object || object.status !== 'available') mapBaselineUnavailable()
}

async function loadReceipt(tx: Db, targetId: string, dedupeKey: string) {
  const { mapFactReceipts } = schemaFor(tx)
  const [row] = await tx
    .select()
    .from(mapFactReceipts)
    .where(and(eq(mapFactReceipts.targetId, targetId), eq(mapFactReceipts.dedupeKey, dedupeKey)))
    .limit(1)
  return row ?? null
}

function sourceIndexColumns(source: MapSourceRef): {
  sourceRunId: string | null
  sourceAttemptId: string | null
  sourceRecordingId: string | null
} {
  if (source.sourceType === 'recorder') {
    return { sourceRunId: null, sourceAttemptId: null, sourceRecordingId: source.recordingId }
  }
  if ('runId' in source) {
    return {
      sourceRunId: source.runId,
      sourceAttemptId: source.attemptId ?? null,
      sourceRecordingId: null,
    }
  }
  return { sourceRunId: null, sourceAttemptId: null, sourceRecordingId: null }
}

async function writeObservation(
  tx: Db,
  observation: MapObservation,
  ingestSeq: number,
  digest: string,
  now: Date,
) {
  const { mapFactContents, mapFactReceipts, mapObservations } = schemaFor(tx)
  const { envelope, content } = splitMapObservation(observation)
  const source = sourceIndexColumns(observation.sourceRef)
  await insertRows(tx, mapObservations, {
    id: observation.id,
    targetId: observation.targetId,
    ingestSeq,
    dedupeKey: observation.dedupeKey,
    payloadDigest: digest,
    observedAt: new Date(observation.observedAt),
    createdAt: now,
    sourceType: observation.sourceType,
    sourceRunId: source.sourceRunId,
    sourceAttemptId: source.sourceAttemptId,
    sourceRecordingId: source.sourceRecordingId,
    captureStatus: observation.captureStatus,
    envelope,
  })
  await tx.insert(mapFactReceipts).values({
    targetId: observation.targetId,
    dedupeKey: observation.dedupeKey,
    factType: 'observation',
    factId: observation.id,
    ingestSeq,
    payloadDigest: digest,
    createdAt: now,
  })
  await tx.insert(mapFactContents).values({
    targetId: observation.targetId,
    factType: 'observation',
    factId: observation.id,
    content,
    updatedAt: now,
  })
}

async function writeVerification(
  tx: Db,
  verification: MapVerification,
  ingestSeq: number,
  digest: string,
  now: Date,
) {
  const { mapFactContents, mapFactReceipts, mapVerificationRefs, mapVerifications } = schemaFor(tx)
  const { id: _id, ...envelope } = verification
  await insertRows(tx, mapVerifications, {
    id: verification.id,
    targetId: verification.targetId,
    ingestSeq,
    dedupeKey: verification.dedupeKey,
    payloadDigest: digest,
    dimension: verification.dimension,
    verdict: verification.verdict,
    envelope,
    evaluatedAt: new Date(verification.evaluatedAt),
    createdAt: now,
  })
  await tx.insert(mapFactReceipts).values({
    targetId: verification.targetId,
    dedupeKey: verification.dedupeKey,
    factType: 'verification',
    factId: verification.id,
    ingestSeq,
    payloadDigest: digest,
    createdAt: now,
  })
  await tx.insert(mapFactContents).values({
    targetId: verification.targetId,
    factType: 'verification',
    factId: verification.id,
    content: { claim: verification.claim },
    updatedAt: now,
  })
  if (verification.observationIds.length > 0) {
    await tx.insert(mapVerificationRefs).values(
      verification.observationIds.map((observationId) => ({
        verificationId: verification.id,
        observationId,
        targetId: verification.targetId,
      })),
    )
  }
}

function isConfirmedConsumptionWrongMatch(verification: MapVerification): boolean {
  return verification.verificationSource.kind === 'user_confirmed' &&
    verification.dimension === 'identity' && verification.verdict === 'rejected'
}

async function suspendForConfirmedWrongMatch(tx: Db, verification: MapVerification): Promise<void> {
  if (!isConfirmedConsumptionWrongMatch(verification)) return
  const source = verification.verificationSource
  if (source.kind !== 'user_confirmed') return
  await suspendMapConsumptionEligibilityForWrongMatchTx(tx, {
    targetId: verification.targetId,
    decisionId: source.decisionId,
    reason: `确认错配：${verification.claim.proposition}`.slice(0, 256),
  })
}

async function assertVerificationRefs(
  tx: Db,
  verification: MapVerification,
  pendingObservationIds: Set<string>,
) {
  const { mapObservations, mapVerifications } = schemaFor(tx)
  for (const observationId of verification.observationIds) {
    if (pendingObservationIds.has(observationId)) continue
    const [row] = await tx
      .select({ id: mapObservations.id, targetId: mapObservations.targetId })
      .from(mapObservations)
      .where(eq(mapObservations.id, observationId))
      .limit(1)
    if (!row || row.targetId !== verification.targetId) mapTargetMismatch('评价引用了其他目标或不存在的观察')
  }
  if (verification.supersedesVerificationId) {
    const [prior] = await tx
      .select({ id: mapVerifications.id, targetId: mapVerifications.targetId })
      .from(mapVerifications)
      .where(eq(mapVerifications.id, verification.supersedesVerificationId))
      .limit(1)
    if (!prior || prior.targetId !== verification.targetId) {
      mapTargetMismatch('被替代的评价不存在或不属于同一目标')
    }
  }
}

type PreparedItem = {
  item: MapFactBatchItem
  digest: string
  receipt: Awaited<ReturnType<typeof loadReceipt>>
}

export async function appendMapFactsTx(
  tx: Db,
  input: { caller: MapFactCaller; facts: MapFactBatchItem[] },
): Promise<AppendMapFactResult[]> {
  if (!isMapFactWriteOpen()) mapWriteClosed()
  const caller = mapFactCallerSchema.parse(input.caller)
  if (input.facts.length < 1 || input.facts.length > MAP_FACT_BATCH_MAX) {
    throw new DomainError('bad_request', 'BAD_REQUEST', `单批地图事实必须为 1–${MAP_FACT_BATCH_MAX} 条`)
  }
  const parsed: MapFactBatchItem[] = input.facts.map((fact) =>
    fact.type === 'observation'
      ? { type: 'observation', observation: parseObservation(fact.observation) }
      : { type: 'verification', verification: parseVerification(fact.verification) },
  )
  const targetId =
    parsed[0]!.type === 'observation' ? parsed[0]!.observation.targetId : parsed[0]!.verification.targetId
  if (
    parsed.some((fact) =>
      fact.type === 'observation' ? fact.observation.targetId !== targetId : fact.verification.targetId !== targetId,
    )
  ) {
    mapTargetMismatch('同一批次不能混合多个目标')
  }
  await requireTarget(tx, targetId, true)
  const now = await clockNow(tx)
  const head = await lockOrCreateHead(tx, targetId, now)
  const pendingKeys = new Map<string, string>()
  const pendingObservationIds = new Set<string>()
  const prepared: PreparedItem[] = []
  for (const fact of parsed) {
    if (fact.type === 'observation') {
      const observation = fact.observation
      if (observation.conditionSnapshot.accountBinding.presence === 'known') {
        await assertKnownAccount(tx, targetId, observation.conditionSnapshot.accountBinding.targetAccountId)
      }
      await assertCallerForSource(observation.sourceType, caller, observation.sourceRef)
      if (MAP_RUN_SOURCE_TYPES.includes(observation.sourceType as (typeof MAP_RUN_SOURCE_TYPES)[number])) {
        await assertRunSource(tx, targetId, observation.sourceRef as Extract<MapSourceRef, { runId: string }>, caller)
      }
      if (observation.sourceType === 'recorder' && observation.sourceRef.sourceType === 'recorder') {
        await assertRecorderSource(tx, targetId, observation.sourceRef.recordingId)
      }
      await assertBaseline(tx, targetId, observation)
      const digest = sha256Hex(mapObservationDigestPayload(observation))
      const seen = pendingKeys.get(observation.dedupeKey)
      if (seen && seen !== digest) mapIdempotencyConflict()
      if (seen) {
        prepared.push({
          item: fact,
          digest,
          receipt: {
            targetId,
            dedupeKey: observation.dedupeKey,
            factType: 'observation',
            factId: observation.id,
            ingestSeq: 0,
            payloadDigest: digest,
            createdAt: now,
          },
        } as PreparedItem)
        continue
      }
      const receipt = await loadReceipt(tx, targetId, observation.dedupeKey)
      if (receipt && receipt.payloadDigest !== digest) mapIdempotencyConflict()
      if (!receipt) pendingKeys.set(observation.dedupeKey, digest)
      if (!receipt) pendingObservationIds.add(observation.id)
      prepared.push({ item: fact, digest, receipt })
    } else {
      const verification = fact.verification
      await assertVerificationRefs(tx, verification, pendingObservationIds)
      if (verification.verificationSource.kind === 'user_confirmed') {
        if (caller.kind !== 'console' || caller.actorId !== verification.verificationSource.actorId) {
          throw new DomainError('forbidden', 'MAP_FACT_STALE_OWNER', '人工评价主体与来源不一致')
        }
      } else if (caller.kind === 'run') {
        const sourceRunId =
          verification.verificationSource.kind === 'rule' || verification.verificationSource.kind === 'model'
            ? verification.verificationSource.runId
            : undefined
        if (!sourceRunId || caller.grant.runId !== sourceRunId || !(await verifyRunLeaseForWrite(tx, caller.grant))) {
          mapStaleOwner()
        }
      }
      const digest = sha256Hex(mapVerificationDigestPayload(verification))
      const seen = pendingKeys.get(verification.dedupeKey)
      if (seen && seen !== digest) mapIdempotencyConflict()
      const receipt = seen ? null : await loadReceipt(tx, targetId, verification.dedupeKey)
      if (receipt && receipt.payloadDigest !== digest) mapIdempotencyConflict()
      if (!receipt && !seen) pendingKeys.set(verification.dedupeKey, digest)
      prepared.push({ item: fact, digest, receipt: receipt ?? (seen ? ({ payloadDigest: digest } as never) : null) })
    }
  }

  const created = prepared.filter((item) => item.receipt === null)
  let nextSeq = head.committedSeq
  const results: AppendMapFactResult[] = []
  const createdByKey = new Map<string, AppendMapFactResult>()
  try {
    for (const item of prepared) {
      if (item.receipt) {
        const existing =
          'factId' in item.receipt && item.receipt.ingestSeq
            ? item.receipt
            : await loadReceipt(
                tx,
                targetId,
                item.item.type === 'observation' ? item.item.observation.dedupeKey : item.item.verification.dedupeKey,
              )
        if (!existing) {
          const prior = createdByKey.get(
            item.item.type === 'observation' ? item.item.observation.dedupeKey : item.item.verification.dedupeKey,
          )
          if (!prior) throw new Error('duplicate map fact missing receipt')
          results.push(prior)
          continue
        }
        results.push({
          outcome: 'duplicate',
          factType: existing.factType,
          id: existing.factId,
          ingestSeq: existing.ingestSeq,
          payloadDigest: existing.payloadDigest,
        })
        continue
      }
      nextSeq += 1
      if (item.item.type === 'observation') {
        await writeObservation(tx, item.item.observation, nextSeq, item.digest, now)
        const result = {
          outcome: 'created' as const,
          factType: 'observation' as const,
          id: item.item.observation.id,
          ingestSeq: nextSeq,
          payloadDigest: item.digest,
        }
        createdByKey.set(item.item.observation.dedupeKey, result)
        results.push(result)
      } else {
        await writeVerification(tx, item.item.verification, nextSeq, item.digest, now)
        await suspendForConfirmedWrongMatch(tx, item.item.verification)
        const result = {
          outcome: 'created' as const,
          factType: 'verification' as const,
          id: item.item.verification.id,
          ingestSeq: nextSeq,
          payloadDigest: item.digest,
        }
        createdByKey.set(item.item.verification.dedupeKey, result)
        results.push(result)
      }
    }
    if (created.length > 0) {
      if (mapFactTestHooks.beforeUpdateHead) await mapFactTestHooks.beforeUpdateHead()
      const { mapIngestHeads } = schemaFor(tx)
      const updated = await updateRows(
        tx,
        mapIngestHeads,
        { committedSeq: nextSeq, updatedAt: now },
        and(eq(mapIngestHeads.targetId, targetId), eq(mapIngestHeads.committedSeq, head.committedSeq)),
      )
      if (updated.length === 0) {
        throw new DomainError('conflict', 'MAP_FACT_IDEMPOTENCY_CONFLICT', '提交水位竞争，请重试')
      }
      onCommit(tx, () => commitListener?.({ targetId, ingestSeq: nextSeq }))
    }
    return results
  } catch (error) {
    if (isUniqueViolation(error)) {
      const first = parsed[0]!
      const key = first.type === 'observation' ? first.observation.dedupeKey : first.verification.dedupeKey
      const receipt = await loadReceipt(tx, targetId, key)
      if (receipt) {
        const digest =
          first.type === 'observation'
            ? sha256Hex(mapObservationDigestPayload(first.observation))
            : sha256Hex(mapVerificationDigestPayload(first.verification))
        if (receipt.payloadDigest === digest) {
          return [
            {
              outcome: 'duplicate',
              factType: receipt.factType,
              id: receipt.factId,
              ingestSeq: receipt.ingestSeq,
              payloadDigest: receipt.payloadDigest,
            },
          ]
        }
        mapIdempotencyConflict()
      }
    }
    throw error
  }
}

export async function appendMapFacts(
  db: Db,
  input: { caller: MapFactCaller; facts: MapFactBatchItem[] },
): Promise<AppendMapFactResult[]> {
  return atomic(db, (tx) => appendMapFactsTx(tx, input))
}

export async function appendMapObservationTx(
  tx: Db,
  input: { caller: MapFactCaller; observation: MapObservation },
): Promise<AppendMapFactResult> {
  const [result] = await appendMapFactsTx(tx, {
    caller: input.caller,
    facts: [{ type: 'observation', observation: input.observation }],
  })
  return result!
}

export async function appendMapObservation(
  db: Db,
  input: { caller: MapFactCaller; observation: MapObservation },
): Promise<AppendMapFactResult> {
  return atomic(db, (tx) => appendMapObservationTx(tx, input))
}

export async function appendMapVerification(
  db: Db,
  input: { caller: MapFactCaller; verification: MapVerification },
): Promise<AppendMapFactResult> {
  const [result] = await appendMapFacts(db, {
    caller: input.caller,
    facts: [{ type: 'verification', verification: input.verification }],
  })
  return result!
}

async function sourceAvailabilityFor(
  db: Db,
  targetId: string,
  sourceRunId: string | null,
  sourceRecordingId: string | null,
): Promise<MapSourceAvailability> {
  const { recordingDrafts, runs } = schemaFor(db)
  if (sourceRunId) {
    const [run] = await db
      .select({ deletedAt: runs.deletedAt })
      .from(runs)
      .where(and(eq(runs.id, sourceRunId), eq(runs.targetId, targetId)))
      .limit(1)
    if (!run) return 'deleted'
    return run.deletedAt ? 'deleted' : 'live'
  }
  if (sourceRecordingId) {
    const live = await db
      .select({ id: recordingDrafts.id })
      .from(recordingDrafts)
      .where(
        and(
          eq(recordingDrafts.recordingId, sourceRecordingId),
          eq(recordingDrafts.targetId, targetId),
          isNull(recordingDrafts.deletedAt),
        ),
      )
      .limit(1)
    if (live[0]) return 'live'
    const any = await db
      .select({ id: recordingDrafts.id })
      .from(recordingDrafts)
      .where(
        and(eq(recordingDrafts.recordingId, sourceRecordingId), eq(recordingDrafts.targetId, targetId)),
      )
      .limit(1)
    return any[0] ? 'deleted' : 'deleted'
  }
  return 'unknown'
}

function hydrateObservation(
  envelope: Record<string, unknown>,
  content: Record<string, unknown> | null,
  id: string,
): { observation: MapObservation; contentAvailability: MapContentAvailability } {
  const summaries =
    content && typeof content === 'object'
      ? {
          semanticSummary: content.semanticSummary,
          stateSummary: content.stateSummary,
          structuralSummary: content.structuralSummary,
        }
      : {
          semanticSummary: { predicates: [] },
          stateSummary: { regions: {} },
          structuralSummary: { nodeCount: 0, truncated: true },
        }
  const observation = mapObservationSchema.parse({ ...envelope, id, ...summaries })
  return { observation, contentAvailability: content ? 'available' : 'expired' }
}

function hydrateVerification(
  envelope: Record<string, unknown>,
  id: string,
  content: Record<string, unknown> | null,
): { verification: MapVerification; contentAvailability: MapContentAvailability } {
  const verification = mapVerificationSchema.parse({ ...envelope, id })
  return { verification, contentAvailability: content ? 'available' : 'expired' }
}

export async function captureMapWatermark(db: Db, targetId: string): Promise<{ targetId: string; committedSeq: number }> {
  await requireTarget(db, targetId, false)
  const { mapIngestHeads } = schemaFor(db)
  const [head] = await db.select().from(mapIngestHeads).where(eq(mapIngestHeads.targetId, targetId)).limit(1)
  return { targetId, committedSeq: head?.committedSeq ?? 0 }
}

export async function readMapFacts(
  db: Db,
  input: { targetId: string; afterSeq?: number; throughSeq?: number; limit?: number },
): Promise<{
  facts: MapStoredFact[]
  committedSeq: number
  throughSeq: number
  nextSeq: number
}> {
  await requireTarget(db, input.targetId, false)
  const watermark = await captureMapWatermark(db, input.targetId)
  const afterSeq = input.afterSeq ?? 0
  const throughSeq = Math.min(input.throughSeq ?? watermark.committedSeq, watermark.committedSeq)
  const limit = Math.min(Math.max(input.limit ?? MAP_FACT_READ_LIMIT_DEFAULT, 1), MAP_FACT_READ_LIMIT_MAX)
  if (throughSeq <= afterSeq) {
    return { facts: [], committedSeq: watermark.committedSeq, throughSeq, nextSeq: afterSeq }
  }
  const { mapFactContents, mapFactReceipts, mapObservations, mapVerifications } = schemaFor(db)
  const receipts = await db
    .select()
    .from(mapFactReceipts)
    .where(
      and(
        eq(mapFactReceipts.targetId, input.targetId),
        gt(mapFactReceipts.ingestSeq, afterSeq),
        lte(mapFactReceipts.ingestSeq, throughSeq),
      ),
    )
    .orderBy(asc(mapFactReceipts.ingestSeq))
    .limit(limit)
  const facts: MapStoredFact[] = []
  for (const receipt of receipts) {
    const [content] = await db
      .select()
      .from(mapFactContents)
      .where(
        and(
          eq(mapFactContents.targetId, input.targetId),
          eq(mapFactContents.factType, receipt.factType),
          eq(mapFactContents.factId, receipt.factId),
        ),
      )
      .limit(1)
    if (receipt.factType === 'observation') {
      const [row] = await db.select().from(mapObservations).where(eq(mapObservations.id, receipt.factId)).limit(1)
      if (!row) continue
      const hydrated = hydrateObservation(row.envelope, content?.content ?? null, row.id)
      facts.push({
        type: 'observation',
        ingestSeq: receipt.ingestSeq,
        payloadDigest: receipt.payloadDigest,
        observation: hydrated.observation,
        contentAvailability: hydrated.contentAvailability,
        sourceAvailability: await sourceAvailabilityFor(
          db,
          input.targetId,
          row.sourceRunId,
          row.sourceRecordingId,
        ),
      })
    } else {
      const [row] = await db.select().from(mapVerifications).where(eq(mapVerifications.id, receipt.factId)).limit(1)
      if (!row) continue
      const hydrated = hydrateVerification(row.envelope, row.id, content?.content ?? null)
      facts.push({
        type: 'verification',
        ingestSeq: receipt.ingestSeq,
        payloadDigest: receipt.payloadDigest,
        verification: hydrated.verification,
        contentAvailability: hydrated.contentAvailability,
        sourceAvailability: 'unknown',
      })
    }
  }
  return {
    facts,
    committedSeq: watermark.committedSeq,
    throughSeq,
    nextSeq: facts.at(-1)?.ingestSeq ?? afterSeq,
  }
}

export async function getMapFact(
  db: Db,
  input: { targetId: string; factType: MapFactType; factId: string },
): Promise<MapStoredFact> {
  await requireTarget(db, input.targetId, false)
  const { mapFactReceipts } = schemaFor(db)
  const [receipt] = await db
    .select()
    .from(mapFactReceipts)
    .where(
      and(
        eq(mapFactReceipts.targetId, input.targetId),
        eq(mapFactReceipts.factType, input.factType),
        eq(mapFactReceipts.factId, input.factId),
      ),
    )
    .limit(1)
  if (!receipt) mapFactNotFound()
  const page = await readMapFacts(db, {
    targetId: input.targetId,
    afterSeq: receipt.ingestSeq - 1,
    throughSeq: receipt.ingestSeq,
    limit: 1,
  })
  const fact = page.facts[0]
  if (!fact) mapFactNotFound()
  return fact
}

export async function previewMapFactRetention(
  db: Db,
  input: { targetId?: string; olderThan: Date },
): Promise<{ observationContents: number; verificationContents: number }> {
  const { mapFactContents, mapFactReceipts } = schemaFor(db)
  const rows = await db
    .select({
      factType: mapFactContents.factType,
      content: mapFactContents.content,
      createdAt: mapFactReceipts.createdAt,
      targetId: mapFactContents.targetId,
    })
    .from(mapFactContents)
    .innerJoin(
      mapFactReceipts,
      and(
        eq(mapFactReceipts.targetId, mapFactContents.targetId),
        eq(mapFactReceipts.factType, mapFactContents.factType),
        eq(mapFactReceipts.factId, mapFactContents.factId),
      ),
    )
  const matched = rows.filter(
    (row) =>
      row.content != null &&
      row.createdAt < input.olderThan &&
      (!input.targetId || row.targetId === input.targetId),
  )
  return {
    observationContents: matched.filter((row) => row.factType === 'observation').length,
    verificationContents: matched.filter((row) => row.factType === 'verification').length,
  }
}

export async function expireMapFactContents(
  db: Db,
  input: { targetId?: string; olderThan: Date },
): Promise<{ expired: number }> {
  return atomic(db, async (tx) => {
    const { mapFactAvailability, mapFactContents, mapFactReceipts } = schemaFor(tx)
    const rows = await tx
      .select({
        targetId: mapFactContents.targetId,
        factType: mapFactContents.factType,
        factId: mapFactContents.factId,
        content: mapFactContents.content,
        createdAt: mapFactReceipts.createdAt,
      })
      .from(mapFactContents)
      .innerJoin(
        mapFactReceipts,
        and(
          eq(mapFactReceipts.targetId, mapFactContents.targetId),
          eq(mapFactReceipts.factType, mapFactContents.factType),
          eq(mapFactReceipts.factId, mapFactContents.factId),
        ),
      )
    const matched = rows.filter(
      (row) =>
        row.content != null &&
        row.createdAt < input.olderThan &&
        (!input.targetId || row.targetId === input.targetId),
    )
    const now = await clockNow(tx)
    for (const row of matched) {
      await tx
        .update(mapFactContents)
        .set({ content: null, updatedAt: now })
        .where(
          and(
            eq(mapFactContents.targetId, row.targetId),
            eq(mapFactContents.factType, row.factType),
            eq(mapFactContents.factId, row.factId),
          ),
        )
      const [latest] = await tx
        .select({ revision: mapFactAvailability.availabilityRevision })
        .from(mapFactAvailability)
        .where(
          and(
            eq(mapFactAvailability.targetId, row.targetId),
            eq(mapFactAvailability.factType, row.factType),
            eq(mapFactAvailability.factId, row.factId),
          ),
        )
        .orderBy(sql`${mapFactAvailability.availabilityRevision} desc`)
        .limit(1)
      await insertRows(tx, mapFactAvailability, {
        id: newId(),
        targetId: row.targetId,
        factType: row.factType,
        factId: row.factId,
        availabilityRevision: (latest?.revision ?? 0) + 1,
        status: 'expired',
        reason: 'retention',
        createdAt: now,
      })
    }
    return { expired: matched.length }
  })
}
