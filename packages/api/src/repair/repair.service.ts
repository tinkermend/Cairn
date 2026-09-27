import { Inject, Injectable, Optional } from '@nestjs/common'
import {
  type CreateRepairCandidateBody,
  type ValidateRepairCandidateBody,
  type AdoptRepairCandidateBody,
  type RejectRepairCandidateBody,
  type RepairCandidate,
  type PatchTargetRef,
  type ScenarioDocument,
  type RepairCandidateStatus,
  type PlatformConfigCurrent,
  FACTORY_PLATFORM_CONFIG,
  stepRunFor,
} from '@cairn/shared'
import {
  evaluatePatchGuards,
  computeDigestManifest,
  computeTargetDigest,
  applyPatchToDocument,
} from '@cairn/authoring'
import {
  badRequest,
  notFound,
  loadRunDetail,
  createRepairCandidate,
  getRepairCandidate,
  authorizeTargetRequest,
  listRepairCandidatesByRun,
  listRepairCandidatesByScenario,
  updateRepairCandidateValidation,
  rejectRepairCandidate,
  reopenRepairCandidate,
  adoptRepairCandidate,
  validateRepairCandidate,
  getPlatformConfig,
  newId,
  type DbHandle,
} from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { executableTypesFrom } from '../config/browser-ai'
import { config } from '../config/env'
import type { RequestAccount } from '../common/request-account'

@Injectable()
export class RepairService {
  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Optional() private readonly platformConfig?: PlatformConfigService,
  ) {}

  private get db() {
    return this.dbHandle
  }

  private async currentConfig(): Promise<PlatformConfigCurrent> {
    if (this.platformConfig) return this.platformConfig.ensure()
    return (
      (await getPlatformConfig(this.db)) ?? {
        revision: 1,
        document: FACTORY_PLATFORM_CONFIG,
        updatedAt: new Date(0).toISOString(),
        updatedByAccountId: null,
        reason: '出厂默认',
        source: 'bootstrap',
      }
    )
  }

  async createCandidate(
    runId: string,
    body: CreateRepairCandidateBody,
    actorId: string,
  ): Promise<RepairCandidate> {
    try {
      const run = await loadRunDetail(this.db, runId, actorId)
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

      const patchedDoc = applyPatchToDocument(originalDoc, effectiveStepId, body.patch)
      const patchedStep = patchedDoc.steps.find((s) => s.id === effectiveStepId)

      // Evaluate patch guardrails
      const guardResults = evaluatePatchGuards({
        originalStep,
        patchedStep,
        patch: body.patch,
        sourceDefinition: originalDoc as unknown as Record<string, unknown>,
        patchedDefinition: patchedDoc as unknown as Record<string, unknown>,
      })

      // Calculate digest manifest
      const digestManifest = computeDigestManifest(
        originalDoc as unknown as Record<string, unknown>,
        patchedDoc as unknown as Record<string, unknown>,
      )

      const sourceTargetDigest = computeTargetDigest((originalStep.input as any)?.target)

      const patchTargetRef: PatchTargetRef = {
        kind: 'scenario',
        scenarioId: run.scenarioId,
        sourceScenarioVersionId: run.scenarioVersionId ?? undefined,
        stepId: effectiveStepId,
        sourceDefinitionDigest: digestManifest.sourceDefinitionDigest,
        sourceTargetDigest,
      }

      const candidateId = `rep_${newId().replace(/-/g, '').slice(0, 12)}`

      const created = await createRepairCandidate(this.db, {
        candidateId,
        scenarioId: run.scenarioId,
        runId,
        sourceAttemptId: body.sourceAttemptId,
        sourceTargetDigest,
        dedupeKey: candidateId,
        patchTargetRef,
        authoringOrigin: body.authoringOrigin,
        patch: body.patch,
        hypothesis: body.hypothesis,
        applicability: body.applicability,
        digestManifest,
        guardResults,
        status: guardResults.overallPassed ? 'proposed' : 'blocked',
        scopeActorId: actorId,
      })

      return created
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async listCandidatesByRun(runId: string, actorId: string): Promise<RepairCandidate[]> {
    try {
      await authorizeTargetRequest(this.db, actorId, { runId, permissions: ['run:read'] })
      return await listRepairCandidatesByRun(this.db, runId)
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async listCandidatesByScenario(
    scenarioId: string,
    status: RepairCandidateStatus | undefined,
    actorId: string,
  ): Promise<RepairCandidate[]> {
    try {
      await authorizeTargetRequest(this.db, actorId, { scenarioId, permissions: ['workflow:read'] })
      return await listRepairCandidatesByScenario(this.db, scenarioId, status)
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  private async candidateForActor(id: string, actorId: string, permissions: string[]): Promise<RepairCandidate> {
    const candidate = await getRepairCandidate(this.db, id)
    if (!candidate) {
      throw notFound('REPAIR_CANDIDATE_NOT_FOUND', `修复候选不存在: ${id}`)
    }
    if (!candidate.scenarioId && !candidate.runId) {
      throw notFound('TARGET_NOT_FOUND', '目标不存在或无权访问')
    }
    // The route has only :id. Resolve the candidate's scenario before any read or side effect;
    // TargetScopeGuard cannot infer its target from this parameter (which may also be rep_...).
    await authorizeTargetRequest(this.db, actorId, {
      scenarioId: candidate.scenarioId ?? undefined,
      runId: candidate.runId ?? undefined,
      permissions,
    })
    return candidate
  }

  async getCandidate(id: string, actorId: string): Promise<RepairCandidate> {
    try {
      return await this.candidateForActor(id, actorId, ['run:read'])
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async validateCandidate(
    id: string,
    body: ValidateRepairCandidateBody,
    actor: RequestAccount,
  ): Promise<{ candidate: RepairCandidate; runId: string }> {
    try {
      const candidate = await this.candidateForActor(id, actor.id, ['run:execute', 'workflow:write'])
      const current = await this.currentConfig()
      const executableTypes = executableTypesFrom(current.document)
      return await validateRepairCandidate(this.db, candidate.id, {
        targetAccountId: body.targetAccountId,
        input: body.input as any,
        actor: { id: actor.id },
        scopeActorId: actor.id,
        executableTypes,
        hangWaitMs: config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
      })
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
      const candidate = await this.candidateForActor(id, adoptedBy, ['workflow:write'])

      if (!candidate.guardResults.overallPassed) {
        throw badRequest(
          'REPAIR_GUARDRAILS_FAILED',
          '该候选未通过安全护栏校验（可能存在越权修改或降低断言条件），禁止采纳为草稿。',
        )
      }

      return await adoptRepairCandidate(this.db, {
        idOrCandidateId: candidate.id,
        expectedRevision: body.expectedRevision,
        adoptedBy,
        scopeActorId: adoptedBy,
      })
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async rejectCandidate(
    id: string,
    body: RejectRepairCandidateBody,
    actorId: string,
  ): Promise<RepairCandidate> {
    try {
      const candidate = await this.candidateForActor(id, actorId, ['workflow:write'])
      return await rejectRepairCandidate(this.db, candidate.id, actorId, body.reason, actorId)
    } catch (error) {
      return rethrowDomain(error)
    }
  }

  async reopenCandidate(
    id: string,
    actorId: string,
  ): Promise<RepairCandidate> {
    try {
      const candidate = await this.candidateForActor(id, actorId, ['workflow:write'])
      return await reopenRepairCandidate(this.db, candidate.id, actorId, actorId)
    } catch (error) {
      return rethrowDomain(error)
    }
  }
}
