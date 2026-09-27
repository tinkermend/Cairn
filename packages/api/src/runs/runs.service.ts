import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import {
  authorizeTargetRequest,
  createDemonstration,
  createRunWithSnapshot,
  deleteRun,
  getEvidenceForRun,
  getRun,
  getRunCleanupStatus,
  getScenario,
  listAiTaskEvents,
  listMapSelectionDecisions,
  listResolutionDecisions,
  listRunEvidence,
  listRuns,
  loadIterationDetail,
  loadResolutionLayers,
  loadRunIterations,
  loadScenarioVersion,
  previewDeleteRun,
  requestRunCancel,
  retryRunCleanup,
  retryRunReport,
  reviewRun,
  targetScopeFor,
  type DbHandle,
  type TargetScope,
} from '@cairn/db'
import { aiTraceToDemonstrationSource } from '@cairn/authoring'
import {
  computeStepDefinitionDigest,
  normalizeAuthoringDocument,
  parseHttpRange,
  walkAuthoringNodes,
  type CreateSolidificationDraftResponse,
} from '@cairn/shared'
import { assertAiExecutePermission } from '../config/browser-ai'
import { config } from '../config/env'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import type {
  AiTaskListQuery,
  CreateRunBody,
  DeleteResourceBody,
  MapDecisionListQuery,
  ResolutionDecisionListQuery,
  ReviewRunBody,
  RunListQuery,
  StepIterationListQuery,
} from '@cairn/shared'
import type { ObjectStore } from '@cairn/storage'
import { DB_HANDLE } from '../db/db.module'
import type { RequestAccount } from '../common/request-account'
import { rethrowDomain } from '../common/domain-error'
import { OBJECT_STORE } from '../objects/object-store.token'
import { visibleRunDetail, visibleRunList } from './report-visibility'

export type EvidenceContent = {
  body: Uint8Array
  contentType: string
  byteSize: number
  filename: string
  totalSize: number
  range?: { start: number; end: number }
}

@Injectable()
export class RunsService {
  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Optional() @Inject(OBJECT_STORE) private readonly store?: ObjectStore,
    @Optional() private readonly platformConfig?: PlatformConfigService,
  ) {}

  private get db() {
    return this.dbHandle
  }

  private async requireRunScope(runId: string, actorId: string, permissions: string[] = ['run:read']) {
    await authorizeTargetRequest(this.db, actorId, { runId, permissions }).catch(rethrowDomain)
  }

  async list(query: RunListQuery, actorId: string) {
    try {
      return await visibleRunList(this.db, actorId, await listRuns(this.db, query, actorId))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  reportReadScope(actorId: string): Promise<TargetScope> {
    return targetScopeFor(this.db, actorId, 'report:read').catch(rethrowDomain)
  }

  async get(id: string, actorId: string) {
    try {
      return await visibleRunDetail(this.db, actorId, await getRun(this.db, id, actorId))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async retryReport(runId: string, actor: RequestAccount) {
    await this.requireRunScope(runId, actor.id, ['report:export', 'run:read'])
    return retryRunReport(this.db, runId, { kind: 'console', id: actor.id }).catch(rethrowDomain)
  }

  async mapDecisions(id: string, query: MapDecisionListQuery, actorId: string) {
    await this.requireRunScope(id, actorId)
    return listMapSelectionDecisions(this.db, id, query).catch(rethrowDomain)
  }

  async resolutionDecisions(id: string, query: ResolutionDecisionListQuery, actorId: string) {
    await this.requireRunScope(id, actorId)
    return listResolutionDecisions(this.db, id, query).catch(rethrowDomain)
  }

  async aiTasks(runId: string, attemptId: string, query: AiTaskListQuery, actorId: string) {
    await this.requireRunScope(runId, actorId)
    return listAiTaskEvents(this.db, { runId, attemptId, ...query }).catch(rethrowDomain)
  }

  async createSolidificationDraft(
    runId: string,
    attemptId: string,
    actor: RequestAccount,
  ): Promise<CreateSolidificationDraftResponse> {
    try {
      await this.requireRunScope(runId, actor.id, ['run:read', 'workflow:write'])
      const run = await getRun(this.db, runId, actor.id)
      if (!run) {
        throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: '运行不存在' })
      }

      let foundStepRun: (typeof run.stepRuns)[number] | undefined
      let foundAttempt: (typeof run.stepRuns)[number]['attempts'][number] | undefined
      for (const stepRun of run.stepRuns) {
        const attempt = stepRun.attempts.find((a) => a.id === attemptId)
        if (attempt) {
          foundStepRun = stepRun
          foundAttempt = attempt
          break
        }
      }

      if (!foundStepRun || !foundAttempt) {
        throw new NotFoundException({ code: 'ATTEMPT_NOT_FOUND', message: '步骤尝试记录不存在' })
      }

      if (foundStepRun.scopePath) {
        throw new BadRequestException({
          code: 'MODULE_INTERNAL_NOT_SUPPORTED',
          message: '模块内部步骤不支持直接生成确定性草案',
        })
      }

      const stepDef = run.snapshot?.steps.find((s) => s.id === foundStepRun!.stepId)
      if (!stepDef || stepDef.type !== 'ai_action') {
        throw new BadRequestException({
          code: 'STEP_TYPE_NOT_SUPPORTED',
          message: '仅支持直属 ai_action 步骤生成确定性草案',
        })
      }

      if (foundAttempt.status !== 'SUCCEEDED') {
        throw new BadRequestException({
          code: 'ATTEMPT_NOT_SUCCEEDED',
          message: '仅成功的尝试记录可用于生成确定性草案',
        })
      }

      const { events, observation } = await listAiTaskEvents(this.db, {
        runId,
        attemptId,
        limit: 200,
      })

      if (!events || events.length === 0) {
        throw new BadRequestException({
          code: 'AI_TRACE_EMPTY',
          message: '未记录到可用的 AI 动作事实',
        })
      }

      const traceIntegrity = observation?.traceIntegrity ?? 'complete'
      if (traceIntegrity !== 'complete') {
        throw new BadRequestException({
          code: 'TRAJECTORY_INCOMPLETE',
          message: 'AI 执行轨迹不完整，无法生成确定性草案',
        })
      }

      if (observation?.solidifiableLevel === 'blocked') {
        throw new BadRequestException({
          code: 'SOLIDIFICATION_BLOCKED',
          message: `该轨迹不可固化：${observation.solidifiableReasons.join(', ')}`,
        })
      }

      const scenario = await getScenario(this.db, run.scenarioId)
      let sourceNodePresent = false
      let definitionChanged = false
      const diagnostics: string[] = []

      const draftDoc = scenario.draft?.document
      if (draftDoc) {
        const nodes = walkAuthoringNodes(normalizeAuthoringDocument(draftDoc))
        const matchedItem = nodes.find((item) => item.id === foundStepRun!.stepId)
        if (matchedItem && matchedItem.node.kind === 'step') {
          sourceNodePresent = true
          const currentDigest = computeStepDefinitionDigest(matchedItem.node.step)
          const originDigest = observation?.stepDefinitionDigest ?? computeStepDefinitionDigest(stepDef as any)
          if (currentDigest !== originDigest) {
            definitionChanged = true
            diagnostics.push('SOURCE_DEFINITION_CHANGED')
          }
        } else {
          sourceNodePresent = false
          definitionChanged = true
          diagnostics.push('STEP_NOT_IN_DRAFT')
        }
      } else {
        sourceNodePresent = false
        definitionChanged = true
        diagnostics.push('STEP_NOT_IN_DRAFT')
      }

      const source = aiTraceToDemonstrationSource({
        runId,
        attemptId,
        stepRunId: foundStepRun.id,
        targetId: run.targetId,
        scenarioId: run.scenarioId,
        stepId: foundStepRun.stepId,
        stepName: stepDef.name,
        instruction: (stepDef.input as any)?.instruction,
        events,
        sdkVersion: events[0]?.sdkVersion,
        capturedAt: foundAttempt.startedAt ? new Date(foundAttempt.startedAt).toISOString() : undefined,
      })

      const draftName = `固化草案-${stepDef.name || foundStepRun.stepId.slice(0, 8)}`.slice(0, 128)
      const demonstration = await createDemonstration(
        this.db,
        {
          idempotencyKey: `solidify-${attemptId}`,
          name: draftName,
          source,
          acknowledgedOmittedConfig: true,
        },
        actor,
      )

      return {
        recordingDraftId: demonstration.recordingDraftId,
        scenarioId: run.scenarioId,
        sourceNodeId: foundStepRun.stepId,
        sourceNodePresent,
        definitionChanged,
        diagnostics,
      }
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async previewDelete(id: string, actorId: string) {
    await this.requireRunScope(id, actorId, ['run:delete'])
    return previewDeleteRun(this.db, id).catch(rethrowDomain)
  }

  async delete(id: string, actor: RequestAccount, body?: DeleteResourceBody) {
    await this.requireRunScope(id, actor.id, ['run:delete'])
    return deleteRun(this.db, id, actor, body).catch(rethrowDomain)
  }

  async cleanupStatus(id: string, actorId: string) {
    await this.requireRunScope(id, actorId)
    return getRunCleanupStatus(this.db, id).catch(rethrowDomain)
  }

  async retryCleanup(id: string, actor: RequestAccount) {
    await this.requireRunScope(id, actor.id, ['run:delete'])
    return retryRunCleanup(this.db, id, actor).catch(rethrowDomain)
  }

  evidence(id: string, actorId: string) {
    return listRunEvidence(this.db, id, actorId).catch(rethrowDomain)
  }

  async iterations(id: string, actorId: string, query?: StepIterationListQuery) {
    await this.requireRunScope(id, actorId)
    return loadRunIterations(this.db, id, query).catch(rethrowDomain)
  }

  async iterationDetail(runId: string, iterationId: string, actorId: string) {
    await this.requireRunScope(runId, actorId)
    return loadIterationDetail(this.db, runId, iterationId).catch(rethrowDomain)
  }

  async evidenceContent(runId: string, evidenceId: string, actorId: string, rangeHeader?: string): Promise<EvidenceContent> {
    const row = await getEvidenceForRun(this.db, { runId, evidenceId }, actorId).catch(rethrowDomain)
    if (!row) {
      throw new NotFoundException({ code: 'EVIDENCE_NOT_FOUND', message: '证据不存在' })
    }
    if (row.status !== 'available' || !row.objectKey) {
      throw new NotFoundException({
        code: 'EVIDENCE_NOT_AVAILABLE',
        message: row.missingReason ? `证据不可用：${row.missingReason}` : '证据不可用',
      })
    }
    if (!this.store) {
      throw new NotFoundException({
        code: 'EVIDENCE_NOT_AVAILABLE',
        message: '证据不可用：object_store_unavailable',
      })
    }
    const totalSize = row.byteSize
    const parsed = totalSize != null ? parseHttpRange(rangeHeader, totalSize) : rangeHeader ? 'unsatisfiable' : null
    if (parsed === 'unsatisfiable') {
      throw new HttpException(
        { code: 'RANGE_NOT_SATISFIABLE', message: '范围无效' },
        HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
      )
    }
    try {
      const got = await this.store.get(
        row.objectKey,
        parsed ? { start: parsed.start, end: parsed.end } : undefined,
      )
      const size = got.range?.size ?? got.head.byteSize
      return {
        body: got.body,
        contentType: row.contentType ?? 'application/octet-stream',
        byteSize: got.body.byteLength,
        filename: filenameFor(row.type, runId),
        totalSize: size,
        range: got.range ? { start: got.range.start, end: got.range.end } : parsed ?? undefined,
      }
    } catch {
      throw new NotFoundException({
        code: 'EVIDENCE_NOT_AVAILABLE',
        message: '证据不可用：object_store_unavailable',
      })
    }
  }

  async create(body: CreateRunBody, actor: RequestAccount) {
    try {
      await this.platformConfig?.ensure()
      const { scenario, version } = await loadScenarioVersion(this.db, body.scenarioId, body.scenarioVersionId)
      const layers = await loadResolutionLayers(this.db, scenario.targetId)
      assertAiExecutePermission(actor, version.definition.steps, {
        document: layers.document,
        documentResolution: version.definition.resolution,
        documentLocatorPlan: version.definition.locatorPlan,
        locatorProtocol: version.definition.locatorProtocol,
        targetCeiling: layers.targetCeiling,
        targetPreference: layers.targetPreference,
        targetPolicy: layers.targetPolicy,
      })
      const created = await createRunWithSnapshot(this.db, {
        ...body,
        actor: { id: actor.id },
        hangWaitMs: config.CAIRN_BROWSER_AI_HANG_WAIT_MS,
      })
      return { ...created, detail: await visibleRunDetail(this.db, actor.id, created.detail) }
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async cancel(id: string, actor: RequestAccount) {
    try {
      await this.requireRunScope(id, actor.id, ['run:cancel', 'run:read'])
      return await visibleRunDetail(this.db, actor.id, await requestRunCancel(this.db, id, { id: actor.id }))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async review(id: string, body: ReviewRunBody, actor: RequestAccount) {
    try {
      await this.requireRunScope(id, actor.id, ['run:review', 'run:read'])
      await reviewRun(this.db, {
        runId: id,
        actor: { id: actor.id },
        conclusion: body.conclusion,
        note: body.note,
      })
      return await visibleRunDetail(this.db, actor.id, await getRun(this.db, id, actor.id))
    } catch (error) {
      rethrowDomain(error)
    }
  }
}

function filenameFor(type: string, runId: string): string {
  if (type === 'screenshot') return 'screenshot.png'
  if (type === 'trace') return 'trace.zip'
  if (type === 'video') return `run-${runId.slice(0, 8)}.webm`
  return 'evidence.bin'
}
