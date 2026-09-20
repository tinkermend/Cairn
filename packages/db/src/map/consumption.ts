import { and, desc, eq, gt } from 'drizzle-orm'
import {
  FACTORY_MAP_CONSUMPTION_POLICY,
  MAP_CONSUMPTION_CONSUMER_VERSION,
  MAP_CONSUMPTION_PROTOCOL,
  canonicalJson,
  frozenMapConsumptionSchema,
  mapAssetRefKey,
  mapConsumptionEligibilitySchema,
  mapConsumptionPolicyDtoSchema,
  mapConsumptionPolicySchema,
  mapConsumptionPolicyUpdateBodySchema,
  mapDecisionListQuerySchema,
  mapDecisionListResponseSchema,
  mapReleaseManifestSchema,
  mapSelectionDecisionSchema,
  resolveMapConsumptionPolicy,
  type EnabledMapConsumption,
  type ExecutionActor,
  type FrozenMapConsumption,
  type MapConsumptionOverride,
  type MapConsumptionPolicy,
  type MapConsumptionPolicyDto,
  type MapConsumptionPolicyUpdateBody,
  type MapDecisionListQuery,
  type MapFrozenBinding,
  type MapSelectionDecision,
  type RunGrant,
  type TargetDescriptor,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { verifyRunLeaseForWrite } from '../leases/leases.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { isUniqueViolation, notFound } from '../runs/errors.js'
import {
  mapCommandIdempotencyConflict,
  mapConsumerUnavailable,
  mapConsumptionNotEligible,
  mapReleaseNotFound,
  mapReleaseNotPublished,
  mapReleaseWithdrawn,
  mapRevisionConflict,
  mapStaleOwner,
  mapTargetMismatch,
} from './errors.js'
import { requireLiveTarget } from './view.js'

function policyFromRow(row: {
  policySchemaVersion: number
  policyVersion: number
  consumptionMode: MapConsumptionPolicy['mode']
  allowedStepTypes: MapConsumptionPolicy['allowedStepTypes']
  allowedAssetRefs: MapConsumptionPolicy['allowedAssetRefs']
  maxCandidateCount: number
  maxResolveMs: number
  maxExtraAiCalls: number
}): MapConsumptionPolicy {
  return mapConsumptionPolicySchema.parse({
    schemaVersion: row.policySchemaVersion,
    policyVersion: row.policyVersion,
    mode: row.consumptionMode,
    allowedStepTypes: row.allowedStepTypes,
    allowedAssetRefs: row.allowedAssetRefs,
    maxCandidateCount: row.maxCandidateCount,
    maxResolveMs: row.maxResolveMs,
    maxExtraAiCalls: row.maxExtraAiCalls,
    onUnavailable: 'baseline',
  })
}

async function latestEligibility(db: Db, targetId: string) {
  const { mapConsumptionEligibility, mapConsumptionEligibilitySuspensions } = schemaFor(db)
  const [row] = await db
    .select()
    .from(mapConsumptionEligibility)
    .where(eq(mapConsumptionEligibility.targetId, targetId))
    .orderBy(desc(mapConsumptionEligibility.recordedAt))
    .limit(1)
  if (!row) return null
  const [suspension] = await db
    .select()
    .from(mapConsumptionEligibilitySuspensions)
    .where(eq(mapConsumptionEligibilitySuspensions.targetId, targetId))
    .limit(1)
  return {
    ...row,
    ...(suspension
      ? { suspendedAt: suspension.suspendedAt, suspensionReason: suspension.reason }
      : {}),
  }
}

export async function getMapConsumptionPolicy(db: Db, targetId: string): Promise<MapConsumptionPolicyDto> {
  await requireLiveTarget(db, targetId)
  const { mapConsumptionPolicies } = schemaFor(db)
  const [row] = await db.select().from(mapConsumptionPolicies).where(eq(mapConsumptionPolicies.targetId, targetId)).limit(1)
  const eligibility = await latestEligibility(db, targetId)
  return mapConsumptionPolicyDtoSchema.parse({
    targetId,
    revision: row?.revision ?? 0,
    policy: row ? policyFromRow(row) : FACTORY_MAP_CONSUMPTION_POLICY,
    eligibility: eligibility
      ? {
          reportId: eligibility.eligibilityReportKey,
          eligibleStepTypes: eligibility.eligibleStepTypes,
          recordedAt: eligibility.recordedAt.toISOString(),
          ...(eligibility.suspendedAt ? {
            suspendedAt: eligibility.suspendedAt.toISOString(),
            suspensionReason: eligibility.suspensionReason,
          } : {}),
        }
      : null,
    updatedAt: (row?.updatedAt ?? new Date(0)).toISOString(),
  })
}

export async function grantMapConsumptionEligibility(
  db: Db,
  input: {
    targetId: string
    reportId: string
    eligibleStepTypes?: MapConsumptionPolicy['allowedStepTypes']
    reason?: string
    actor?: ExecutionActor
  },
) {
  await atomic(db, async (tx) => {
    await requireLiveTarget(tx, input.targetId)
    const { mapConsumptionEligibility, mapConsumptionEligibilitySuspensions, targets } = schemaFor(tx)
    await locked(tx, tx.select().from(targets).where(eq(targets.id, input.targetId)))
    const now = await clockNow(tx)
    const eligibility = mapConsumptionEligibilitySchema.parse({ reportId: input.reportId, recordedAt: now.toISOString(), eligibleStepTypes: input.eligibleStepTypes ?? ['extract', 'assert'] })
    let created = false
    try {
      await insertRows(tx, mapConsumptionEligibility, {
        id: newId(),
        targetId: input.targetId,
        eligibilityReportKey: eligibility.reportId,
        eligibleStepTypes: eligibility.eligibleStepTypes,
        recordedAt: now,
      })
      created = true
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
    }
    // A later independent T report is the only normal path that reopens the gate.
    // Replaying the same report must not silently erase a confirmed counterexample.
    if (created) {
      await tx.delete(mapConsumptionEligibilitySuspensions).where(eq(mapConsumptionEligibilitySuspensions.targetId, input.targetId))
      if (input.actor) {
        await recordAudit(
          tx,
          input.actor,
          'map.consumption_policy.update',
          'target',
          input.targetId,
          input.reason ?? `授予对照资格 ${input.reportId}`,
        )
      }
    }
  })
}

/** Called in the same fact-ledger transaction that writes a user-confirmed counterexample. */
export async function suspendMapConsumptionEligibilityForWrongMatchTx(
  tx: Db,
  input: { targetId: string; decisionId: string; reason: string },
): Promise<void> {
  const { mapConsumptionEligibilitySuspensions, mapSelectionDecisions, targets } = schemaFor(tx)
  await locked(tx, tx.select().from(targets).where(eq(targets.id, input.targetId)))
  const [decision] = await tx
    .select({ targetId: mapSelectionDecisions.targetId, decision: mapSelectionDecisions.decisionKind, mode: mapSelectionDecisions.consumptionMode })
    .from(mapSelectionDecisions)
    .where(eq(mapSelectionDecisions.id, input.decisionId))
    .limit(1)
  if (!decision || decision.targetId !== input.targetId || decision.decision !== 'selected' || decision.mode !== 'read_only_fallback') {
    mapTargetMismatch('确认错配必须关联一次已选定的只读候选')
  }
  const now = await clockNow(tx)
  const [existing] = await locked(
    tx,
    tx.select().from(mapConsumptionEligibilitySuspensions).where(eq(mapConsumptionEligibilitySuspensions.targetId, input.targetId)),
  )
  if (existing) return
  try {
    await insertRows(tx, mapConsumptionEligibilitySuspensions, {
      id: newId(),
      targetId: input.targetId,
      decisionId: input.decisionId,
      reason: input.reason,
      suspendedAt: now,
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }
}

export async function updateMapConsumptionPolicy(
  db: Db,
  targetId: string,
  body: MapConsumptionPolicyUpdateBody,
  actor: ExecutionActor,
): Promise<MapConsumptionPolicyDto> {
  const parsed = mapConsumptionPolicyUpdateBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { targets, mapConsumptionPolicies, mapConsumptionPolicyCommands } = schemaFor(tx)
    // Serialize even the first policy and command, when there is no policy row to lock.
    await locked(tx, tx.select().from(targets).where(eq(targets.id, targetId)))
    const [receipt] = await tx
      .select()
      .from(mapConsumptionPolicyCommands)
      .where(
        and(
          eq(mapConsumptionPolicyCommands.targetId, targetId),
          eq(mapConsumptionPolicyCommands.commandKey, parsed.idempotencyKey),
        ),
      )
      .limit(1)
    const payload = { body: parsed }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) mapCommandIdempotencyConflict()
      return mapConsumptionPolicyDtoSchema.parse(receipt.result)
    }
    const [current] = await locked(
      tx,
      tx.select().from(mapConsumptionPolicies).where(eq(mapConsumptionPolicies.targetId, targetId)),
    )
    const expected = current?.revision ?? 0
    if (expected !== parsed.expectedRevision) mapRevisionConflict('消费政策修订已变更')
    if (parsed.mode === 'read_only_fallback') {
      const eligibility = await latestEligibility(tx, targetId)
      const needed = parsed.allowedStepTypes ?? current?.allowedStepTypes ?? ['extract', 'assert']
    if (!eligibility || eligibility.suspendedAt || needed.some((type) => !eligibility.eligibleStepTypes.includes(type))) {
        mapConsumptionNotEligible()
      }
    }
    if (parsed.allowedAssetRefs?.some(ref => ref.targetId !== targetId)) mapTargetMismatch()
    const now = await clockNow(tx)
    const nextRevision = expected + 1
    const policy = mapConsumptionPolicySchema.parse({
      schemaVersion: 1,
      policyVersion: nextRevision,
      mode: parsed.mode,
      allowedStepTypes: parsed.allowedStepTypes ?? current?.allowedStepTypes ?? ['extract', 'assert'],
      allowedAssetRefs: parsed.allowedAssetRefs ?? current?.allowedAssetRefs ?? [],
      maxCandidateCount: parsed.maxCandidateCount ?? current?.maxCandidateCount ?? 2,
      maxResolveMs: parsed.maxResolveMs ?? current?.maxResolveMs ?? 1_000,
      maxExtraAiCalls: 0,
      onUnavailable: 'baseline',
    })
    const values = {
      policySchemaVersion: policy.schemaVersion,
      policyVersion: policy.policyVersion,
      consumptionMode: policy.mode,
      allowedStepTypes: policy.allowedStepTypes,
      allowedAssetRefs: policy.allowedAssetRefs,
      maxCandidateCount: policy.maxCandidateCount,
      maxResolveMs: policy.maxResolveMs,
      maxExtraAiCalls: 0,
      revision: nextRevision,
      updatedBy: actor.id,
      updatedAt: now,
    }
    if (current) {
      await tx.update(mapConsumptionPolicies).set(values).where(eq(mapConsumptionPolicies.targetId, targetId))
    } else {
      await tx.insert(mapConsumptionPolicies).values({ targetId, ...values })
    }
    const result = await getMapConsumptionPolicy(tx, targetId)
    await insertRows(tx, mapConsumptionPolicyCommands, {
      id: newId(),
      targetId,
      commandKey: parsed.idempotencyKey,
      payload,
      result,
      createdAt: now,
    })
    await recordAudit(
      tx as unknown as Db,
      actor,
      'map.consumption_policy.update',
      'target',
      targetId,
      `更新地图消费政策 ${expected}→${nextRevision}：${parsed.reason}`,
    )
    return result
  })
}

export async function hasReadyMapConsumptionWorker(db: Db): Promise<boolean> {
  const { workers } = schemaFor(db)
  const now = await clockNow(db)
  const rows = await db.select().from(workers).where(gt(workers.heartbeatExpiresAt, now))
  return rows.some(
    (row) => row.status === 'READY' && (row.protocolCapabilities ?? []).includes(MAP_CONSUMPTION_PROTOCOL),
  )
}

async function loadPublishedRelease(
  db: Db,
  targetId: string,
  releaseId?: string,
): Promise<{
  releaseId: string
  manifestDigest: string
  sourceWatermark: number
  manifest: ReturnType<typeof mapReleaseManifestSchema.parse>
}> {
  const { mapPublicationHeads, mapReleasePublications, mapReleases } = schemaFor(db)
  await locked(db, db.select().from(mapPublicationHeads).where(eq(mapPublicationHeads.targetId, targetId)))
  if (releaseId) {
    const [release] = await db.select().from(mapReleases).where(eq(mapReleases.id, releaseId)).limit(1)
    if (!release) mapReleaseNotFound()
    if (release.targetId !== targetId) mapTargetMismatch()
    const [publication] = await db
      .select()
      .from(mapReleasePublications)
      .where(eq(mapReleasePublications.releaseId, release.id))
      .limit(1)
    if (!publication || publication.publicationStatus !== 'published') mapReleaseWithdrawn()
    return {
      releaseId: release.id,
      manifestDigest: release.manifestDigest,
      sourceWatermark: release.sourceWatermark,
      manifest: mapReleaseManifestSchema.parse(release.manifest),
    }
  }
  const published = await db
    .select()
    .from(mapReleasePublications)
    .where(and(eq(mapReleasePublications.targetId, targetId), eq(mapReleasePublications.publicationStatus, 'published')))
    .orderBy(desc(mapReleasePublications.publishedAt), desc(mapReleasePublications.releaseId))
    .limit(1)
  if (!published[0]) mapReleaseNotPublished()
  const [release] = await db.select().from(mapReleases).where(eq(mapReleases.id, published[0]!.releaseId)).limit(1)
  if (!release) mapReleaseNotFound()
  return {
    releaseId: release.id,
    manifestDigest: release.manifestDigest,
    sourceWatermark: release.sourceWatermark,
    manifest: mapReleaseManifestSchema.parse(release.manifest),
  }
}

function freezeBindings(
  rows: Array<{
    stepId: string | null
    slotKey: string
    objectId: string | null
    implementationKey: string | null
    descriptorVersion: number | null
    targetId: string
    pageId: string | null
    assetRefKey: string
  }>,
  targetId: string,
  manifest: ReturnType<typeof mapReleaseManifestSchema.parse>,
  allowed: MapConsumptionPolicy['allowedAssetRefs'],
): MapFrozenBinding[] {
  const bindings: MapFrozenBinding[] = []
  for (const row of rows) {
    if (!row.stepId || !row.objectId || !row.implementationKey || row.descriptorVersion == null) continue
    const item = manifest.items.find(
      (entry) =>
        entry.objectId === row.objectId &&
        entry.implementationKey === row.implementationKey &&
        entry.descriptorVersion === row.descriptorVersion,
    )
    if (!item?.features?.locators) continue
    const assetRef = {
      targetId,
      objectId: row.objectId,
      implementationKey: row.implementationKey,
      descriptorVersion: row.descriptorVersion,
      ...(row.pageId ? { pageId: row.pageId } : {}),
    }
    if (
      allowed.length > 0 &&
      !allowed.some(
        (ref) =>
          ref.objectId === assetRef.objectId &&
          ref.implementationKey === assetRef.implementationKey &&
          ref.descriptorVersion === assetRef.descriptorVersion,
      )
    ) {
      continue
    }
    bindings.push({
      stepId: row.stepId,
      slotKey: row.slotKey,
      assetRef,
      bindingDigest: sha256Hex(
        canonicalJson({
          stepId: row.stepId,
          slotKey: row.slotKey,
          assetRef,
          descriptorVersion: row.descriptorVersion,
        }),
      ),
    })
  }
  return bindings
}

export async function freezeMapConsumptionTx(
  tx: Db,
  input: {
    targetId: string
    scenarioId: string
    scenarioVersionId: string
    override?: MapConsumptionOverride | null
    requireWorker?: boolean
  },
): Promise<FrozenMapConsumption> {
  const policyRow = await getMapConsumptionPolicy(tx, input.targetId)
  const policy = resolveMapConsumptionPolicy(policyRow.policy)
  if (input.override?.mode === 'off' || policy.mode === 'off') {
    return frozenMapConsumptionSchema.parse({ mode: 'off' })
  }
  if (policy.mode === 'read_only_fallback') {
    const eligibility = policyRow.eligibility
    if (!eligibility || eligibility.suspendedAt || policy.allowedStepTypes.some((type) => !eligibility.eligibleStepTypes.includes(type))) {
      mapConsumptionNotEligible()
    }
  }
  if (input.requireWorker !== false && !(await hasReadyMapConsumptionWorker(tx))) {
    mapConsumerUnavailable()
  }
  const release = await loadPublishedRelease(tx, input.targetId, input.override?.releaseId)
  if (release.manifest.targetId !== input.targetId || release.manifest.sourceWatermark !== release.sourceWatermark || sha256Hex(canonicalJson(release.manifest)) !== release.manifestDigest) {
    mapReleaseNotPublished('发布清单摘要不符')
  }
  const { mapScenarioBindings } = schemaFor(tx)
  const rows = await tx
    .select()
    .from(mapScenarioBindings)
    .where(
      and(
        eq(mapScenarioBindings.targetId, input.targetId),
        eq(mapScenarioBindings.scenarioId, input.scenarioId),
        eq(mapScenarioBindings.scopeKind, 'version'),
        eq(mapScenarioBindings.versionSlot, input.scenarioVersionId),
        eq(mapScenarioBindings.status, 'active'),
      ),
    )
  const bindings = freezeBindings(rows, input.targetId, release.manifest, policy.allowedAssetRefs)
  const frozen = frozenMapConsumptionSchema.parse({
    mode: policy.mode,
    releaseId: release.releaseId,
    targetId: input.targetId,
    manifestDigest: release.manifestDigest,
    sourceWatermark: release.sourceWatermark,
    policy,
    bindings,
    consumerVersion: MAP_CONSUMPTION_CONSUMER_VERSION,
    frozenAt: (await clockNow(tx)).toISOString(),
  })
  return frozen
}

export async function insertMapRunReleaseRefTx(
  tx: Db,
  input: { runId: string; frozen: FrozenMapConsumption },
) {
  if (input.frozen.mode === 'off') return
  const { mapRunReleaseRefs } = schemaFor(tx)
  await tx.insert(mapRunReleaseRefs).values({
    runId: input.runId,
    targetId: input.frozen.targetId,
    releaseId: input.frozen.releaseId,
    manifestDigest: input.frozen.manifestDigest,
    sourceWatermark: input.frozen.sourceWatermark,
    consumerVersion: input.frozen.consumerVersion,
    createdAt: await clockNow(tx),
  })
}

export type FrozenMapCandidate = {
  binding: MapFrozenBinding
  descriptor: TargetDescriptor
  condition?: ReturnType<typeof mapReleaseManifestSchema.parse>['items'][number]['condition']
  locatorConfirmed: boolean
}

export async function loadFrozenMapCandidates(
  db: Db,
  frozen: EnabledMapConsumption,
  stepId: string,
): Promise<{ digestOk: boolean; candidates: FrozenMapCandidate[] }> {
  const { mapReleases } = schemaFor(db)
  const [release] = await db.select().from(mapReleases).where(eq(mapReleases.id, frozen.releaseId)).limit(1)
  if (!release || release.targetId !== frozen.targetId || release.manifestDigest !== frozen.manifestDigest || release.sourceWatermark !== frozen.sourceWatermark) {
    return { digestOk: false, candidates: [] }
  }
  const manifest = mapReleaseManifestSchema.parse(release.manifest)
  if (manifest.targetId !== frozen.targetId || manifest.sourceWatermark !== frozen.sourceWatermark || sha256Hex(canonicalJson(manifest)) !== frozen.manifestDigest) {
    return { digestOk: false, candidates: [] }
  }
  const candidates: FrozenMapCandidate[] = []
  for (const binding of frozen.bindings.filter((item) => item.stepId === stepId)) {
    const item = manifest.items.find(
      (entry) =>
        entry.objectId === binding.assetRef.objectId &&
        entry.implementationKey === binding.assetRef.implementationKey &&
        entry.descriptorVersion === binding.assetRef.descriptorVersion,
    )
    if (!item?.features?.locators) continue
    candidates.push({
      binding,
      descriptor: item.features.locators,
      condition: item.condition,
      locatorConfirmed: Boolean(
        item.executable && ['VERIFIED', 'TRUSTED'].includes(item.lifecycle) &&
        !item.dimensions?.some(dimension => dimension.dimension === 'identity' && dimension.verdict === 'rejected') &&
        item.dimensions?.some((dimension) => dimension.dimension === 'locator' && dimension.verdict === 'confirmed'),
      ),
    })
  }
  return { digestOk: true, candidates }
}

/**
 * F only evaluates an adopted candidate against an observation already recorded
 * for the same Attempt.  It must not manufacture an observation after seeing a
 * successful fallback result.
 */
export async function findMapConsumptionAttemptObservation(
  db: Db,
  input: { targetId: string; runId: string; attemptId: string },
): Promise<{ observationId: string } | null> {
  const { mapObservations } = schemaFor(db)
  const [row] = await db
    .select({ observationId: mapObservations.id })
    .from(mapObservations)
    .where(and(
      eq(mapObservations.targetId, input.targetId),
      eq(mapObservations.sourceRunId, input.runId),
      eq(mapObservations.sourceAttemptId, input.attemptId),
    ))
    .orderBy(mapObservations.ingestSeq)
    .limit(1)
  return row ?? null
}

export async function appendMapSelectionDecision(
  db: Db,
  input: { grant: RunGrant; decision: MapSelectionDecision },
): Promise<MapSelectionDecision> {
  const decision = mapSelectionDecisionSchema.parse(input.decision)
  return atomic(db, async (tx) => {
  const { attempts, mapSelectionDecisions, runs, stepRuns, runLeases } = schemaFor(tx)
  const [run] = await locked(tx, tx.select().from(runs).where(eq(runs.id, decision.runId)))
  if (!run || run.targetId !== decision.targetId) mapTargetMismatch()
  await locked(tx, tx.select().from(runLeases).where(eq(runLeases.id, input.grant.leaseId)))
  if (input.grant.runId !== decision.runId || !(await verifyRunLeaseForWrite(tx, input.grant))) mapStaleOwner()
  const [stepRun] = await tx.select().from(stepRuns).where(eq(stepRuns.id, decision.stepRunId)).limit(1)
  if (!stepRun || stepRun.runId !== decision.runId) mapTargetMismatch('步骤运行不属于该 Run')
  const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, decision.attemptId)).limit(1)
  if (!attempt || attempt.stepRunId !== decision.stepRunId) mapTargetMismatch('Attempt 不属于该步骤')
  const [existing] = await tx.select().from(mapSelectionDecisions).where(and(
    eq(mapSelectionDecisions.attemptId, decision.attemptId),
    eq(mapSelectionDecisions.decisionOrdinal, decision.decisionOrdinal),
  )).limit(1)
  if (existing) {
    const { decisionId: _oldId, ...old } = mapSelectionDecisionSchema.parse(existing.payloadJson)
    const { decisionId: _newId, ...next } = decision
    if (canonicalJson(old) !== canonicalJson(next)) mapCommandIdempotencyConflict()
    return mapSelectionDecisionSchema.parse(existing.payloadJson)
  }
  if (run.deletedAt || run.cancelRequestedAt || run.status !== 'RUNNING' || attempt.status !== 'RUNNING') mapStaleOwner()
  const frozen = run.snapshot.mapConsumption
  if (!frozen || frozen.mode === 'off' || decision.mode !== frozen.mode ||
      decision.releaseId !== frozen.releaseId || decision.manifestDigest !== frozen.manifestDigest ||
      decision.policyVersion !== frozen.policy.policyVersion || decision.consumerVersion !== frozen.consumerVersion) {
    mapTargetMismatch('选择必须引用本次运行冻结的消费配置')
  }
  if (decision.assetRef && !frozen.bindings.some(binding => binding.stepId === stepRun.stepId &&
      canonicalJson(binding.assetRef) === canonicalJson(decision.assetRef))) mapTargetMismatch('选择不属于冻结绑定')
    await insertRows(tx, mapSelectionDecisions, {
      id: decision.decisionId,
      targetId: decision.targetId,
      runId: decision.runId,
      stepRunId: decision.stepRunId,
      attemptId: decision.attemptId,
      decisionOrdinal: decision.decisionOrdinal,
      releaseId: decision.releaseId,
      manifestDigest: decision.manifestDigest,
      policyVersion: decision.policyVersion,
      consumerVersion: decision.consumerVersion,
      assetRefKey: decision.assetRef ? mapAssetRefKey(decision.assetRef) : null,
      objectId: decision.assetRef?.objectId,
      implementationKey: decision.assetRef?.implementationKey,
      descriptorVersion: decision.assetRef?.descriptorVersion,
      conditionSnapshot: decision.conditionSnapshot,
      coverage: decision.coverage,
      baselineOutcome: decision.baselineOutcome,
      candidatesJson: decision.candidatesEvaluated,
      selectedDescriptorVersion: decision.selectedDescriptorVersion,
      selectedDescriptorDigest: decision.selectedDescriptorDigest,
      consumptionMode: decision.mode,
      decisionKind: decision.decision,
      reasonCode: decision.reasonCode,
      spentMs: decision.spentMs,
      extraAiCalls: 0,
      evidenceRefs: decision.evidenceRefs,
      payloadJson: decision,
    })
    return decision
  })
}

export async function listMapSelectionDecisions(
  db: Db,
  runId: string,
  query: MapDecisionListQuery,
) {
  const parsed = mapDecisionListQuerySchema.parse(query)
  const { mapSelectionDecisions, runs } = schemaFor(db)
  const [run] = await db.select({ id: runs.id, targetId: runs.targetId, deletedAt: runs.deletedAt }).from(runs).where(eq(runs.id, runId)).limit(1)
  if (!run || run.deletedAt) throw notFound('RUN_NOT_FOUND', '运行不存在')
  const filter = and(
    eq(mapSelectionDecisions.runId, runId),
    parsed.stepRunId ? eq(mapSelectionDecisions.stepRunId, parsed.stepRunId) : undefined,
    parsed.attemptId ? eq(mapSelectionDecisions.attemptId, parsed.attemptId) : undefined,
  )
  const [after] = parsed.cursor ? await db.select().from(mapSelectionDecisions)
    .where(and(filter, eq(mapSelectionDecisions.id, parsed.cursor))).limit(1) : []
  if (parsed.cursor && !after) mapTargetMismatch('决策游标不属于当前查询')
  const page = await db
    .select()
    .from(mapSelectionDecisions)
    // UUIDv7 provides a stable append order without JS Date truncating PostgreSQL
    // timestamp microseconds and repeating the cursor row on the next page.
    .where(and(filter, after ? gt(mapSelectionDecisions.id, after.id) : undefined))
    .orderBy(mapSelectionDecisions.id)
    .limit(parsed.limit + 1)
  const hasMore = page.length > parsed.limit
  const shown = hasMore ? page.slice(0, parsed.limit) : page
  return mapDecisionListResponseSchema.parse({
    items: shown.map((row) => mapSelectionDecisionSchema.parse(row.payloadJson)),
    nextCursor: hasMore ? shown.at(-1)!.id : undefined,
  })
}
