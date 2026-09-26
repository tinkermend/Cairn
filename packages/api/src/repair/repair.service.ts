import { Inject, Injectable } from '@nestjs/common'
import {
  type CreateRepairCandidateBody,
  type ValidateRepairCandidateBody,
  type AdoptRepairCandidateBody,
  type RejectRepairCandidateBody,
  type RepairCandidate,
  type PatchTargetRef,
  type ScenarioDocument,
  type HealingPatch,
  stepRunFor,
} from '@cairn/shared'
import {
  evaluatePatchGuards,
  computeDigestManifest,
} from '@cairn/authoring'
import {
  badRequest,
  notFound,
  loadRunDetail,
  createRepairCandidate,
  getRepairCandidate,
  listRepairCandidatesByRun,
  updateRepairCandidateValidation,
  updateRepairCandidateStatus,
  adoptRepairCandidate,
  newId,
  type DbHandle,
} from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'

function applyPatchToDoc(originalDoc: ScenarioDocument, stepId: string, patch: HealingPatch): ScenarioDocument {
  const doc = JSON.parse(JSON.stringify(originalDoc)) as ScenarioDocument
  const stepIndex = doc.steps.findIndex((s) => s.id === stepId)
  if (stepIndex === -1) {
    throw badRequest('STEP_NOT_FOUND', `未在场景文档中找到步骤「${stepId}」`)
  }

  const step = doc.steps[stepIndex]!

  if (patch.kind === 'REPLACE_LOCATOR') {
    if (patch.targetDescriptor) {
      step.input = { ...step.input, target: patch.targetDescriptor }
    } else if (patch.suggestedCandidate) {
      step.input = {
        ...step.input,
        target: {
          framePath: [],
          candidates: [patch.suggestedCandidate],
        },
      }
    }
  } else if (patch.kind === 'ADD_CANDIDATE') {
    if (patch.suggestedCandidate) {
      const currentTarget = (step.input as any)?.target ?? { framePath: [], candidates: [] }
      const candidates = Array.isArray(currentTarget.candidates) ? [...currentTarget.candidates] : []
      candidates.push(patch.suggestedCandidate)
      step.input = {
        ...step.input,
        target: { ...currentTarget, framePath: currentTarget.framePath ?? [], candidates },
      }
    }
  } else if (patch.kind === 'PREPEND_WAIT') {
    const waitStep: any = {
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
    step.type = 'ai_action' as any
    step.input = {
      instruction: patch.upgradeSuggestion?.prompt ?? 'AI 辅助操作',
    }
  }

  return doc
}

@Injectable()
export class RepairService {
  constructor(@Inject(DB_HANDLE) private readonly db: DbHandle) {}

  async createCandidate(
    runId: string,
    body: CreateRepairCandidateBody,
  ): Promise<RepairCandidate> {
    try {
      const run = await loadRunDetail(this.db, runId)
      if (!run) {
        throw notFound('RUN_NOT_FOUND', `未找到运行: ${runId}`)
      }

      // Check step and attempt existence
      const stepRun = stepRunFor(run.stepRuns, body.stepId) ?? run.stepRuns.find((s) => s.id === body.stepId)
      const effectiveStepId = stepRun ? stepRun.stepId : body.stepId

      // Reconstruct ScenarioDocument from run snapshot
      const originalDoc: ScenarioDocument = {
        schemaVersion: 1,
        inputs: [],
        steps: run.snapshot.steps as ScenarioDocument['steps'],
        outputs: undefined,
      }

      const originalStep = originalDoc.steps.find((s) => s.id === effectiveStepId)
      if (!originalStep) {
        throw badRequest('STEP_NOT_FOUND', `未在场景快照中找到待修复步骤「${effectiveStepId}」`)
      }

      const patchedDoc = applyPatchToDoc(originalDoc, effectiveStepId, body.patch)
      const patchedStep = patchedDoc.steps.find((s) => s.id === effectiveStepId)

      // Evaluate patch guardrails (B4)
      const guardResults = evaluatePatchGuards({
        originalStep,
        patchedStep,
        patch: body.patch,
        sourceDefinition: originalDoc as unknown as Record<string, unknown>,
        patchedDefinition: patchedDoc as unknown as Record<string, unknown>,
      })

      // Calculate digest manifest (B4)
      const digestManifest = computeDigestManifest(
        originalDoc as unknown as Record<string, unknown>,
        patchedDoc as unknown as Record<string, unknown>,
      )

      const patchTargetRef: PatchTargetRef = {
        kind: 'scenario',
        scenarioId: run.scenarioId,
        sourceScenarioVersionId: run.scenarioVersionId ?? undefined,
        stepId: effectiveStepId,
        sourceDefinitionDigest: digestManifest.sourceDefinitionDigest,
      }

      const candidateId = `rep_${newId().replace(/-/g, '').slice(0, 12)}`

      const created = await createRepairCandidate(this.db, {
        candidateId,
        runId,
        sourceAttemptId: body.sourceAttemptId,
        patchTargetRef,
        authoringOrigin: body.authoringOrigin,
        patch: body.patch,
        hypothesis: body.hypothesis,
        applicability: body.applicability,
        digestManifest,
        guardResults,
        status: guardResults.overallPassed ? 'proposed' : 'blocked',
      })

      return created
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async listCandidatesByRun(runId: string): Promise<RepairCandidate[]> {
    try {
      return await listRepairCandidatesByRun(this.db, runId)
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async getCandidate(id: string): Promise<RepairCandidate> {
    try {
      const candidate = await getRepairCandidate(this.db, id)
      if (!candidate) {
        throw notFound('REPAIR_CANDIDATE_NOT_FOUND', `修复候选不存在: ${id}`)
      }
      return candidate
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async validateCandidate(
    id: string,
    body: ValidateRepairCandidateBody,
  ): Promise<RepairCandidate> {
    try {
      const candidate = await getRepairCandidate(this.db, id)
      if (!candidate) {
        throw notFound('REPAIR_CANDIDATE_NOT_FOUND', `修复候选不存在: ${id}`)
      }

      const currentScope = candidate.validationScope
      const newScope = {
        locatorValid: body.validationScope?.locatorValid ?? currentScope.locatorValid,
        stepPassed: body.validationScope?.stepPassed ?? currentScope.stepPassed,
        outcomePassed: body.validationScope?.outcomePassed ?? currentScope.outcomePassed,
        crossSampleStable: body.validationScope?.crossSampleStable ?? currentScope.crossSampleStable,
      }

      const updated = await updateRepairCandidateValidation(
        this.db,
        id,
        newScope,
        {
          validationRunId: body.validationRunId,
          validationAttemptId: body.validationAttemptId,
          dataVersion: body.dataVersion,
          pageVersion: body.pageVersion,
          modelName: body.modelName,
          successConditionsPassed: body.successConditionsPassed,
          evidenceIds: body.evidenceIds ?? [],
        },
      )

      return updated
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async adoptCandidate(
    id: string,
    body: AdoptRepairCandidateBody,
    adoptedBy: string,
  ): Promise<{ candidate: RepairCandidate; draftRevision: number }> {
    try {
      const candidate = await getRepairCandidate(this.db, id)
      if (!candidate) {
        throw notFound('REPAIR_CANDIDATE_NOT_FOUND', `修复候选不存在: ${id}`)
      }

      if (!candidate.guardResults.overallPassed) {
        throw badRequest(
          'REPAIR_GUARDRAILS_FAILED',
          '该候选未通过安全护栏校验（可能存在越权修改或降低断言条件），禁止采纳为草稿。',
        )
      }

      return await adoptRepairCandidate(this.db, {
        idOrCandidateId: id,
        expectedRevision: body.expectedRevision,
        adoptedBy,
      })
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async rejectCandidate(
    id: string,
    _body: RejectRepairCandidateBody,
  ): Promise<RepairCandidate> {
    try {
      return await updateRepairCandidateStatus(this.db, id, 'rejected')
    } catch (error) {
      return rethrowDomain(error)
    }
  }
}
