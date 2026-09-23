import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import {
  type AssistantCapabilityId,
  type AssistantPageContext,
  type AssistantResult,
  type AssistantRouteDecision,
  type AssistantStage,
  type CancelResult,
  type CreateAssistantTurnBody,
  clarifyAvailableCapabilities,
  cleanAssistantQuestion,
  extractScenarioSearchKeyword,
  hasAllPermissions,
  routeAssistantTurn,
  unpackAssistantResultEnvelope,
} from '@cairn/shared'
import {
  type ChangeHintBus,
  type DbHandle,
  DomainError,
  cancelAssistantTurn,
  completeAssistantTurn,
  getAssistantTurnRecord,
  listScenarios,
  nextQueuedAssistantTurn,
  recordAssistantTurnEvent,
  renewAssistantTurnLease,
  updateAssistantTurnStage,
} from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { TargetsService } from '../targets/targets.service'
import { createOpenAiCompatibleClient, type PlatformModelClient } from './model-client'
import { AssistantModelSession, classifyAssistantCapability } from './model-session'
import { AssistantCapabilityRegistry } from './registry'
import type { RequestAccount as Actor } from '../common/request-account'

interface ActiveExecution {
  turnId: string
  actor: Actor
  body: CreateAssistantTurnBody
  processingToken: string
  abortController: AbortController
  deadlineAt: Date
  epoch: number
}

function parseOrdinalIndex(text: string, count: number): number | null {
  const trimmed = text.trim()
  if (/^(?:选|查看)?\s*最后\s*一个?(?:场景|步骤|项)?$/i.test(trimmed)) {
    return count > 0 ? count - 1 : null
  }
  const match = /^(?:选|查看)?\s*第\s*([1-9]|10|[一二两三四五六七八九十])\s*个?(?:场景|步骤|项)?$/i.exec(trimmed)
  if (!match) return null
  const numMap: Record<string, number> = {
    '1': 0, '一': 0,
    '2': 1, '二': 1, '两': 1,
    '3': 2, '三': 2,
    '4': 3, '四': 3,
    '5': 4, '五': 4,
    '6': 5, '六': 5,
    '7': 6, '七': 6,
    '8': 7, '八': 7,
    '9': 8, '九': 8,
    '10': 9, '十': 9,
  }
  const idx = numMap[match[1]!]
  return idx !== undefined && idx < count ? idx : null
}

@Injectable()
export class AssistantAsyncRunner implements OnModuleInit, OnModuleDestroy {
  public readonly ownerInstanceId = crypto.randomUUID()
  private readonly logger = new Logger(AssistantAsyncRunner.name)
  private readonly activeRuns = new Map<string, ActiveExecution>()
  private readonly queuedExecutions = new Map<
    string,
    { actor: Actor; body: CreateAssistantTurnBody; processingToken: string }
  >()
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Inject(CHANGE_HINT) private readonly hints: ChangeHintBus,
    private readonly platformConfig: PlatformConfigService,
    private readonly targets: TargetsService,
    private readonly registry: AssistantCapabilityRegistry,
    @Optional() private readonly models: PlatformModelClient = createOpenAiCompatibleClient(),
  ) {}

  onModuleInit(): void {
    this.startHeartbeat()
  }

  onModuleDestroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return
    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeat()
    }, 5000)
    // Don't keep Node process alive just for background lease heartbeat
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref()
    }
  }

  private async tickHeartbeat(): Promise<void> {
    for (const [turnId, exec] of Array.from(this.activeRuns.entries())) {
      try {
        const renewed = await renewAssistantTurnLease(this.db, {
          turnId: exec.turnId,
          ownerInstanceId: this.ownerInstanceId,
          epoch: exec.epoch,
          leaseDurationMs: 15_000,
        })
        if (!renewed) {
          this.logger.warn(`Turn ${turnId} lease lost or preempted, aborting active run`)
          exec.abortController.abort()
          this.activeRuns.delete(turnId)
        }
      } catch (err) {
        this.logger.error(`Failed to renew lease for turn ${turnId}`, err)
      }
    }
  }

  /**
   * Enqueue execution context for a queued turn.
   */
  registerQueued(
    turnId: string,
    actor: Actor,
    body: CreateAssistantTurnBody,
    processingToken: string,
  ): void {
    this.queuedExecutions.set(turnId, { actor, body, processingToken })
  }

  /**
   * Fire-and-forget background execution of an assistant turn.
   */
  startExecution(
    turnId: string,
    actor: Actor,
    body: CreateAssistantTurnBody,
    processingToken: string,
    deadlineAt: Date,
    epoch: number,
  ): void {
    this.startHeartbeat()
    const abortController = new AbortController()
    const execution: ActiveExecution = {
      turnId,
      actor,
      body,
      processingToken,
      abortController,
      deadlineAt,
      epoch,
    }
    this.activeRuns.set(turnId, execution)
    this.queuedExecutions.delete(turnId)

    // Execute in background
    this.runTurn(execution).catch((err) => {
      this.logger.error(`Turn ${turnId} execution failed unexpectedly`, err)
    })
  }

  /**
   * AIF-22, AIF-24: Explicitly cancel a turn.
   */
  async cancel(turnId: string, actorId: string): Promise<CancelResult> {
    const active = this.activeRuns.get(turnId)
    if (active) {
      active.abortController.abort()
      this.activeRuns.delete(turnId)
    }
    this.queuedExecutions.delete(turnId)

    const turn = await cancelAssistantTurn(this.db, { turnId, ownerAccountId: actorId })
    await this.recordEvent(
      turnId,
      'event',
      {
        stage: 'persisting',
        at: new Date().toISOString(),
        note: 'Turn cancelled explicitly by user',
      },
      (turn.eventSeq ?? 0) + 1,
    ).catch(() => undefined)

    await this.hints
      .publish({
        namespace: this.hints.namespace,
        eventSeq: (turn.eventSeq ?? 0) + 1,
        objectType: 'assistant_turn',
        objectId: turnId,
      })
      .catch(() => undefined)

    // Promote any waiting turns in queue
    void this.promoteNextQueuedTurn()

    return {
      turnId: turn.id,
      state: turn.status as 'CANCELLED' | 'COMPLETED' | 'FAILED',
    }
  }

  /**
   * Main turn execution loop with stage events and queue promotion.
   */
  private async runTurn(exec: ActiveExecution): Promise<void> {
    const { turnId, actor, body, processingToken, abortController, deadlineAt } = exec
    let currentSeq = 0

    const recordStage = async (stage: AssistantStage, note?: string) => {
      currentSeq++
      await this.recordEvent(
        turnId,
        'event',
        {
          stage,
          at: new Date().toISOString(),
          note,
        },
        currentSeq,
      )
      await updateAssistantTurnStage(this.db, { turnId, stage, eventSeq: currentSeq }).catch(
        () => undefined,
      )
      await this.hints
        .publish({
          namespace: this.hints.namespace,
          eventSeq: currentSeq,
          objectType: 'assistant_turn',
          objectId: turnId,
        })
        .catch(() => undefined)
    }

    // AIF-PD-14: Cancellation check: explicit cancelCurrentTask flag or natural language "取消", "算了", "不用了", "退出"
    if (body.cancelCurrentTask || /^(取消|取消本次任务|取消任务|算了|不用了|退出)$/i.test(body.question.trim())) {
      await recordStage('persisting', '用户主动取消任务')
      if (body.replyToTurnId) {
        await cancelAssistantTurn(this.db, {
          turnId: body.replyToTurnId,
          ownerAccountId: actor.id,
          stopReason: 'cancelled_by_user',
        }).catch(() => undefined)
      }
      await completeAssistantTurn(this.db, {
        turnId,
        ownerAccountId: actor.id,
        processingToken,
        status: 'CANCELLED',
        stopReason: 'cancelled_by_user',
        result: {
          kind: 'unsupported',
          reasonCode: 'TASK_CANCELLED',
          message: '本次任务已取消。',
        },
      })
      return
    }

    const access = await this.platformConfig.resolvePlatformAiAccess()
    const session = access
      ? new AssistantModelSession(this.db, turnId, { ...access, deadlineAt }, this.models, actor.id)
      : null

    try {
      await recordStage('routing')
      if (abortController.signal.aborted) throw new Error('ABORTED')

      const availableDescriptors = this.registry
        .listDescriptors()
        .filter((desc) => hasAllPermissions(actor.permissions, desc.requiredPermissions))
      const availableIds = availableDescriptors.map((desc) => desc.id as AssistantCapabilityId)

      // Check parent turn context and ordinal references (PD-02, PD-11)
      let parentRecord: Awaited<ReturnType<typeof getAssistantTurnRecord>> | null = null
      let parentResult: AssistantResult | null = null
      if (body.replyToTurnId) {
        parentRecord = await getAssistantTurnRecord(this.db, body.replyToTurnId, actor.id).catch(() => null)
        if (parentRecord?.turn.result) {
          parentResult = unpackAssistantResultEnvelope(parentRecord.turn.result)
        }
      }

      const isResetIntent = /^(换个场景|换一个场景|换场景|不用刚才那个|重新选)$/i.test(body.question.trim())

      let decision: AssistantRouteDecision | null = null

      // Check ordinal reference against parent clarify options or discovery candidates
      if (!isResetIntent && parentResult) {
        if (parentResult.kind === 'clarify' && parentResult.options?.length) {
          const optIdx = parseOrdinalIndex(body.question, parentResult.options.length)
          if (optIdx !== null) {
            const opt = parentResult.options[optIdx]! as any
            const targetCap = (opt.capabilityId ?? parentRecord?.turn.capabilityId ?? 'scenario.explain') as AssistantCapabilityId
            decision = {
              type: 'dispatch',
              capabilityId: targetCap,
              slots: { ...(parentRecord?.slots ?? {}), ...(opt.slots ?? {}) },
            }
          }
        } else if (parentResult.kind === 'discovery' && parentResult.candidates?.length) {
          const candIdx = parseOrdinalIndex(body.question, parentResult.candidates.length)
          if (candIdx !== null) {
            const cand = parentResult.candidates[candIdx]!
            decision = {
              type: 'dispatch',
              capabilityId: 'scenario.explain',
              slots: {
                ...(parentRecord?.slots ?? {}),
                scenarioId: cand.id,
                targetId: cand.targetId,
              },
            }
          }
        }
      }

      // If no ordinal match, route normally
      if (!decision) {
        decision = routeAssistantTurn({
          question: body.question,
          capabilityHint: body.capabilityHint,
          pageContext: body.pageContext,
          available: availableIds,
        })
      }

      // Slot inheritance from parent turn if applicable
      if (!isResetIntent && parentRecord?.slots && decision.type === 'dispatch') {
        if (!decision.slots.scenarioId && parentRecord.slots.scenarioId) {
          decision.slots.scenarioId = parentRecord.slots.scenarioId
        }
        if (!decision.slots.targetId && parentRecord.slots.targetId) {
          decision.slots.targetId = parentRecord.slots.targetId
        }
      }

      // If parent was in CLARIFY status and new turn is a fresh route, supersede parent (PD-14)
      if (parentRecord?.turn.status === 'CLARIFY' && decision.type === 'dispatch') {
        await cancelAssistantTurn(this.db, {
          turnId: parentRecord.turn.id,
          ownerAccountId: actor.id,
          stopReason: 'superseded_by_new_task',
        }).catch(() => undefined)
      }

      if (decision.type === 'unsupported' && decision.reasonCode === 'TASK_UNSUPPORTED' && session) {
        const classified = await classifyAssistantCapability(
          session,
          cleanAssistantQuestion(body.question),
          availableIds,
          abortController.signal,
          body.pageContext,
        )
        if (classified) {
          decision = routeAssistantTurn({
            question: body.question,
            capabilityHint: classified,
            pageContext: body.pageContext,
            available: availableIds,
          })
        }
      }

      if (
        decision.type === 'unsupported' &&
        decision.reasonCode === 'TASK_UNSUPPORTED' &&
        availableIds.length > 0
      ) {
        decision = clarifyAvailableCapabilities(availableIds)
      }

      // PD-03: Scenario disambiguation when scenarioId is missing
      if (decision.type === 'clarify' && decision.missingFields?.includes('scenarioId')) {
        const kw =
          extractScenarioSearchKeyword(body.question) ||
          /(?:解释|分析|查看|看下)\s*([^\s,，。？?]+?)(?:场景|工作流)/.exec(body.question)?.[1]
        if (kw) {
          const matching = await listScenarios(this.db, { search: kw, limit: 10 }, actor.id).catch(() => ({ items: [] }))
          if (matching.items.length > 1) {
            decision = {
              type: 'clarify',
              question: `找到 ${matching.items.length} 个与“${kw}”相关的场景，请选择具体要操作的场景：`,
              missingFields: ['scenarioId'],
              options: await Promise.all(
                matching.items.map(async (s) => {
                  const target = await this.targets.getTarget(s.targetId).catch(() => null)
                  const targetLabel = target?.name ?? s.targetId.slice(0, 8)
                  return {
                    id: s.id,
                    label: `${s.name} · ${targetLabel}${s.draftDirty ? ' (草稿未保存)' : ''}`,
                    capabilityId: 'scenario.explain',
                    slots: { ...(decision as any).slots, scenarioId: s.id, targetId: s.targetId },
                  }
                }),
              ),
            }
          } else if (matching.items.length === 1) {
            const s = matching.items[0]!
            decision = {
              type: 'dispatch',
              capabilityId: 'scenario.explain',
              slots: { ...(decision as any).slots, scenarioId: s.id, targetId: s.targetId },
            }
          }
        }
      }

      let result: AssistantResult
      let capabilityId: string | null = null
      let slots: Record<string, unknown> | null = null

      if (!decision) {
        throw new Error('Unreachable: decision was not set')
      }

      if (decision.type === 'clarify') {
        result = {
          kind: 'clarify',
          question: decision.question,
          missingFields: decision.missingFields,
          options: decision.options,
        }
      } else if (decision.type === 'unsupported') {
        result = {
          kind: 'unsupported',
          reasonCode: decision.reasonCode,
          message: decision.message,
        }
      } else {
        const routeDecision = decision as Extract<AssistantRouteDecision, { type: 'dispatch' }>
        capabilityId = routeDecision.capabilityId
        slots = routeDecision.slots
        const registration = this.registry.get(capabilityId)
        if (!registration) {
          result = {
            kind: 'unsupported',
            reasonCode: 'CAPABILITY_NOT_FOUND',
            message: `能力未注册: ${capabilityId}`,
          }
        } else {
          // Check permissions
          if (!hasAllPermissions(actor.permissions, registration.descriptor.requiredPermissions)) {
            result = {
              kind: 'unsupported',
              reasonCode: 'PERMISSION_DENIED',
              message: '当前权限不能使用该助手能力',
            }
          } else {
            // Execute capability handler
            result = await registration.handler({
              db: this.db,
              actor,
              slots: routeDecision.slots,
              question: body.question,
              body,
              session,
              platformConfig: this.platformConfig,
              targets: this.targets,
              models: this.models,
              signal: abortController.signal,
              onProgress: async (stage, note) => {
                await recordStage(stage, note)
              },
            })
          }
        }
      }

      await recordStage('persisting')
      const status = result.kind === 'clarify' ? 'CLARIFY' : 'COMPLETED'
      await completeAssistantTurn(this.db, {
        turnId,
        ownerAccountId: actor.id,
        processingToken,
        status,
        capabilityId,
        slots,
        result,
      })
    } catch (error) {
      this.logger.error(`runTurn error:`, error)
      if (abortController.signal.aborted) {
        await completeAssistantTurn(this.db, {
          turnId,
          ownerAccountId: actor.id,
          processingToken,
          status: 'CANCELLED',
          stopReason: 'cancelled',
        }).catch(() => undefined)
      } else {
        const isDomain = error instanceof DomainError
        const hidden = isDomain && (error.kind === 'not_found' || error.kind === 'forbidden')
        await completeAssistantTurn(this.db, {
          turnId,
          ownerAccountId: actor.id,
          processingToken,
          status: hidden ? 'COMPLETED' : 'FAILED',
          stopReason: isDomain ? error.code : 'provider_error',
          result: hidden
            ? { kind: 'inaccessible', message: '相关运行或目标已不可访问' }
            : {
                kind: 'unsupported',
                reasonCode: isDomain ? error.code : 'TURN_FAILED',
                message: error instanceof Error ? error.message : '助手处理失败',
              },
        }).catch(() => undefined)
      }
    } finally {
      this.activeRuns.delete(turnId)
      await this.hints
        .publish({
          namespace: this.hints.namespace,
          eventSeq: currentSeq + 1,
          objectType: 'assistant_turn',
          objectId: turnId,
        })
        .catch(() => undefined)

      // AIF-23: When a slot frees up, dequeue next turn FIFO
      void this.promoteNextQueuedTurn()
    }
  }

  /**
   * Record a stream event (event / thinking / output) in database.
   */
  private async recordEvent(
    turnId: string,
    channel: 'event' | 'thinking' | 'output',
    payload: Record<string, unknown>,
    seq = 0,
  ): Promise<void> {
    // Thinking deltas have 7 days short retention
    const retainUntil =
      channel === 'thinking' ? new Date(Date.now() + 7 * 24 * 3600 * 1000) : null

    await recordAssistantTurnEvent(this.db, {
      turnId,
      seq,
      channel,
      payload,
      retainUntil,
    })
  }

  /**
   * AIF-23: Promote next queued turn if any.
   */
  async promoteNextQueuedTurn(): Promise<void> {
    try {
      const config = await this.platformConfig.get().catch(() => null)
      const platformAi = config?.document.platformAi
      const promotedTurn = await nextQueuedAssistantTurn(
        this.db,
        {
          userLimit: platformAi?.userInflightLimit ?? 4,
          platformLimit: platformAi?.platformInflightLimit ?? 16,
        },
        platformAi?.turnTimeoutMs ?? 60_000,
        {
          ownerInstanceId: this.ownerInstanceId,
          leaseDurationMs: 15_000,
        },
      ).catch(() => null)

      if (!promotedTurn) return

      const turn = promotedTurn.turn
      const cached = this.queuedExecutions.get(turn.id)
      const deadlineAt = new Date(Date.now() + (platformAi?.turnTimeoutMs ?? 60_000))

      if (cached) {
        this.startExecution(
          turn.id,
          cached.actor,
          cached.body,
          promotedTurn.processingToken,
          deadlineAt,
          promotedTurn.epoch,
        )
        return
      }

      // No cached execution (e.g. server restart): mark turn INTERRUPTED, never synthesize fake actor
      this.logger.warn(`Turn ${turn.id} lost execution context on restart, marking INTERRUPTED`)
      await completeAssistantTurn(this.db, {
        turnId: turn.id,
        ownerAccountId: promotedTurn.ownerAccountId,
        processingToken: promotedTurn.processingToken,
        status: 'INTERRUPTED',
        stopReason: 'REQUEST_LOST_ON_RESTART',
        result: {
          kind: 'unsupported',
          reasonCode: 'REQUEST_LOST_ON_RESTART',
          message: '服务重启导致排队请求上下文丢失，请重新发起对话。',
        },
      }).catch(() => undefined)

      await this.recordEvent(
        turn.id,
        'event',
        {
          type: 'interrupted',
          reason: 'REQUEST_LOST_ON_RESTART',
          message: '服务重启导致排队请求上下文丢失，请重新发起对话。',
        },
        1,
      ).catch(() => undefined)
    } catch {
      // Ignore background promotion errors during shutdown/mocking
    }
  }
}
