import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import {
  assistantFocusSchema,
  assistantGuideTopicSchema,
  assistantQuoteContextSchema,
  availableAssistantCapabilities,
  canonicalJson,
  createAssistantTurnBodySchema,
  filterGuideCatalog,
  hasAllPermissions,
  sha256Hex,
  quoteTargetSystemId,
  unpackAssistantResultEnvelope,
  canAdoptAuthoringProposal,
  compareCompileDiagnostics,
  normalizeAuthoringDocument,
  type AuthoringDiff,
  type AuthoringOperation,
  type CompileDiagnostic,
  type CreateAssistantTurnBody,
  type DeleteAssistantConversationResult,
  type SubmitAccepted,
  type CancelResult,
  type ModelInvocationRecord,
} from '@cairn/shared'
import { applyAuthoringOperations } from '@cairn/authoring'
import {
  DomainError,
  assertTargetPermission,
  authorizeTargetRequest,
  beginAssistantTurn,
  createAssistantConversation,
  deleteAssistantConversation,
  expandWithLoader,
  getAssistantTurnRecord,
  getRun,
  getScenario,
  interruptExpiredAssistantTurns,
  listAssistantConversations,
  listAssistantTurnEvents,
  listAssistantTurnRecords,
  listPlatformAiCalls,
  type ChangeHintBus,
  type DbHandle,
} from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { observeObject } from '../common/observe-object'
import { rethrowDomain } from '../common/domain-error'
import { redactKnowledgeQuestion } from '@cairn/map'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { TargetsService } from '../targets/targets.service'
import { AssistantAsyncRunner } from './async-runner'
import type { RequestAccount as Actor } from '../common/request-account'

const TITLE_MAX = 40

function redactQuestion(question: string): string {
  return redactKnowledgeQuestion(question)
}

function conversationTitle(question: string): string {
  const text = redactQuestion(question).replace(/\s+/g, ' ').trim()
  return text.length <= TITLE_MAX ? text || '新对话' : `${text.slice(0, TITLE_MAX - 1)}…`
}

@Injectable()
export class AssistantService implements OnModuleInit {
  private readonly hints: ChangeHintBus

  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    private readonly platformConfig: PlatformConfigService,
    private readonly targets: TargetsService,
    private readonly asyncRunner: AssistantAsyncRunner,
    @Inject(CHANGE_HINT) hints: ChangeHintBus,
  ) {
    this.hints = hints
  }

  /**
   * AIF-25: On startup, recover expired turns and resume queue.
   */
  async onModuleInit(): Promise<void> {
    try {
      await interruptExpiredAssistantTurns(this.db)
    } catch {
      // In-memory or stub DB handles in integration tests may not support turn recovery
    }
    try {
      await this.asyncRunner.promoteNextQueuedTurn()
    } catch {
      // Queue promotion can fail when the database handle is a test stub
    }
  }

  async capabilities(actor: Actor) {
    const access = await this.platformConfig.resolvePlatformAiAccess()
    return {
      items: availableAssistantCapabilities(actor.permissions),
      modelEnabled: access !== null,
    }
  }

  async createConversation(
    actor: Actor,
    body: { idempotencyKey?: string; title?: string; question?: string },
    question?: string,
  ) {
    this.requireAssist(actor)
    const effectiveQuestion = body.question ?? question ?? body.title
    return createAssistantConversation(this.db, {
      ownerAccountId: actor.id,
      title: conversationTitle(effectiveQuestion ?? '新对话'),
      idempotencyKey: body.idempotencyKey,
    }).catch(rethrowDomain)
  }

  async listConversations(actor: Actor, query: { cursor?: string; limit?: number }) {
    this.requireAssist(actor)
    return listAssistantConversations(this.db, actor.id, query).catch(rethrowDomain)
  }

  async deleteConversation(actor: Actor, id: string): Promise<DeleteAssistantConversationResult> {
    this.requireAssist(actor)
    try {
      const turns = await listAssistantTurnRecords(this.db, id, actor.id, { limit: 100 })
      for (const t of turns.items) {
        if (t.turn.status === 'RUNNING' || t.turn.status === 'QUEUED') {
          await this.asyncRunner.cancel(t.turn.id, actor.id).catch(() => undefined)
        }
      }
    } catch {
      // 容错：若轮次列表拉取失败仍继续删除会话主体
    }
    return deleteAssistantConversation(this.db, id, actor.id).catch(rethrowDomain)
  }

  async listTurns(actor: Actor, conversationId: string, query: { cursor?: string; limit?: number }) {
    this.requireAssist(actor)
    const list = await listAssistantTurnRecords(this.db, conversationId, actor.id, query).catch(rethrowDomain)
    return {
      items: await Promise.all(
        list.items.map((item) => this.sanitizeStoredTurn(actor, item.turn, item.slots)),
      ),
      nextCursor: list.nextCursor,
    }
  }

  async getTurn(actor: Actor, conversationId: string, turnId: string) {
    this.requireAssist(actor)
    const record = await getAssistantTurnRecord(this.db, turnId, actor.id).catch(rethrowDomain)
    if (record.turn.conversationId !== conversationId) {
      rethrowDomain(new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在'))
    }
    return this.sanitizeStoredTurn(actor, record.turn, record.slots)
  }

  /**
   * AIF-21: Single responsibility submission entry.
   * Returns immediately with SubmitAccepted (HTTP 202), never blocks on LLM generation.
   */
  async createTurn(
    actor: Actor,
    conversationId: string,
    body: CreateAssistantTurnBody,
  ): Promise<SubmitAccepted> {
    this.requireAssist(actor)
    const parsed = createAssistantTurnBodySchema.parse(body)
    await interruptExpiredAssistantTurns(this.db).catch(rethrowDomain)

    // AI-01 OCC optimistic concurrency validation
    if (parsed.taskId && parsed.expectedRevision !== undefined) {
      try {
        const existing = await getAssistantTurnRecord(this.db, parsed.taskId, actor.id)
        if (existing.epoch !== parsed.expectedRevision) {
          throw new DomainError('conflict', 'ASSISTANT_CONCURRENCY_CONFLICT', '任务版本已更新，请重新加载后再试')
        }
      } catch (err) {
        if (err instanceof DomainError) throw err
      }
    }

    const access = await this.platformConfig.resolvePlatformAiAccess().catch(() => null)
    if (!access) {
      rethrowDomain(new DomainError('forbidden', 'ASSISTANT_MODEL_DISABLED', '当前平台未启用 AI 模型或未配置有效模型提供商，识途助手已暂停服务'))
    }

    const config = await this.platformConfig.get()
    const platformAi = config.document.platformAi
    const deadlineAt = new Date(Date.now() + platformAi.turnTimeoutMs)
    const processingToken = crypto.randomUUID()
    const requestDigest = await sha256Hex(
      canonicalJson({
        question: parsed.question,
        capabilityHint: parsed.capabilityHint ?? null,
        pageContext: parsed.pageContext ?? null,
        replyToTurnId: parsed.replyToTurnId ?? null,
      }),
    )

    // AIF-23: beginAssistantTurn with allowQueue: true enables FIFO queuing on capacity
    const started = await beginAssistantTurn(this.db, {
      conversationId,
      ownerAccountId: actor.id,
      clientTurnId: parsed.clientTurnId,
      requestDigest,
      question: redactQuestion(parsed.question),
      parentTurnId: parsed.replyToTurnId,
      deadlineAt,
      processingToken,
      userLimit: platformAi.userInflightLimit,
      platformLimit: platformAi.platformInflightLimit,
      allowQueue: true,
      ownerInstanceId: this.asyncRunner.ownerInstanceId,
      leaseUntil: new Date(Date.now() + 15_000),
      requestPayload: parsed as unknown as Record<string, unknown>,
    }).catch(rethrowDomain)

    if (started.replay) {
      const isQueued = started.turn.status === 'QUEUED'
      return {
        turnId: started.turn.id,
        taskId: started.turn.id,
        state: isQueued ? 'QUEUED' : (started.turn.status === 'RUNNING' ? 'RUNNING' : 'RUNNING'),
        stage: (started.turn.stage as SubmitAccepted['stage']) ?? (isQueued ? 'queued' : 'accepted'),
        eventSeq: started.turn.eventSeq ?? 0,
        queuePosition: started.turn.queuePosition ?? null,
      }
    }

    if (started.turn.status === 'QUEUED') {
      return {
        turnId: started.turn.id,
        taskId: started.turn.id,
        state: 'QUEUED',
        stage: 'queued',
        eventSeq: 0,
        queuePosition: started.turn.queuePosition ?? null,
      }
    }

    // Status is RUNNING: start asynchronous execution in background
    this.asyncRunner.startExecution(
      started.turn.id,
      actor,
      parsed,
      processingToken,
      deadlineAt,
      started.epoch,
    )

    return {
      turnId: started.turn.id,
      taskId: started.turn.id,
      state: 'RUNNING',
      stage: 'accepted',
      eventSeq: 0,
      queuePosition: null,
    }
  }

  /**
   * AIF-21, AIF-22: Observe turn via SSE with Last-Event-ID catch-up.
   */
  async observeTurn(
    actor: Actor,
    conversationId: string,
    turnId: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    this.requireAssist(actor)
    // Fail before SSE if turn doesn't exist
    await this.getTurn(actor, conversationId, turnId)
    return observeObject({
      req,
      res,
      hints: this.hints,
      objectId: turnId,
      after: 0,
      event: 'turn',
      matches: (hint) => hint.objectType === 'assistant_turn' && hint.objectId === turnId,
      snapshot: () => this.getTurn(actor, conversationId, turnId),
      events: (afterSeq) => listAssistantTurnEvents(this.db, turnId, afterSeq),
      finished: (snap) => snap.status !== 'RUNNING' && snap.status !== 'QUEUED',
      readyData: { thinkingStream: false },
      writeEvent: (event, write) => {
        // Old turns may still have persisted raw reasoning events. Advance the
        // durable cursor without replaying those events to the user.
        if (event.channel === 'event') write(event.channel, event.payload, event.seq)
      },
    })
  }

  /**
   * AIF-22, AIF-24: Cancel turn explicitly.
   */
  async cancelTurn(actor: Actor, conversationId: string, turnId: string): Promise<CancelResult> {
    this.requireAssist(actor)
    const turn = await this.getTurn(actor, conversationId, turnId)
    if (turn.conversationId !== conversationId) {
      throw new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }
    return this.asyncRunner.cancel(turnId, actor.id)
  }

  /**
   * AIF-08: Cross-host model invocation records query.
   */
  async listModelInvocations(
    actor: Actor,
    query: { turnId?: string; limit?: number },
  ): Promise<{ items: ModelInvocationRecord[] }> {
    this.requireAssist(actor)
    const rows = await listPlatformAiCalls(this.db, {
      ...query,
      ownerAccountId: actor.id,
    })
    const items: ModelInvocationRecord[] = rows.map((r) => ({
      callId: r.id,
      ownerRef: { kind: 'assistant_turn', turnId: r.turnId ?? 'unknown' },
      purpose: r.purpose,
      capabilityVersion: (r.capabilityVersion as any) ?? '1.0.0',
      promptVersion: r.promptVersion,
      policyRevision: r.configRevision ?? 1,
      contextManifestId: r.contextManifestId,
      requestedModel: r.requestedModel ?? r.model ?? 'unknown',
      actualModel: r.model,
      route: r.route,
      usage: (r.usage as any) ?? 'unknown',
      cost: (r.cost as any) ?? 'unknown',
      durationMs: r.durationMs ?? 0,
      errorClass: (r.errorClass as any) ?? (r.error ? 'provider_error' : 'none'),
      validation: (r.validation as any) ?? { schemaOk: !r.error, grounded: 'not_checked' },
    }))
    return { items }
  }

  async getProposalPreview(actor: Actor, conversationId: string, turnId: string) {
    this.requireAssist(actor)
    if (!hasAllPermissions(actor.permissions, ['workflow:write', 'target:read'])) {
      throw new DomainError('forbidden', 'PERMISSION_DENIED', '缺少 workflow:write 或 target:read 权限')
    }

    const record = await getAssistantTurnRecord(this.db, turnId, actor.id).catch(rethrowDomain)
    if (record.turn.conversationId !== conversationId) {
      throw new DomainError('not_found', 'ASSISTANT_TURN_NOT_FOUND', '轮次不存在')
    }

    const result = unpackAssistantResultEnvelope(record.turn.result)
    if (!result || (result.kind !== 'authoring_proposal' && result.kind !== 'proposal')) {
      throw new DomainError('bad_request', 'PROPOSAL_NOT_FOUND', '当前轮次不包含可预览的编排建议')
    }

    let scenarioId: string
    let draftRevision: number
    let targetId: string
    let baselineDigest: string
    let candidateDigest: string
    let operations: AuthoringOperation[]
    let diffs: AuthoringDiff[]
    let proposalId: string

    if (result.kind === 'authoring_proposal') {
      scenarioId = result.scenarioId
      proposalId = result.proposalId
      draftRevision = result.base.draftRevision
      baselineDigest = result.base.documentDigest
      candidateDigest = result.candidateDigest
      operations = result.operations
      diffs = result.diffs
    } else {
      scenarioId = String(record.slots?.scenarioId ?? '')
      proposalId = turnId
      draftRevision = Number(record.slots?.draftRevision ?? 0)
      baselineDigest = result.documentDigest
      candidateDigest = result.documentDigest
      operations = []
      diffs = result.diffs as any
    }

    await authorizeTargetRequest(this.db, actor.id, {
      scenarioId,
      permissions: ['workflow:write'],
    }).catch(rethrowDomain)
    const scenario = await getScenario(this.db, scenarioId).catch(rethrowDomain)
    targetId = scenario.targetId
    await this.requireVisibleTarget(actor, targetId)

    const draft = scenario.draft
    let canAdopt = false
    let staleReason: string | undefined

    if (!draft) {
      canAdopt = false
      staleReason = '场景草稿不存在'
    } else if (result.kind === 'authoring_proposal') {
      const draftDoc = normalizeAuthoringDocument(draft.document)
      const adoptCheck = await canAdoptAuthoringProposal({
        proposal: result,
        revision: draft.revision,
        document: draftDoc,
        hasFieldDrafts: false,
        remoteConflict: false,
      })
      canAdopt = adoptCheck.ok
      if (!adoptCheck.ok) {
        staleReason = adoptCheck.reason
      }
    } else {
      canAdopt = draft.revision === draftRevision
      if (!canAdopt) staleReason = '草稿版本已更新'
    }

    let diagnostics: any[] = []
    let executable = false

    if (draft && operations.length > 0) {
      const draftDoc = normalizeAuthoringDocument(draft.document)
      const applied = applyAuthoringOperations(draftDoc, operations)
      if (applied.ok) {
        let baselineDiagnostics: CompileDiagnostic[] = []
        try {
          const baselineRes = await expandWithLoader(this.db, targetId, draftDoc, 'preview', true)
          baselineDiagnostics = baselineRes.diagnostics
        } catch {
          // ignore
        }

        try {
          const candRes = await expandWithLoader(this.db, targetId, applied.document, 'preview', true)
          diagnostics = candRes.diagnostics
          compareCompileDiagnostics(baselineDiagnostics, candRes.diagnostics)
          executable = !candRes.diagnostics.some((d) => d.severity === 'error')
        } catch {
          executable = false
        }
      }
    } else if (result.kind === 'authoring_proposal') {
      diagnostics = result.diagnostics
      executable = result.executable
    }

    return {
      proposalId,
      scenarioId,
      draftRevision,
      targetId,
      baselineDigest,
      candidateDigest,
      operations,
      diffs,
      diagnostics,
      executable,
      canAdopt,
      staleReason,
    }
  }

  private requireAssist(actor: Actor) {
    if (!hasAllPermissions(actor.permissions, ['ai:assist'])) {
      rethrowDomain(new DomainError('forbidden', 'ASSISTANT_FORBIDDEN', '当前角色不能使用平台助手'))
    }
  }

  private async requireVisibleTarget(actor: Actor, targetId: string) {
    if (!hasAllPermissions(actor.permissions, ['target:read'])) {
      throw new DomainError('forbidden', 'TARGET_FORBIDDEN', '没有该目标系统的访问权限，助手不能继续')
    }
    await assertTargetPermission(this.db, actor.id, targetId, 'target:read')
    try {
      await this.targets.getTarget(targetId)
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new DomainError('not_found', 'TARGET_NOT_FOUND', '目标系统不存在')
      }
      throw error
    }
  }

  private async sanitizeStoredTurn(
    actor: Actor,
    turn: Awaited<ReturnType<typeof getAssistantTurnRecord>>['turn'],
    slots: Record<string, unknown> | null,
  ) {
    const unpackedResult = turn.result ? unpackAssistantResultEnvelope(turn.result) : null
    if (!unpackedResult || unpackedResult.kind === 'inaccessible' || unpackedResult.kind === 'clarify') {
      return { ...turn, result: unpackedResult }
    }

    if (slots?.quote) {
      const quoteObj = assistantQuoteContextSchema.safeParse(slots.quote)
      if (quoteObj.success) {
        const quoteTargetId = quoteTargetSystemId(quoteObj.data)
        if (quoteTargetId) {
          try {
            await this.requireVisibleTarget(actor, quoteTargetId)
          } catch {
            return { ...turn, result: { kind: 'inaccessible' as const, message: '引用内容所属目标已不可访问' } }
          }
        }
      }
    }

    if (unpackedResult.kind === 'discovery') {
      if (!hasAllPermissions(actor.permissions, ['target:read'])) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关目标已不可访问' } }
      }
      if (unpackedResult.scope.targetId) {
        try {
          await this.requireVisibleTarget(actor, unpackedResult.scope.targetId)
        } catch {
          return { ...turn, result: { kind: 'inaccessible' as const, message: '相关目标已不可访问' } }
        }
      }
      const visibleCandidates: typeof unpackedResult.candidates = []
      for (const candidate of unpackedResult.candidates) {
        try {
          await this.requireVisibleTarget(actor, candidate.targetId)
          visibleCandidates.push(candidate)
        } catch {
          // excluded
        }
      }
      if (unpackedResult.candidates.length > 0 && visibleCandidates.length === 0) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关目标已不可访问' } }
      }
      return {
        ...turn,
        result: {
          ...unpackedResult,
          candidates: visibleCandidates,
          coverage: {
            ...unpackedResult.coverage,
            totalVisible: visibleCandidates.length,
          },
        },
      }
    }

    if (unpackedResult.kind === 'guide') {
      const topic = assistantGuideTopicSchema.safeParse(slots?.topic).success
        ? assistantGuideTopicSchema.parse(slots?.topic)
        : undefined
      const items = filterGuideCatalog(actor.permissions, topic)
      if (items.length === 0) {
        return {
          ...turn,
          result: {
            kind: 'unsupported' as const,
            reasonCode: 'GUIDE_UNAVAILABLE',
            message: '当前权限不能打开该入口。',
          },
        }
      }
      return { ...turn, result: { kind: 'guide' as const, items } }
    }

    if (unpackedResult.kind === 'diagnosis') {
      const runDetailAction = unpackedResult.nextActions.find(
        (item) => item.kind === 'run.detail' && item.href.startsWith('/runs/') && item.href !== '/runs',
      )
      const rawRunId =
        typeof slots?.runId === 'string' && slots.runId.trim().length > 0
          ? slots.runId
          : runDetailAction
            ? runDetailAction.href.split('/').pop()
            : undefined
      const runId = rawRunId && rawRunId !== 'runs' ? rawRunId : undefined
      if (runId) {
        if (!hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) {
          return { ...turn, result: { kind: 'inaccessible' as const, message: '相关运行或目标已不可访问' } }
        }
        try {
          const run = await getRun(this.db, runId, actor.id)
          await this.requireVisibleTarget(actor, run.targetId)
        } catch {
          return {
            ...turn,
            result: { kind: 'inaccessible' as const, message: '相关运行或目标已不可访问' },
          }
        }
      }
    }

    if (unpackedResult.kind === 'compare') {
      const baseRunId = unpackedResult.baseRunId
      const targetRunId = unpackedResult.targetRunId
      if (!hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关运行或目标已不可访问' } }
      }
      try {
        const [base, target] = await Promise.all([
          getRun(this.db, baseRunId, actor.id),
          getRun(this.db, targetRunId, actor.id),
        ])
        await this.requireVisibleTarget(actor, base.targetId)
        await this.requireVisibleTarget(actor, target.targetId)
      } catch {
        return {
          ...turn,
          result: { kind: 'inaccessible' as const, message: '相关运行或目标已不可访问' },
        }
      }
    }

    if (
      unpackedResult.kind === 'explanation' ||
      unpackedResult.kind === 'proposal' ||
      unpackedResult.kind === 'knowledge_proposal' ||
      unpackedResult.kind === 'authoring_proposal'
    ) {
      const scenarioId = unpackedResult.kind === 'authoring_proposal'
        ? unpackedResult.scenarioId
        : typeof slots?.scenarioId === 'string' ? slots.scenarioId : ''
      if (
        !scenarioId ||
        !hasAllPermissions(actor.permissions, ['workflow:read', 'target:read'])
      ) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关场景或目标已不可访问' } }
      }
      try {
        await authorizeTargetRequest(this.db, actor.id, {
          scenarioId,
          permissions: ['workflow:read'],
        })
        const detail = await getScenario(this.db, scenarioId)
        await this.requireVisibleTarget(actor, detail.targetId)
      } catch {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关场景或目标已不可访问' } }
      }
    }

    return { ...turn, result: unpackedResult }
  }
}
