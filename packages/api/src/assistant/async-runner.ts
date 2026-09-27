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
  inferAssistantCapability,
  normalizeAssistantPageContext,
  routeAssistantTurn,
  unpackAssistantResultEnvelope,
} from '@cairn/shared'
import {
  type ChangeHintBus,
  type DbHandle,
  DomainError,
  assertTargetPermission,
  cancelAssistantTurn,
  completeAssistantTurn,
  getAssistantTurnRecord,
  getScenario,
  listScenarios,
  nextQueuedAssistantTurn,
  recordAssistantTurnEvent,
  renewAssistantTurnLease,
  updateAssistantTurnStage,
  RbacStore,
} from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { TargetsService } from '../targets/targets.service'
import { createOpenAiCompatibleClient, type PlatformModelClient } from './model-client'
import { AssistantModelSession, classifyAssistantCapability, supervisorRouteWithLlm } from './model-session'
import { AssistantCapabilityRegistry } from './registry'
import type { RequestAccount as Actor } from '../common/request-account'

import { AuthService } from '../auth/auth.service'

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
  private heartbeatTimer: NodeJS.Timeout | null = null

  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    @Inject(CHANGE_HINT) private readonly hints: ChangeHintBus,
    private readonly platformConfig: PlatformConfigService,
    private readonly targets: TargetsService,
    private readonly registry: AssistantCapabilityRegistry,
    @Optional() private readonly models: PlatformModelClient = createOpenAiCompatibleClient(),
    @Optional() private readonly auth?: AuthService,
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
   * @deprecated 排队上下文已持久化至数据库 assistant_turns.request_payload，不再使用内存注册。
   */
  registerQueued(
    _turnId: string,
    _actor: Actor,
    _body: CreateAssistantTurnBody,
    _processingToken: string,
  ): void {
    // No-op: request payload is persisted directly in database
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
      const isNextPageIntent = /^(下一页|继续找|加载更多|查看更多)(?:\s*[/／]\s*继续找)?[！!。.\s]*$/.test(body.question.trim())

      let decision: AssistantRouteDecision | null = null

      // Check selected option or ordinal reference against parent clarify options or discovery candidates
      if (!isResetIntent && parentResult) {
        if (
          isNextPageIntent &&
          parentResult.kind === 'discovery' &&
          parentRecord?.turn.capabilityId === 'scenario.discover' &&
          parentResult.coverage.nextCursor &&
          availableIds.includes('scenario.discover')
        ) {
          decision = {
            type: 'dispatch',
            capabilityId: 'scenario.discover',
            slots: {
              ...(parentRecord.slots ?? {}),
              cursor: parentResult.coverage.nextCursor,
            },
          }
        } else if (parentResult.kind === 'clarify' && parentResult.options?.length) {
          let chosenOpt: (typeof parentResult.options)[number] | null = null
          if (body.selectedOptionId) {
            chosenOpt = parentResult.options.find((o) => o.id === body.selectedOptionId) ?? null
          }
          if (!chosenOpt) {
            const optIdx = parseOrdinalIndex(body.question, parentResult.options.length)
            if (optIdx !== null) {
              chosenOpt = parentResult.options[optIdx] ?? null
            }
          }
          if (!chosenOpt) {
            chosenOpt =
              parentResult.options.find(
                (o) => o.id === body.question.trim() || o.label === body.question.trim(),
              ) ?? null
          }

          if (chosenOpt) {
            const opt = chosenOpt as any
            const continuation = (parentRecord?.slots as any)?.continuation
            const targetCap = (opt.capabilityId ??
              continuation?.intentCapabilityId ??
              parentRecord?.turn.capabilityId ??
              'scenario.explain') as AssistantCapabilityId

            if (opt.kind === 'scenario' || continuation?.scenarioOptions) {
              const selectedScenarioId = opt.id
              const scenarioSummary = continuation?.scenarioOptions?.find(
                (item: any) => item.scenarioId === selectedScenarioId,
              )
              let targetId = scenarioSummary?.targetId
              if (!targetId) {
                const sc = await getScenario(this.db, selectedScenarioId).catch(() => null)
                targetId = sc?.targetId
              }

              if (targetId) {
                const requiredTargetPerms =
                  targetCap === 'scenario.propose-step'
                    ? ['target:read', 'workflow:write']
                    : ['target:read']
                if (!hasAllPermissions(actor.permissions, requiredTargetPerms)) {
                  decision = {
                    type: 'unsupported',
                    reasonCode: 'PERMISSION_DENIED',
                    message: `缺少操作所选场景所需的目标权限 (${requiredTargetPerms.join(', ')})`,
                  }
                } else {
                  try {
                    if (actor.id) {
                      for (const p of requiredTargetPerms) {
                        await assertTargetPermission(this.db, actor.id, targetId, p as any)
                      }
                    }
                    await this.targets.getTarget(targetId)
                    decision = {
                      type: 'dispatch',
                      capabilityId: targetCap,
                      slots: {
                        ...(parentRecord?.slots ?? {}),
                        scenarioId: selectedScenarioId,
                        targetId,
                        ...(continuation?.slots ?? {}),
                      },
                    }
                  } catch {
                    decision = {
                      type: 'unsupported',
                      reasonCode: 'TARGET_FORBIDDEN',
                      message: '没有所选场景所属目标系统的访问权限',
                    }
                  }
                }
              } else {
                decision = {
                  type: 'dispatch',
                  capabilityId: targetCap,
                  slots: {
                    ...(parentRecord?.slots ?? {}),
                    scenarioId: selectedScenarioId,
                    ...(continuation?.slots ?? {}),
                  },
                }
              }
            } else if (opt.kind === 'capability') {
              decision = {
                type: 'dispatch',
                capabilityId: opt.id as AssistantCapabilityId,
                slots: {
                  ...(parentRecord?.slots ?? {}),
                  ...(continuation?.slots ?? {}),
                  ...(opt.slots ?? {}),
                },
              }
            } else {
              decision = {
                type: 'dispatch',
                capabilityId: targetCap,
                slots: {
                  ...(parentRecord?.slots ?? {}),
                  ...(continuation?.slots ?? {}),
                  ...(opt.slots ?? {}),
                  ...(opt.id && !opt.capabilityId ? { scenarioId: opt.id } : {}),
                },
              }
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

      // 1. If explicit capabilityHint provided or parent clarify selected, route directly
      if (!decision && body.capabilityHint) {
        decision = routeAssistantTurn({
          question: body.question,
          capabilityHint: body.capabilityHint,
          pageContext: body.pageContext,
          available: availableIds,
        })
      }

      // 2. 100% LLM Supervisor routing when session (platform AI) is available and no explicit hint
      if (!decision && session && !body.capabilityHint) {
        const skills = availableDescriptors.map((desc) => ({
          id: desc.id as AssistantCapabilityId,
          label: desc.label,
          purpose: desc.purpose,
        }))
        const supervisorRoute = await supervisorRouteWithLlm(
          session,
          cleanAssistantQuestion(body.question),
          skills,
          body.pageContext,
          abortController.signal,
        )

        if (
          supervisorRoute &&
          supervisorRoute.skillId !== 'none' &&
          availableIds.includes(supervisorRoute.skillId as AssistantCapabilityId) &&
          supervisorRoute.confidence >= 0.5
        ) {
          const chosen = supervisorRoute.skillId as AssistantCapabilityId
          const normalizedContext = normalizeAssistantPageContext(body.pageContext)
          const fallbackSlots: Record<string, unknown> = {}
          if (normalizedContext?.runId) fallbackSlots.runId = normalizedContext.runId
          if (normalizedContext?.scenarioId) fallbackSlots.scenarioId = normalizedContext.scenarioId
          if (normalizedContext?.targetId) fallbackSlots.targetId = normalizedContext.targetId
          if (normalizedContext?.stepId) fallbackSlots.stepId = normalizedContext.stepId
          if (normalizedContext?.draftRevision) fallbackSlots.draftRevision = normalizedContext.draftRevision
          if (normalizedContext?.versionId) fallbackSlots.versionId = normalizedContext.versionId

          if (chosen === 'knowledge.answer') {
            decision = {
              type: 'dispatch',
              capabilityId: 'knowledge.answer',
              slots: {
                ...fallbackSlots,
                ...supervisorRoute.slots,
              },
            }
          } else {
            const tentative = routeAssistantTurn({
              question: body.question,
              capabilityHint: chosen,
              pageContext: body.pageContext,
              available: availableIds,
            })
            if (tentative.type === 'dispatch') {
              decision = {
                ...tentative,
                slots: {
                  ...tentative.slots,
                  ...supervisorRoute.slots,
                },
              }
            } else if (
              tentative.type === 'clarify' &&
              tentative.missingFields?.includes('capabilityId')
            ) {
              // 遗留正则竞争命中了其他关键词（如"运行"、"对比"），但已被 Supervisor LLM 明确裁决；以 Supervisor 裁决为准
              decision = {
                type: 'dispatch',
                capabilityId: chosen,
                slots: {
                  ...fallbackSlots,
                  ...supervisorRoute.slots,
                },
              }
            } else {
              decision = tentative
            }
          }
        } else if (supervisorRoute && (supervisorRoute.confidence < 0.5 || supervisorRoute.skillId === 'none')) {
          decision = clarifyAvailableCapabilities(availableIds)
        }
      }

      // 3. Fallback for offline/test environments without active AI session
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

      if (
        decision.type === 'unsupported' &&
        decision.reasonCode === 'TASK_UNSUPPORTED' &&
        availableIds.length > 0
      ) {
        decision = clarifyAvailableCapabilities(availableIds)
      }

      // PD-03: Scenario disambiguation when scenarioId is missing
      if (decision.type === 'clarify' && decision.missingFields?.includes('scenarioId')) {
        const originalCapId: AssistantCapabilityId =
          (decision as any).capabilityId ??
          (body.capabilityHint as AssistantCapabilityId) ??
          (inferAssistantCapability(body.question) ?? 'scenario.explain')

        const kw =
          extractScenarioSearchKeyword(body.question) ||
          /(?:解释|分析|查看|看下|编排|修改|更新)\s*([^\s,，。？?]+?)(?:场景|工作流)/.exec(body.question)?.[1]
        if (kw) {
          const matching = await listScenarios(this.db, { search: kw, limit: 100 }, actor.id).catch(() => ({ items: [] }))
          if (matching.items.length > 1) {
            const candidates = matching.items.slice(0, 8)
            const prompt =
              matching.items.length > 8
                ? `为您找到 ${matching.items.length} 个与“${kw}”相关的场景（已展示前 8 个），请选择具体要操作的场景或提供更精确的关键词：`
                : `找到 ${matching.items.length} 个与“${kw}”相关的场景，请选择具体要操作的场景：`

            const options = await Promise.all(
              candidates.map(async (s) => {
                const target = await this.targets.getTarget(s.targetId).catch(() => null)
                const targetLabel = target?.name ?? s.targetId.slice(0, 8)
                return {
                  id: s.id,
                  label: s.name,
                  kind: 'scenario' as const,
                  targetName: targetLabel,
                }
              }),
            )

            decision = {
              type: 'clarify',
              question: prompt,
              missingFields: ['scenarioId'],
              options,
              slots: {
                ...((decision as any).slots ?? {}),
                continuation: {
                  intentCapabilityId: originalCapId,
                  keyword: kw,
                  scenarioOptions: candidates.map((s) => ({ scenarioId: s.id, targetId: s.targetId })),
                },
              },
            } as any
          } else if (matching.items.length === 1) {
            const s = matching.items[0]!
            decision = {
              type: 'dispatch',
              capabilityId: originalCapId,
              slots: { ...((decision as any).slots ?? {}), scenarioId: s.id, targetId: s.targetId },
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
        slots = (decision as any).slots ?? null
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
      const reasoningInfo = session?.getReasoningInfo()
      await completeAssistantTurn(this.db, {
        turnId,
        ownerAccountId: actor.id,
        processingToken,
        status,
        capabilityId,
        slots,
        result,
        thinkingDurationMs: reasoningInfo?.durationMs != null ? Math.round(reasoningInfo.durationMs) : undefined,
      })
    } catch (error) {
      this.logger.error(`runTurn error:`, error)
      const reasoningInfo = session?.getReasoningInfo()
      if (abortController.signal.aborted) {
        await completeAssistantTurn(this.db, {
          turnId,
          ownerAccountId: actor.id,
          processingToken,
          status: 'CANCELLED',
          stopReason: 'cancelled',
          thinkingDurationMs: reasoningInfo?.durationMs != null ? Math.round(reasoningInfo.durationMs) : undefined,
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
                message: isDomain ? error.message : '助手处理失败，请稍后重试',
              },
          thinkingDurationMs: reasoningInfo?.durationMs != null ? Math.round(reasoningInfo.durationMs) : undefined,
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

  /** Record a public stage event in database. */
  private async recordEvent(
    turnId: string,
    channel: 'event',
    payload: Record<string, unknown>,
    seq = 0,
  ): Promise<void> {
    await recordAssistantTurnEvent(this.db, {
      turnId,
      seq,
      channel,
      payload,
      retainUntil: null,
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
      const deadlineAt = new Date(Date.now() + (platformAi?.turnTimeoutMs ?? 60_000))
      const payload = (promotedTurn.requestPayload as CreateAssistantTurnBody | null) ?? null

      if (payload) {
        const actor = await this.resolveActor(promotedTurn.ownerAccountId)
        if (actor) {
          this.startExecution(
            turn.id,
            actor,
            payload,
            promotedTurn.processingToken,
            deadlineAt,
            promotedTurn.epoch,
          )
          return
        }
      }

      // No persisted execution context or unresolvable account: mark turn INTERRUPTED, never synthesize fake actor
      this.logger.warn(`Turn ${turn.id} lost execution context on restart or missing payload, marking INTERRUPTED`)
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

  private async resolveActor(accountId: string): Promise<Actor | null> {
    if (this.auth) {
      return this.auth.resolveAccount(accountId).catch(() => null)
    }
    try {
      const rbac = new RbacStore(this.db as any, {
        hash: async () => '',
        verify: async () => false,
      })
      const acc = await rbac.getAccount(accountId)
      if (!acc) return null
      return {
        id: acc.id,
        displayName: acc.displayName,
        email: acc.email,
        status: acc.status,
        roles: acc.roles,
        permissions: acc.permissions,
        targetScopes: acc.targetScopes,
        targetScopePermissions: acc.targetScopePermissions,
      }
    } catch {
      return null
    }
  }
}
