import { desc, eq, or } from 'drizzle-orm'
import {
  type AdoptionReceipt,
  type AuthoringOrigin,
  type DigestManifest,
  type GuardResults,
  type HealingPatch,
  type PatchTargetRef,
  type RepairCandidate,
  type RepairCandidateStatus,
  type ValidationRefs,
  type ValidationScope,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { newId } from '../id.js'
import { atomic, insertRows, locked, schemaFor, updateRows } from '../native.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'

export type DbHandle = object

export interface CreateRepairCandidateInput {
  candidateId: string
  runId: string
  sourceAttemptId: string
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

function rowToRepairCandidate(row: any): RepairCandidate {
  return {
    id: row.id,
    candidateId: row.candidateId,
    runId: row.runId,
    sourceAttemptId: row.sourceAttemptId,
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
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  }
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

  const [row] = await insertRows(db, repairCandidates, {
    id,
    candidateId: input.candidateId,
    runId: input.runId,
    sourceAttemptId: input.sourceAttemptId,
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

function applyPatchToScenarioDocument(document: any, stepId: string, patch: HealingPatch): any {
  const doc = JSON.parse(JSON.stringify(document))
  if (!Array.isArray(doc.steps)) {
    throw badRequest('SCENARIO_DOCUMENT_INVALID', '场景文档缺少有效 steps 列表')
  }

  const stepIndex = doc.steps.findIndex((s: any) => s.id === stepId)
  if (stepIndex === -1) {
    throw badRequest('STEP_NOT_FOUND', `未在草稿中找到待修复步骤「${stepId}」`)
  }

  const targetStep = doc.steps[stepIndex]

  if (patch.kind === 'REPLACE_LOCATOR') {
    if (patch.targetDescriptor) {
      targetStep.input = { ...targetStep.input, target: patch.targetDescriptor }
    } else if (patch.suggestedCandidate) {
      targetStep.input = {
        ...targetStep.input,
        target: {
          framePath: [],
          candidates: [patch.suggestedCandidate],
        },
      }
    }
  } else if (patch.kind === 'ADD_CANDIDATE') {
    if (patch.suggestedCandidate) {
      const currentTarget = targetStep.input?.target ?? { framePath: [], candidates: [] }
      const candidates = Array.isArray(currentTarget.candidates) ? [...currentTarget.candidates] : []
      candidates.push(patch.suggestedCandidate)
      targetStep.input = {
        ...targetStep.input,
        target: { ...currentTarget, framePath: currentTarget.framePath ?? [], candidates },
      }
    }
  } else if (patch.kind === 'PREPEND_WAIT') {
    const waitStep = {
      id: newId(),
      name: '修复前置等待',
      type: 'wait',
      input: {
        kind: 'duration',
        timeoutMs: patch.suggestedWaitMs ?? 2000,
      },
    }
    doc.steps.splice(stepIndex, 0, waitStep)
  } else if (patch.kind === 'UPGRADE_TO_AI_STEP') {
    targetStep.type = 'ai_action'
    targetStep.input = {
      instruction: patch.upgradeSuggestion?.prompt ?? 'AI 辅助操作',
    }
  }

  return doc
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

    if (candRow.status !== 'proposed' && candRow.status !== 'validated') {
      throw conflict('REPAIR_CANDIDATE_NOT_ADOPTABLE', `候选当前状态为「${candRow.status}」，不可采纳`)
    }

    const targetRef = candRow.patchTargetRef as PatchTargetRef
    if (targetRef.kind !== 'scenario' || !targetRef.scenarioId) {
      throw badRequest('UNSUPPORTED_TARGET_KIND', '当前仅支持场景类型的修复采纳')
    }

    const [draft] = await locked(
      tx,
      tx
        .select()
        .from(scenarioDrafts)
        .where(eq(scenarioDrafts.scenarioId, targetRef.scenarioId))
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

    // Apply patch
    const patchedDoc = applyPatchToScenarioDocument(draft.document, targetRef.stepId, candRow.patch as HealingPatch)
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
      eq(scenarioDrafts.scenarioId, targetRef.scenarioId),
    )

    const adoption: AdoptionReceipt = {
      expectedRevision: options.expectedRevision,
      resultingRevision: nextRevision,
      targetKind: 'scenario',
      targetId: targetRef.scenarioId,
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
