import { and, desc, eq, inArray, or } from 'drizzle-orm'
import {
  type AdoptionReceipt,
  type AuthoringOrigin,
  type CandidateRejectionReceipt,
  type CandidateReopenReceipt,
  type DigestManifest,
  type ExecutionActor,
  type GuardResults,
  type HealingPatch,
  type JsonValue,
  type PatchTargetRef,
  type RepairCandidate,
  type RepairCandidateStatus,
  type RepairSourceRunKind,
  type ValidationRefs,
  type ValidationScope,
} from '@cairn/shared'
import { applyPatchToDocument, computeTargetDigest, findStepInDocument } from '@cairn/authoring'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'
import { prepareTrialVersion } from '../runs/scenarios.js'
import { createRunWithSnapshot } from '../runs/runs.js'
import type { AuditActor } from '../audit/record.js'

export type DbHandle = object

export interface CreateRepairCandidateInput {
  candidateId: string
  scenarioId?: string
  runId?: string | null
  sourceAttemptId: string
  sourceTargetDigest?: string
  dedupeKey?: string
  sourceRunKind?: RepairSourceRunKind
  patchTargetRef: PatchTargetRef
  authoringOrigin?: AuthoringOrigin | null
  patch: HealingPatch
  hypothesis: string
  applicability?: string | null
  digestManifest: DigestManifest
  guardResults: GuardResults
  status?: RepairCandidateStatus
  validationScope?: ValidationScope
  validationRefs?: ValidationRefs | null
}

export interface CreateOrUpdateRepairCandidateInput {
  scenarioId: string
  runId?: string | null
  sourceAttemptId: string
  stepId?: string
  sourceTargetDigest?: string
  dedupeKey: string
  patch: HealingPatch
  hypothesis: string
  applicability?: string | null
  digestManifest: DigestManifest
  guardResults: GuardResults
  sourceRunKind?: RepairSourceRunKind
  authoringOrigin?: AuthoringOrigin | null
  patchTargetRef?: PatchTargetRef
}

function rowToRepairCandidate(row: any): RepairCandidate {
  const createdAtIso = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
  const updatedAtIso = row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt)
  const lastSeenAtIso = row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString() : String(row.lastSeenAt ?? updatedAtIso)

  return {
    id: row.id,
    candidateId: row.candidateId,
    scenarioId: row.scenarioId ?? row.patchTargetRef?.scenarioId ?? '00000000-0000-0000-0000-000000000000',
    runId: row.runId ?? undefined,
    sourceAttemptId: row.sourceAttemptId,
    sourceTargetDigest: row.sourceTargetDigest ?? row.patchTargetRef?.sourceTargetDigest ?? 'unknown',
    dedupeKey: row.dedupeKey ?? row.candidateId,
    observationCount: row.observationCount ?? 1,
    rejectedObservationCount: row.rejectedObservationCount ?? 0,
    lastSeenRunId: row.lastSeenRunId ?? row.runId ?? undefined,
    lastSeenAt: lastSeenAtIso,
    sourceRunKind: (row.sourceRunKind ?? 'published') as RepairSourceRunKind,
    patchTargetRef: row.patchTargetRef,
    authoringOrigin: row.authoringOrigin ?? undefined,
    patch: row.patch,
    hypothesis: row.hypothesis,
    applicability: row.applicability ?? undefined,
    digestManifest: row.digestManifest,
    guardResults: row.guardResults,
    status: row.status as RepairCandidateStatus,
    validationScope: row.validationScope,
    validationRefs: row.validationRefs ?? undefined,
    adoption: row.adoption ?? undefined,
    rejection: row.rejection ?? undefined,
    reopenHistory: row.reopenHistory ?? undefined,
    createdAt: createdAtIso,
    updatedAt: updatedAtIso,
  }
}

/**
 * 事务内创建或更新候选（精确去重：同 dedupeKey 活跃态累加观测，rejected 累加驳回观测，不自动复活）
 */
export async function createOrUpdateRepairCandidateTx(
  tx: any,
  input: CreateOrUpdateRepairCandidateInput,
): Promise<RepairCandidate> {
  const { repairCandidates } = schemaFor(tx)
  const now = new Date()

  const [existing] = await locked(
    tx,
    tx
      .select()
      .from(repairCandidates)
      .where(
        and(
          eq(repairCandidates.scenarioId, input.scenarioId),
          eq(repairCandidates.dedupeKey, input.dedupeKey),
          inArray(repairCandidates.status, ['proposed', 'blocked', 'validating', 'validated', 'rejected']),
        ),
      )
      .limit(1),
  )

  if (existing) {
    if (existing.status === 'rejected') {
      const nextRejectedCount = (existing.rejectedObservationCount ?? 0) + 1
      const nextObservationCount = (existing.observationCount ?? 1) + 1
      const [updated] = await updateRows(
        tx,
        repairCandidates,
        {
          observationCount: nextObservationCount,
          rejectedObservationCount: nextRejectedCount,
          lastSeenRunId: input.runId ?? null,
          lastSeenAt: now,
          updatedAt: now,
        },
        eq(repairCandidates.id, existing.id),
      )
      return rowToRepairCandidate(updated)
    }

    const nextObservationCount = (existing.observationCount ?? 1) + 1
    const [updated] = await updateRows(
      tx,
      repairCandidates,
      {
        observationCount: nextObservationCount,
        lastSeenRunId: input.runId ?? null,
        lastSeenAt: now,
        updatedAt: now,
      },
      eq(repairCandidates.id, existing.id),
    )
    return rowToRepairCandidate(updated)
  }

  const id = newId()
  const candidateId = `rep_${id.replace(/-/g, '').slice(0, 12)}`
  const status: RepairCandidateStatus = input.guardResults.overallPassed ? 'proposed' : 'blocked'

  const stepId = input.stepId ?? input.patchTargetRef?.stepId ?? 'unknown'
  const sourceTargetDigest = input.sourceTargetDigest ?? input.patchTargetRef?.sourceTargetDigest ?? 'unknown'
  const sourceRunKind = input.sourceRunKind ?? 'published'

  const patchTargetRef: PatchTargetRef = input.patchTargetRef ?? {
    kind: 'scenario',
    scenarioId: input.scenarioId,
    stepId,
    sourceDefinitionDigest: input.digestManifest.sourceDefinitionDigest,
    sourceTargetDigest,
  }

  const [inserted] = await insertRows(tx, repairCandidates, {
    id,
    candidateId,
    scenarioId: input.scenarioId,
    runId: input.runId ?? null,
    sourceAttemptId: input.sourceAttemptId,
    sourceTargetDigest,
    dedupeKey: input.dedupeKey,
    observationCount: 1,
    rejectedObservationCount: 0,
    lastSeenRunId: input.runId ?? null,
    lastSeenAt: now,
    sourceRunKind,
    patchTargetRef,
    authoringOrigin: input.authoringOrigin ?? null,
    patch: input.patch,
    hypothesis: input.hypothesis,
    applicability: input.applicability ?? null,
    digestManifest: input.digestManifest,
    guardResults: input.guardResults,
    status,
    validationScope: {
      locatorValid: false,
      stepPassed: false,
      outcomePassed: false,
      crossSampleStable: false,
    },
    validationRefs: null,
    adoption: null,
    rejection: null,
    reopenHistory: null,
    createdAt: now,
    updatedAt: now,
  })

  return rowToRepairCandidate(inserted)
}

export async function createRepairCandidate(
  handle: DbHandle,
  input: CreateRepairCandidateInput,
): Promise<RepairCandidate> {
  const db = handle as Db
  const { repairCandidates } = schemaFor(db)
  const id = newId()
  const status = input.status ?? (input.guardResults.overallPassed ? 'proposed' : 'blocked')
  const validationScope = input.validationScope ?? {
    locatorValid: false,
    stepPassed: false,
    outcomePassed: false,
    crossSampleStable: false,
  }

  const scenarioId = input.scenarioId ?? input.patchTargetRef.scenarioId
  if (!scenarioId) {
    throw badRequest('SCENARIO_ID_REQUIRED', '修复候选必须关联有效场景 ID')
  }

  const sourceTargetDigest = input.sourceTargetDigest ?? input.patchTargetRef.sourceTargetDigest ?? 'unknown'
  const dedupeKey = input.dedupeKey ?? input.candidateId
  const now = new Date()

  const [row] = await insertRows(db, repairCandidates, {
    id,
    candidateId: input.candidateId,
    scenarioId,
    runId: input.runId ?? null,
    sourceAttemptId: input.sourceAttemptId,
    sourceTargetDigest,
    dedupeKey,
    observationCount: 1,
    rejectedObservationCount: 0,
    lastSeenRunId: input.runId ?? null,
    lastSeenAt: now,
    sourceRunKind: input.sourceRunKind ?? 'published',
    patchTargetRef: input.patchTargetRef,
    authoringOrigin: input.authoringOrigin ?? null,
    patch: input.patch,
    hypothesis: input.hypothesis,
    applicability: input.applicability ?? null,
    digestManifest: input.digestManifest,
    guardResults: input.guardResults,
    status,
    validationScope,
    validationRefs: input.validationRefs ?? null,
    adoption: null,
    rejection: null,
    reopenHistory: null,
    createdAt: now,
    updatedAt: now,
  })

  return rowToRepairCandidate(row)
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function matchIdOrCandidateId(table: any, idOrCandidateId: string) {
  return UUID_REGEX.test(idOrCandidateId)
    ? or(eq(table.id, idOrCandidateId), eq(table.candidateId, idOrCandidateId))
    : eq(table.candidateId, idOrCandidateId)
}

export async function getRepairCandidate(
  handle: DbHandle,
  idOrCandidateId: string,
): Promise<RepairCandidate | null> {
  const db = handle as Db
  const { repairCandidates } = schemaFor(db)

  const [row] = await db
    .select()
    .from(repairCandidates)
    .where(matchIdOrCandidateId(repairCandidates, idOrCandidateId))
    .limit(1)

  return row ? rowToRepairCandidate(row) : null
}

export async function listRepairCandidatesByRun(
  handle: DbHandle,
  runId: string,
): Promise<RepairCandidate[]> {
  const db = handle as Db
  const { repairCandidates } = schemaFor(db)

  const rows = await db
    .select()
    .from(repairCandidates)
    .where(eq(repairCandidates.runId, runId))
    .orderBy(desc(repairCandidates.createdAt))

  return rows.map(rowToRepairCandidate)
}

export async function listRepairCandidatesByScenario(
  handle: DbHandle,
  scenarioId: string,
  filterOrStatus?: { status?: RepairCandidateStatus } | RepairCandidateStatus,
): Promise<RepairCandidate[]> {
  const db = handle as Db
  const { repairCandidates } = schemaFor(db)

  const status =
    typeof filterOrStatus === 'string'
      ? filterOrStatus
      : filterOrStatus?.status

  const conditions = [eq(repairCandidates.scenarioId, scenarioId)]
  if (status) {
    conditions.push(eq(repairCandidates.status, status))
  }

  const rows = await db
    .select()
    .from(repairCandidates)
    .where(and(...conditions))
    .orderBy(desc(repairCandidates.createdAt))

  return rows.map(rowToRepairCandidate)
}

export async function updateRepairCandidateValidation(
  handle: DbHandle,
  idOrCandidateId: string,
  validationScope: ValidationScope,
  validationRefs?: ValidationRefs | null,
): Promise<RepairCandidate> {
  const db = handle as Db
  const { repairCandidates } = schemaFor(db)

  const current = await getRepairCandidate(handle, idOrCandidateId)
  if (!current) {
    throw notFound('REPAIR_CANDIDATE_NOT_FOUND', '修复候选不存在')
  }

  const status: RepairCandidateStatus =
    validationScope.stepPassed && validationScope.outcomePassed ? 'validated' : 'validating'

  const [updated] = await updateRows(
    db,
    repairCandidates,
    {
      validationScope,
      validationRefs: validationRefs ?? current.validationRefs ?? null,
      status,
      updatedAt: new Date(),
    },
    eq(repairCandidates.id, current.id),
  )

  return rowToRepairCandidate(updated)
}

export async function markCandidateValidatingTx(
  tx: any,
  idOrCandidateId: string,
  validationRunId: string,
): Promise<RepairCandidate> {
  const { repairCandidates } = schemaFor(tx)
  const current = await getRepairCandidate(tx, idOrCandidateId)
  if (!current) {
    throw notFound('REPAIR_CANDIDATE_NOT_FOUND', '修复候选不存在')
  }

  const [updated] = await updateRows(
    tx,
    repairCandidates,
    {
      status: 'validating',
      validationRefs: {
        ...(current.validationRefs ?? {}),
        evidenceIds: current.validationRefs?.evidenceIds ?? [],
        validationRunId,
      },
      updatedAt: new Date(),
    },
    eq(repairCandidates.id, current.id),
  )

  return rowToRepairCandidate(updated)
}

export async function settleCandidateValidationTx(
  tx: any,
  input: {
    runId: string
    validationSubject: { candidateId: string; stepId: string }
    runStatus: string
    outcomeStatus?: string | null
    now: Date
  },
): Promise<void> {
  const { repairCandidates, stepRuns, attempts, evidences } = schemaFor(tx)
  const [candidate] = await tx
    .select()
    .from(repairCandidates)
    .where(matchIdOrCandidateId(repairCandidates, input.validationSubject.candidateId))
    .limit(1)

  if (!candidate) return

  // 仅对处于 validating / proposed 状态的候选进行验证结果写回（若已人工采纳或驳回则不回写）
  if (candidate.status !== 'validating' && candidate.status !== 'proposed') return

  const [stepRun] = await tx
    .select()
    .from(stepRuns)
    .where(and(eq(stepRuns.runId, input.runId), eq(stepRuns.stepId, input.validationSubject.stepId)))
    .limit(1)

  let stepPassed = false
  let locatorValid = false
  let lastAttemptId: string | undefined
  const evidenceIds: string[] = []

  if (stepRun) {
    const stepAttempts = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.stepRunId, stepRun.id))
      .orderBy(desc(attempts.attemptNo))

    const lastAttempt = stepAttempts[0]
    lastAttemptId = lastAttempt?.id

    if (stepRun.status === 'SUCCEEDED' && lastAttempt?.status === 'SUCCEEDED') {
      stepPassed = true
      if (lastAttemptId) {
        const logEvidences = await tx
          .select()
          .from(evidences)
          .where(and(eq(evidences.attemptId, lastAttemptId), eq(evidences.type, 'log')))

        for (const e of logEvidences) {
          evidenceIds.push(e.id)
          const payload = e.payload as any
          if (payload && Array.isArray(payload.candidatesTried)) {
            const firstTry = payload.candidatesTried[0]
            if (firstTry && firstTry.matches === 1 && payload.resolvedVia !== 'ai') {
              locatorValid = true
            }
          }
        }
      }
    }
  }

  const outcomePassed = input.outcomeStatus === 'PASS' || (input.runStatus === 'SUCCEEDED' && input.outcomeStatus !== 'FAIL')
  const passed = Boolean(stepPassed && locatorValid && outcomePassed)

  const newStatus: RepairCandidateStatus = passed ? 'validated' : 'proposed'
  const validationScope: ValidationScope = {
    locatorValid,
    stepPassed,
    outcomePassed,
    crossSampleStable: false,
  }
  const validationRefs: ValidationRefs = {
    validationRunId: input.runId,
    validationAttemptId: lastAttemptId,
    evidenceIds,
  }

  await updateRows(
    tx,
    repairCandidates,
    {
      status: newStatus,
      validationScope,
      validationRefs,
      updatedAt: input.now,
    },
    eq(repairCandidates.id, candidate.id),
  )
}


export async function updateRepairCandidateStatus(
  handle: DbHandle,
  idOrCandidateId: string,
  status: RepairCandidateStatus,
): Promise<RepairCandidate> {
  const db = handle as Db
  const { repairCandidates } = schemaFor(db)

  const current = await getRepairCandidate(handle, idOrCandidateId)
  if (!current) {
    throw notFound('REPAIR_CANDIDATE_NOT_FOUND', '修复候选不存在')
  }

  const [updated] = await updateRows(
    db,
    repairCandidates,
    {
      status,
      updatedAt: new Date(),
    },
    eq(repairCandidates.id, current.id),
  )

  return rowToRepairCandidate(updated)
}

export async function rejectRepairCandidate(
  handle: DbHandle,
  idOrCandidateId: string,
  actorOrOptions: string | { actor: string; reason?: string },
  reasonParam?: string,
): Promise<RepairCandidate> {
  const db = handle as Db
  const { repairCandidates } = schemaFor(db)
  const now = new Date()

  const current = await getRepairCandidate(handle, idOrCandidateId)
  if (!current) {
    throw notFound('REPAIR_CANDIDATE_NOT_FOUND', '修复候选不存在')
  }

  const actorId = typeof actorOrOptions === 'string' ? actorOrOptions : actorOrOptions.actor
  const reason = typeof actorOrOptions === 'string' ? reasonParam : (actorOrOptions.reason ?? reasonParam)

  const rejection: CandidateRejectionReceipt = {
    rejectedAt: now.toISOString(),
    rejectedBy: actorId,
    reason: reason ?? undefined,
  }

  const [updated] = await updateRows(
    db,
    repairCandidates,
    {
      status: 'rejected',
      rejection,
      updatedAt: now,
    },
    eq(repairCandidates.id, current.id),
  )

  return rowToRepairCandidate(updated)
}

export async function reopenRepairCandidate(
  handle: DbHandle,
  idOrCandidateId: string,
  actorOrOptions: string | { actor: string },
): Promise<RepairCandidate> {
  const db = handle as Db
  const { repairCandidates } = schemaFor(db)
  const now = new Date()

  const current = await getRepairCandidate(handle, idOrCandidateId)
  if (!current) {
    throw notFound('REPAIR_CANDIDATE_NOT_FOUND', '修复候选不存在')
  }

  if (current.status !== 'rejected') {
    throw conflict('REPAIR_CANDIDATE_NOT_REOPENABLE', `候选状态为「${current.status}」，仅已驳回的候选可重新打开`)
  }

  const actorId = typeof actorOrOptions === 'string' ? actorOrOptions : actorOrOptions.actor

  const reopenHistory: CandidateReopenReceipt[] = [
    ...(current.reopenHistory ?? []),
    {
      reopenedAt: now.toISOString(),
      reopenedBy: actorId,
    },
  ]

  const [updated] = await updateRows(
    db,
    repairCandidates,
    {
      status: 'proposed',
      rejectedObservationCount: 0,
      reopenHistory,
      updatedAt: now,
    },
    eq(repairCandidates.id, current.id),
  )

  return rowToRepairCandidate(updated)
}

function findStepTargetInDocument(doc: any, stepId: string): unknown {
  const step = findStepInDocument(doc, stepId)
  return step?.input && 'target' in step.input ? step.input.target : undefined
}

function forceStepDeterministic(step: any) {
  if (!step) return
  if (step.policy?.locatorPlan) {
    step.policy = { ...step.policy, locatorPlan: { order: ['rule'], limits: ['rule'] } }
  } else {
    step.policy = { ...step.policy, resolution: 'deterministic_only' }
  }
}

function setStepDeterministicInDoc(doc: any, stepId: string): any {
  const cloned = JSON.parse(JSON.stringify(doc))
  if (Array.isArray(cloned?.nodes)) {
    function searchNodes(nodes: any[]): boolean {
      for (const node of nodes) {
        if (node?.kind === 'step' && node.step?.id === stepId) {
          forceStepDeterministic(node.step)
          return true
        }
        if (node?.kind === 'block') {
          if (Array.isArray(node.then) && searchNodes(node.then)) return true
          if (Array.isArray(node.else) && searchNodes(node.else)) return true
          if (Array.isArray(node.body) && searchNodes(node.body)) return true
        }
      }
      return false
    }
    searchNodes(cloned.nodes)
  }
  if (Array.isArray(cloned?.steps)) {
    const s = cloned.steps.find((item: any) => item?.id === stepId)
    if (s) forceStepDeterministic(s)
  }
  return cloned
}

export interface ValidateRepairCandidateInput {
  targetAccountId?: string
  input?: Record<string, JsonValue>
  actor: AuditActor
  hangWaitMs?: number
  executableTypes?: readonly string[]
}

export async function validateRepairCandidate(
  handle: DbHandle,
  idOrCandidateId: string,
  options: ValidateRepairCandidateInput,
): Promise<{ candidate: RepairCandidate; runId: string }> {
  const db = handle as Db

  return await atomic(db, async (tx: any) => {
    const { repairCandidates, scenarioDrafts } = schemaFor(tx)

    const [candRow] = await locked(
      tx,
      tx
        .select()
        .from(repairCandidates)
        .where(matchIdOrCandidateId(repairCandidates, idOrCandidateId))
        .limit(1),
    )

    if (!candRow) {
      throw notFound('REPAIR_CANDIDATE_NOT_FOUND', '修复候选不存在')
    }

    if (candRow.status === 'rejected' || candRow.status === 'adopted' || candRow.status === 'expired') {
      throw conflict('REPAIR_CANDIDATE_NOT_VALIDATABLE', `候选状态为「${candRow.status}」，不可发起验证试跑`)
    }

    const targetRef = candRow.patchTargetRef as PatchTargetRef
    if (targetRef.kind !== 'scenario' || !candRow.scenarioId) {
      throw badRequest('UNSUPPORTED_TARGET_KIND', '当前仅支持场景类型的修复验证')
    }

    const [draft] = await locked(
      tx,
      tx
        .select()
        .from(scenarioDrafts)
        .where(eq(scenarioDrafts.scenarioId, candRow.scenarioId))
        .limit(1),
    )

    if (!draft) {
      throw notFound('SCENARIO_DRAFT_NOT_FOUND', '场景草稿不存在')
    }

    // 校验草稿中该步骤存在且当前的 target 摘要仍等于候选来源摘要，防草稿本步骤漂移
    const currentStep = findStepInDocument(draft.document, targetRef.stepId)
    if (!currentStep) {
      throw notFound('STEP_NOT_FOUND', '草稿中未找到目标步骤')
    }
    if (candRow.sourceTargetDigest && candRow.sourceTargetDigest !== 'unknown') {
      const currentTarget = currentStep.input && 'target' in currentStep.input ? currentStep.input.target : undefined
      const currentTargetDigest = currentTarget ? computeTargetDigest(currentTarget) : undefined
      if (currentTargetDigest !== candRow.sourceTargetDigest) {
        throw conflict(
          'REPAIR_CANDIDATE_STALE',
          '草稿中这一步已被修改，请在 Studio 中重新确认',
          {
            expectedTargetDigest: candRow.sourceTargetDigest,
            currentTargetDigest,
          },
        )
      }
    }

    // 叠加补丁
    const patchedDoc = applyPatchToDocument(draft.document, targetRef.stepId, candRow.patch as HealingPatch)
    // 强制被修补步骤的解析策略为 deterministic_only
    const deterministicPatchedDoc = setStepDeterministicInDoc(patchedDoc, targetRef.stepId)

    // 编译 Trial 版本
    const prepared = await prepareTrialVersion(tx, candRow.scenarioId, {
      revision: draft.revision,
      runInput: options.input ?? {},
      actor: options.actor,
      overrideDocument: deterministicPatchedDoc,
      executableTypes: options.executableTypes,
    })

    const executionActor: ExecutionActor =
      'kind' in options.actor && options.actor.kind === 'service' && 'credentialId' in options.actor && 'scopes' in options.actor
        ? (options.actor as ExecutionActor)
        : { kind: 'console', id: options.actor.id }

    // 创建带有 validationSubject 的 trial run
    const runResult = await createRunWithSnapshot(tx, {
      scenarioId: candRow.scenarioId,
      scenarioVersionId: prepared.versionId,
      targetAccountId: options.targetAccountId,
      input: options.input,
      actor: executionActor,
      hangWaitMs: options.hangWaitMs,
      allowTrialVersion: true,
      debugMode: 'runThrough',
      validationSubject: {
        candidateId: candRow.candidateId,
        stepId: targetRef.stepId,
      },
    })

    // 标记候选为 validating 并关联 validationRunId
    const updatedCandidate = await markCandidateValidatingTx(tx, candRow.id, runResult.detail.id)

    return {
      candidate: updatedCandidate,
      runId: runResult.detail.id,
    }
  })
}

export interface AdoptRepairCandidateOptions {
  idOrCandidateId: string
  expectedRevision: number
  adoptedBy: string
}

export async function adoptRepairCandidate(
  handle: DbHandle,
  options: { idOrCandidateId: string; expectedRevision: number; adoptedBy: string },
): Promise<{ candidate: RepairCandidate; draftRevision: number }> {
  const db = handle as Db

  return await atomic(db, async (tx: any) => {
    const { repairCandidates, scenarioDrafts } = schemaFor(tx)

    const [candRow] = await locked(
      tx,
      tx
        .select()
        .from(repairCandidates)
        .where(matchIdOrCandidateId(repairCandidates, options.idOrCandidateId))
        .limit(1),
    )

    if (!candRow) {
      throw notFound('REPAIR_CANDIDATE_NOT_FOUND', '修复候选不存在')
    }

    if (candRow.status !== 'proposed' && candRow.status !== 'validated' && candRow.status !== 'validating') {
      throw conflict('REPAIR_CANDIDATE_NOT_ADOPTABLE', `候选当前状态为「${candRow.status}」，不可采纳`)
    }

    const targetRef = candRow.patchTargetRef as PatchTargetRef
    if (targetRef.kind !== 'scenario' || !candRow.scenarioId) {
      throw badRequest('UNSUPPORTED_TARGET_KIND', '当前仅支持场景类型的修复采纳')
    }

    const [draft] = await locked(
      tx,
      tx
        .select()
        .from(scenarioDrafts)
        .where(eq(scenarioDrafts.scenarioId, candRow.scenarioId))
        .limit(1),
    )

    if (!draft) {
      throw notFound('SCENARIO_DRAFT_NOT_FOUND', '场景草稿不存在')
    }

    if (draft.revision !== options.expectedRevision) {
      throw conflict('SCENARIO_DRAFT_CONFLICT', '场景草稿已被更新，版本冲突', {
        currentRevision: draft.revision,
        expectedRevision: options.expectedRevision,
      })
    }

    // 校验草稿中该步骤存在且当前的 target 摘要仍等于候选来源摘要，防草稿本步骤漂移
    const currentStep = findStepInDocument(draft.document, targetRef.stepId)
    if (!currentStep) {
      throw notFound('STEP_NOT_FOUND', '草稿中未找到目标步骤')
    }
    if (candRow.sourceTargetDigest && candRow.sourceTargetDigest !== 'unknown') {
      const currentTarget = currentStep.input && 'target' in currentStep.input ? currentStep.input.target : undefined
      const currentTargetDigest = currentTarget ? computeTargetDigest(currentTarget) : undefined
      if (currentTargetDigest !== candRow.sourceTargetDigest) {
        throw conflict(
          'REPAIR_CANDIDATE_STALE',
          '草稿中这一步已被修改，请在 Studio 中重新确认',
          {
            expectedTargetDigest: candRow.sourceTargetDigest,
            currentTargetDigest,
          },
        )
      }
    }

    // 使用统一的纯函数应用补丁，同时支持 V1 与 V2 草稿
    const patchedDoc = applyPatchToDocument(draft.document, targetRef.stepId, candRow.patch as HealingPatch)
    const nextRevision = draft.revision + 1
    const now = new Date()

    await updateRows(
      tx,
      scenarioDrafts,
      {
        document: patchedDoc,
        revision: nextRevision,
        updatedAt: now,
      },
      eq(scenarioDrafts.scenarioId, candRow.scenarioId),
    )

    const adoption: AdoptionReceipt = {
      expectedRevision: options.expectedRevision,
      resultingRevision: nextRevision,
      targetKind: 'scenario',
      targetId: candRow.scenarioId,
      adoptedAt: now.toISOString(),
      adoptedBy: options.adoptedBy,
      receiptId: newId(),
    }

    const [updatedCandidateRow] = await updateRows(
      tx,
      repairCandidates,
      {
        status: 'adopted',
        adoption,
        updatedAt: now,
      },
      eq(repairCandidates.id, candRow.id),
    )

    return {
      candidate: rowToRepairCandidate(updatedCandidateRow),
      draftRevision: nextRevision,
    }
  })
}

/**
 * 场景发布时检查未关闭候选，若步骤定位器已改变则置为 expired
 */
export async function expireRepairCandidatesOnPublishTx(
  tx: any,
  scenarioId: string,
  publishedDoc?: any,
): Promise<number> {
  const { repairCandidates } = schemaFor(tx)
  const activeCandidates = await tx
    .select()
    .from(repairCandidates)
    .where(
      and(
        eq(repairCandidates.scenarioId, scenarioId),
        inArray(repairCandidates.status, ['proposed', 'blocked', 'validating', 'validated']),
      ),
    )

  if (!activeCandidates.length) return 0

  let expiredCount = 0
  const now = new Date()

  for (const cand of activeCandidates) {
    let shouldExpire = false

    if (!publishedDoc) {
      shouldExpire = true
    } else {
      const targetRef = cand.patchTargetRef as PatchTargetRef
      const newTarget = findStepTargetInDocument(publishedDoc, targetRef.stepId)
      if (!newTarget) {
        shouldExpire = true
      } else {
        const newTargetDigest = computeTargetDigest(newTarget)
        if (cand.sourceTargetDigest && newTargetDigest !== cand.sourceTargetDigest) {
          shouldExpire = true
        }
      }
    }

    if (shouldExpire) {
      await updateRows(
        tx,
        repairCandidates,
        {
          status: 'expired',
          updatedAt: now,
        },
        eq(repairCandidates.id, cand.id),
      )
      expiredCount++
    }
  }

  return expiredCount
}
