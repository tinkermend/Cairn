import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import {
  classifyValidationSample,
  deriveOutcomeManifest,
  deriveRuntimeInvariantManifest,
  validationRunDigests,
  validationSubjectDigest,
  type ExpansionResult,
} from '@cairn/authoring'
import {
  AI_ATOMIC_ACTIONS_PROTOCOL,
  IMPORTED_OUTCOME_PROTOCOL,
  VALIDATION_SUBJECT_PROTOCOL,
  normalizeAuthoringDocument,
  scenarioValidationSchema,
  type RunSnapshot,
  type ScenarioAuthoringDocumentV2,
  type ScenarioValidationSample,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { clockNow, locked, schemaFor } from '../native.js'
import { assertTargetPermission } from '../console/target-authorization.js'
import { conflict, notFound } from './errors.js'
import { expandWithLoader } from './scenarios.js'

export async function draftValidationSubject(
  tx: Db,
  targetId: string,
  scenarioId: string,
  document: ScenarioAuthoringDocumentV2,
  expansion: ExpansionResult,
): Promise<string> {
  if (!expansion.definition || !expansion.ok)
    throw conflict('SCENARIO_COMPILE_BLOCKED', '定义未通过编译')
  const { mapScenarioBindings: bindings } = schemaFor(tx)
  const refs = await tx
    .select()
    .from(bindings)
    .where(
      and(
        eq(bindings.scenarioId, scenarioId),
        eq(bindings.targetId, targetId),
        inArray(bindings.scopeKind, ['draft', 'page_context']),
        eq(bindings.status, 'active'),
      ),
    )
  const ids = new Set(expansion.definition.steps.map((step) => step.id))
  return validationSubjectDigest({
    targetId,
    document,
    definition: expansion.definition,
    moduleManifest: expansion.manifest,
    outcomeManifest: expansion.outcomeManifest,
    runtimeInvariantManifest: expansion.runtimeInvariantManifest,
    mapReferences: refs
      .filter((row) => !row.stepId || ids.has(row.stepId))
      .map((row) => ({
        slotKey: row.slotKey,
        stepId: row.stepId,
        assetRefKey: row.assetRefKey,
        pageId: row.pageId,
        objectId: row.objectId,
        implementationKey: row.implementationKey,
        descriptorVersion: row.descriptorVersion,
        descriptorDigest: row.descriptorDigest,
        basis: row.basis,
        resolution: row.resolution,
      })),
  })
}

export async function saveValidationSubjectTx(tx: Db, versionId: string, digest: string) {
  const { scenarioValidationSubjects: subjects } = schemaFor(tx)
  await tx.insert(subjects).values({
    scenarioVersionId: versionId,
    protocolVersion: VALIDATION_SUBJECT_PROTOCOL,
    subjectDigest: digest,
  })
}

export async function saveRunValidationContextTx(tx: Db, snapshot: RunSnapshot) {
  const {
    scenarioValidationSubjects: subjects,
    scenarioVersions: versions,
    runValidationContexts: contexts,
  } = schemaFor(tx)
  const [version] = await tx
    .select({ kind: versions.kind, subjectDigest: subjects.subjectDigest })
    .from(versions)
    .innerJoin(subjects, eq(subjects.scenarioVersionId, versions.id))
    .where(eq(versions.id, snapshot.scenarioVersionId))
    .limit(1)
  if (!version || version.kind !== 'trial') return
  await tx.insert(contexts).values({
    runId: snapshot.runId,
    subjectDigest: version.subjectDigest,
    ...validationRunDigests(snapshot),
    provenance: 'full_trial',
    interventions: [],
  })
}

/** A provenance side record survives clearing the live debug overlay. Caller already owns the Run lock. */
export async function markValidationInterventionTx(tx: Db, runId: string, reason: string) {
  const { runValidationContexts: contexts } = schemaFor(tx)
  const [row] = await locked(
    tx,
    tx.select().from(contexts).where(eq(contexts.runId, runId)).limit(1),
  )
  if (!row || row.interventions.includes(reason)) return
  await tx
    .update(contexts)
    .set({ provenance: 'intervened', interventions: [...row.interventions, reason] })
    .where(eq(contexts.runId, runId))
}

/** Rollout guard supplements claim filtering; an old binary does not know new snapshot fields. */
export async function assertDemonstrationExecutorRolloutTx(tx: Db, snapshot: RunSnapshot) {
  const required = [
    snapshot.aiAtomicActionsProtocol ? AI_ATOMIC_ACTIONS_PROTOCOL : null,
    snapshot.importedOutcomeProtocol ? IMPORTED_OUTCOME_PROTOCOL : null,
  ].filter((v): v is NonNullable<typeof v> => v !== null)
  if (!required.length) return
  const { workers } = schemaFor(tx)
  const now = await clockNow(tx)
  const live = await tx
    .select()
    .from(workers)
    .where(inArray(workers.status, ['READY', 'DRAINING']))
  const incompatible = live.some(
    (worker) =>
      worker.capacity > 0 &&
      (worker.heartbeatExpiresAt?.getTime() ??
        worker.heartbeatAt.getTime() + (worker.lostAfterSeconds ?? 60) * 1000) > now.getTime() &&
      required.some((capability) => !worker.protocolCapabilities.includes(capability)),
  )
  if (incompatible)
    throw conflict(
      'DEMONSTRATION_EXECUTOR_UPGRADE_REQUIRED',
      '请先排空并升级所有仍在线的执行 Worker，再运行新示教协议',
    )
}

export async function getScenarioValidation(db: Db, scenarioId: string, actorId: string) {
  const {
    scenarios,
    scenarioDrafts: drafts,
    scenarioVersions: versions,
    scenarioValidationSubjects: subjects,
    runValidationContexts: contexts,
    runs,
    stepRuns,
    attempts,
    outcomeResults,
    runEvents,
  } = schemaFor(db)
  const [scenario] = await db
    .select()
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), isNull(scenarios.deletedAt)))
    .limit(1)
  if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  await assertTargetPermission(db, actorId, scenario.targetId, 'workflow:read')
  await assertTargetPermission(db, actorId, scenario.targetId, 'run:read')
  await assertTargetPermission(db, actorId, scenario.targetId, 'target:read')
  const [draft] = await db.select().from(drafts).where(eq(drafts.scenarioId, scenarioId)).limit(1)
  if (!draft) throw notFound('SCENARIO_NOT_FOUND', '草稿不存在')
  const document = normalizeAuthoringDocument(draft.document)
  const expansion = await expandWithLoader(db, scenario.targetId, document, 'preview', true)
  const subjectDigest = expansion.ok
    ? await draftValidationSubject(db, scenario.targetId, scenarioId, document, expansion)
    : null
  const [published] = await db
    .select({ digest: subjects.subjectDigest })
    .from(versions)
    .leftJoin(subjects, eq(subjects.scenarioVersionId, versions.id))
    .where(and(eq(versions.scenarioId, scenarioId), eq(versions.kind, 'published')))
    .orderBy(desc(versions.versionNo))
    .limit(1)
  const sampleLimit = 50
  const rows = await db
    .select({ run: runs, context: contexts })
    .from(runs)
    .innerJoin(versions, eq(versions.id, runs.scenarioVersionId))
    .leftJoin(contexts, eq(contexts.runId, runs.id))
    .where(and(eq(runs.scenarioId, scenarioId), eq(versions.kind, 'trial'), isNull(runs.deletedAt)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(sampleLimit)
  const ids = rows.map((row) => row.run.id)
  const steps = ids.length
    ? await db.select().from(stepRuns).where(inArray(stepRuns.runId, ids))
    : []
  const stepIds = steps.map((s) => s.id)
  const tried = stepIds.length
    ? await db
        .select()
        .from(attempts)
        .where(inArray(attempts.stepRunId, stepIds))
        .orderBy(desc(attempts.attemptNo))
    : []
  const outcomes = ids.length
    ? await db.select().from(outcomeResults).where(inArray(outcomeResults.runId, ids))
    : []
  // A recovered/human-assisted run needs a new full trial; immutable history stays visible.
  const recovery = ids.length
    ? await db
        .select({ runId: runEvents.runId, type: runEvents.type })
        .from(runEvents)
        .where(and(inArray(runEvents.runId, ids), inArray(runEvents.type, ['run.auth_recovered'])))
    : []
  const samples: ScenarioValidationSample[] = rows.map(({ run, context }) => {
    const snapshot = run.snapshot as RunSnapshot
    const runSteps = steps.filter((s) => s.runId === run.id)
    const latest = new Map<string, (typeof tried)[number]>()
    for (const attempt of tried)
      if (!latest.has(attempt.stepRunId)) latest.set(attempt.stepRunId, attempt)
    const manifests = snapshot.outcomeManifest?.entries ?? []
    const conditionStatuses = manifests.map((entry) => {
      const step = runSteps.find((s) => s.stepId === entry.stepId)
      const attempt = step ? latest.get(step.id) : undefined
      return (
        outcomes.find(
          (o) =>
            o.runId === run.id && o.contractId === entry.contractId && o.attemptId === attempt?.id,
        )?.verdict ?? 'NOT_EVALUATED'
      )
    })
    const interventions = [
      ...(context?.interventions ?? []),
      ...(recovery.some((r) => r.runId === run.id) ? ['authentication_recovery'] : []),
    ]
    const result = classifyValidationSample({
      hasContext: Boolean(context),
      matchesSubject: context?.subjectDigest === subjectDigest,
      status: run.status,
      outcomeStatus: run.outcomeStatus,
      evidenceStatus: run.evidenceStatus,
      fullyExecuted:
        runSteps.length === snapshot.steps.length &&
        runSteps.every(
          (step) => step.status === 'SUCCEEDED' && latest.get(step.id)?.status === 'SUCCEEDED',
        ),
      interventions,
      requiredConditions: manifests.filter(
        (m) => m.severity === 'MUST' && m.provenance !== 'runtime_invariant',
      ).length,
      conditionStatuses,
    })
    return {
      runId: run.id,
      scenarioVersionId: run.scenarioVersionId,
      targetAccountId: run.targetAccountId,
      createdAt: run.createdAt.toISOString(),
      ...result,
      executionStatus: run.status,
      outcomeStatus: run.outcomeStatus,
      evidenceStatus: run.evidenceStatus,
      subjectDigest: context?.subjectDigest ?? null,
      executionScopeDigest: context?.executionScopeDigest ?? null,
      inputDigest: context?.inputDigest ?? null,
      platformConfigRevision: snapshot.platformConfigRevision ?? null,
      modelName: snapshot.aiExecution?.modelName ?? null,
    }
  })
  const matching = samples.filter(
    (sample) => sample.subjectDigest === subjectDigest && subjectDigest !== null,
  )
  return scenarioValidationSchema.parse({
    scenarioId,
    revision: draft.revision,
    subjectDigest,
    publishedSubjectDigest: published?.digest ?? null,
    state: matching[0]?.state ?? (samples.length ? 'stale' : 'not_run'),
    samples,
    sampleLimit,
    diagnostics: expansion.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
  })
}
