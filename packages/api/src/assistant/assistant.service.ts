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
  type CreateAssistantTurnBody,
  type SubmitAccepted,
  type CancelResult,
  type ModelInvocationRecord,
} from '@cairn/shared'
import {
  DomainError,
  assertTargetPermission,
  beginAssistantTurn,
  createAssistantConversation,
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
      this.asyncRunner.registerQueued(started.turn.id, actor, parsed, processingToken)
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
    const access = await this.platformConfig.resolvePlatformAiAccess().catch(() => null)
    const thinkingStream = access
      ? Boolean(access.thinkingMode === 'on')
      : false

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
      readyData: { thinkingStream },
      writeEvent: (event, write) => {
        write(event.channel, event.payload, event.seq)
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
          const run = await getRun(this.db, runId)
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
          getRun(this.db, baseRunId),
          getRun(this.db, targetRunId),
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
      unpackedResult.kind === 'knowledge_proposal'
    ) {
      const scenarioId = typeof slots?.scenarioId === 'string' ? slots.scenarioId : ''
      if (
        !scenarioId ||
        !hasAllPermissions(actor.permissions, ['workflow:read', 'target:read'])
      ) {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关场景或目标已不可访问' } }
      }
      try {
        const detail = await getScenario(this.db, scenarioId)
        await this.requireVisibleTarget(actor, detail.targetId)
      } catch {
        return { ...turn, result: { kind: 'inaccessible' as const, message: '相关场景或目标已不可访问' } }
      }
    }

    return { ...turn, result: unpackedResult }
  }
}
