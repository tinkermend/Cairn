import { compileForAssistant } from '@cairn/authoring'
import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import {
  applyStepProposal,
  assistantCapability,
  assistantFocusSchema,
  assistantGuideTopicSchema,
  availableAssistantCapabilities,
  canonicalJson,
  citationKey,
  compareCompileDiagnostics,
  createAssistantTurnBodySchema,
  filterGuideCatalog,
  hasAllPermissions,
  projectRunFacts,
  routeAssistantTurn,
  hasPermission,
  parseScenarioDocument,
  isAuthoringDocumentV2,
  scenarioDocumentDigest,
  scenarioFactsForModel,
  sha256Hex,
  type AssistantPageContext,
  type AssistantResult,
  type AssistantRouteDecision,
  type AssistantStepChange,
  type CreateAssistantTurnBody,
  type ScenarioDocument,
} from '@cairn/shared'
import {
  DomainError,
  beginAssistantTurn,
  completeAssistantTurn,
  createAssistantConversation,
  getAssistantTurnRecord,
  getRun,
  getScenario,
  interruptExpiredAssistantTurns,
  listAssistantConversations,
  listAssistantTurnRecords,
  loadRunObservation,
  loadScenarioVersion,
  type DbHandle,
} from '@cairn/db'
import { DB_HANDLE } from '../db/db.module'
import { rethrowDomain } from '../common/domain-error'
import { composeScenarioKnowledge } from '../scenarios/knowledge-operations'
import { redactKnowledgeQuestion } from '@cairn/map'
import { PlatformConfigService } from '../platform-config/platform-config.service'
import { TargetsService } from '../targets/targets.service'
import { createOpenAiCompatibleClient, type PlatformModelClient } from './model-client'
import {
  AssistantModelSession,
  classifyAssistantCapability,
  generateDiagnosisHypotheses,
  generateExplanationText,
  generateStepChange,
} from './model-session'
import type { RequestAccount as Actor } from '../common/request-account'

const TITLE_MAX = 40

function redactQuestion(question: string): string {
  return redactKnowledgeQuestion(question)
}

function conversationTitle(question: string): string {
  const text = redactQuestion(question).replace(/\s+/g, ' ').trim()
  return text.length <= TITLE_MAX ? text || '新对话' : `${text.slice(0, TITLE_MAX - 1)}…`
}

function isUnsupportedChange(
  change: AssistantStepChange | Extract<AssistantResult, { kind: 'unsupported' }>,
): change is Extract<AssistantResult, { kind: 'unsupported' }> {
  return 'reasonCode' in change
}

function requireFlatDocument(document: unknown): ScenarioDocument {
  if (isAuthoringDocumentV2(document) && document.nodes.every(node => node.kind === 'step')) {
    return parseScenarioDocument({ schemaVersion: document.schemaVersion, inputs: document.inputs, steps: document.nodes.flatMap(node => node.kind === 'step' ? [node.step] : []) })
  }
  if (document && typeof document === 'object' && 'authoringSchemaVersion' in document) {
    throw new DomainError('bad_request', 'AUTHORING_SCHEMA_UNSUPPORTED', '含模块调用的草稿不支持扁平知识建议')
  }
  return parseScenarioDocument(document)
}

@Injectable()
export class AssistantService {
  constructor(
    @Inject(DB_HANDLE) private readonly db: DbHandle,
    private readonly platformConfig: PlatformConfigService,
    private readonly targets: TargetsService,
    @Optional() private readonly _models: PlatformModelClient = createOpenAiCompatibleClient(),
  ) {}

  async capabilities(actor: Actor) {
    const access = await this.platformConfig.resolvePlatformAiAccess()
    return {
      items: availableAssistantCapabilities(actor.permissions),
      modelEnabled: access !== null,
    }
  }

  async createConversation(actor: Actor, body: { idempotencyKey?: string }, question?: string) {
    this.requireAssist(actor)
    return createAssistantConversation(this.db, {
      ownerAccountId: actor.id,
      title: conversationTitle(question ?? '新对话'),
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

  async createTurn(
    actor: Actor,
    conversationId: string,
    body: CreateAssistantTurnBody,
    signal?: AbortSignal,
  ) {
    this.requireAssist(actor)
    const parsed = createAssistantTurnBodySchema.parse(body)
    await interruptExpiredAssistantTurns(this.db).catch(rethrowDomain)
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
    }).catch(rethrowDomain)
    if (started.replay) return started.turn

    const access = await this.platformConfig.resolvePlatformAiAccess()
    const session = access
      ? new AssistantModelSession(
          this.db,
          started.turn.id,
          { ...access, deadlineAt },
          this._models,
        )
      : null

    try {
      const available = availableAssistantCapabilities(actor.permissions)
        .filter((item) => item.available)
        .map((item) => item.id)
      let decision = routeAssistantTurn({
        question: parsed.question,
        capabilityHint: parsed.capabilityHint,
        pageContext: parsed.pageContext,
        available,
      })
      if (
        decision.type === 'unsupported' &&
        decision.reasonCode === 'TASK_UNSUPPORTED' &&
        session
      ) {
        const classified = await classifyAssistantCapability(
          session,
          parsed.question,
          available,
          signal,
        )
        if (classified) {
          decision = routeAssistantTurn({
            question: parsed.question,
            capabilityHint: classified,
            pageContext: parsed.pageContext,
            available,
          })
        }
      }
      const result = await this.dispatch(actor, decision, parsed, platformAi, session, signal)
      const status = result.kind === 'clarify' ? 'CLARIFY' : 'COMPLETED'
      return await completeAssistantTurn(this.db, {
        turnId: started.turn.id,
        ownerAccountId: actor.id,
        processingToken,
        status,
        capabilityId: decision.type === 'dispatch' ? decision.capabilityId : null,
        slots: decision.type === 'dispatch' ? decision.slots : null,
        result,
      }).catch(rethrowDomain)
    } catch (error) {
      if (signal?.aborted) {
        await completeAssistantTurn(this.db, {
          turnId: started.turn.id,
          ownerAccountId: actor.id,
          processingToken,
          status: 'CANCELLED',
        }).catch(() => undefined)
        rethrowDomain(error)
      }
      const hidden =
        error instanceof DomainError && (error.kind === 'not_found' || error.kind === 'forbidden')
      await completeAssistantTurn(this.db, {
        turnId: started.turn.id,
        ownerAccountId: actor.id,
        processingToken,
        status: hidden ? 'COMPLETED' : 'FAILED',
        result: hidden
          ? { kind: 'inaccessible', message: '相关运行或目标已不可访问' }
          : {
              kind: 'unsupported',
              reasonCode: 'TURN_FAILED',
              message: error instanceof Error ? error.message : '助手处理失败',
            },
      }).catch(() => undefined)
      rethrowDomain(error)
    }
  }

  private requireAssist(actor: Actor) {
    if (!hasAllPermissions(actor.permissions, ['ai:assist'])) {
      rethrowDomain(new DomainError('forbidden', 'ASSISTANT_FORBIDDEN', '当前角色不能使用平台助手'))
    }
  }

  private async dispatch(
    actor: Actor,
    decision: AssistantRouteDecision,
    body: CreateAssistantTurnBody,
    platformAi: { maxOutputTokens: number },
    session: AssistantModelSession | null,
    signal?: AbortSignal,
  ): Promise<AssistantResult> {
    if (decision.type === 'clarify') {
      return {
        kind: 'clarify',
        question: decision.question,
        missingFields: decision.missingFields,
        options: decision.options,
      }
    }
    if (decision.type === 'unsupported') {
      return { kind: 'unsupported', reasonCode: decision.reasonCode, message: decision.message }
    }
    const capabilityId = decision.capabilityId
    const required = assistantCapability(capabilityId).requiredPermissions
    if (!hasAllPermissions(actor.permissions, required)) {
      throw new DomainError('forbidden', 'ASSISTANT_FORBIDDEN', '当前权限不能使用该助手能力')
    }
    if (capabilityId === 'platform.guide') {
      return this.guide(actor, decision.slots)
    }
    if (capabilityId === 'run.diagnose') {
      if (!hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) {
        throw new DomainError('forbidden', 'TARGET_FORBIDDEN', '没有该目标系统的访问权限，助手不能继续')
      }
      return this.diagnose(actor, decision.slots, body, session, signal)
    }
    if (capabilityId === 'scenario.explain') {
      return this.explain(actor, decision.slots, body.question, session, signal)
    }
    if (capabilityId === 'scenario.compose_with_knowledge') {
      return this.composeWithKnowledge(actor, decision.slots, body.question)
    }
    return this.propose(actor, decision.slots, body.question, platformAi, session, signal)
  }

  private async composeWithKnowledge(actor: Actor, slots: Record<string, unknown>, question: string) {
    const scenarioId = String(slots.scenarioId ?? '')
    const draftRevision = Number(slots.draftRevision)
    const detail = await getScenario(this.db, scenarioId).catch(rethrowDomain)
    await this.requireVisibleTarget(actor, detail.targetId)
    if (!detail.draft || detail.draft.revision !== draftRevision) {
      throw new DomainError('conflict', 'ASSISTANT_DRAFT_STALE', '请基于当前已保存草稿重新生成')
    }
    const document = requireFlatDocument(detail.draft.document)
    const digest = await scenarioDocumentDigest(document)
    const config = await this.platformConfig.get()
    const composed = await composeScenarioKnowledge(this.db, scenarioId, {
      idempotencyKey: `asst-${crypto.randomUUID()}`, question: redactKnowledgeQuestion(question),
      expectedDraftRevision: draftRevision, documentDigest: digest,
    }, actor, config.revision).catch(rethrowDomain)
    return {
      kind: 'knowledge_proposal' as const,
      proposalId: composed.proposalId,
      status:
        composed.proposalStatus === 'requested' || composed.proposalStatus === 'cancelled'
          ? 'failed'
          : composed.proposalStatus,
      reason: composed.diagnostics[0]?.message ?? '已生成知识建议，采纳后才会写入草稿。',
      diffs: composed.diffs,
      diagnostics: composed.diagnostics.map((item) => ({
        code: item.code,
        message: item.message,
        fieldPath: item.fieldPath,
      })),
      sources: composed.sources,
      unknowns: composed.unknowns,
      executable: composed.proposalStatus === 'proposed',
      draftRevision,
      documentDigest: digest,
    }
  }

  private guide(actor: Actor, slots: Record<string, unknown>): AssistantResult {
    const topic = assistantGuideTopicSchema.safeParse(slots.topic).success
      ? assistantGuideTopicSchema.parse(slots.topic)
      : undefined
    const items = filterGuideCatalog(actor.permissions, topic)
    if (items.length === 0) {
      return {
        kind: 'unsupported',
        reasonCode: 'GUIDE_UNAVAILABLE',
        message: '当前权限不能打开该入口。',
      }
    }
    return { kind: 'guide', items }
  }

  private async requireVisibleTarget(actor: Actor, targetId: string) {
    if (!hasAllPermissions(actor.permissions, ['target:read'])) {
      throw new DomainError('forbidden', 'TARGET_FORBIDDEN', '没有该目标系统的访问权限，助手不能继续')
    }
    try {
      await this.targets.getTarget(targetId)
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new DomainError('not_found', 'TARGET_NOT_FOUND', '目标系统不存在')
      }
      throw error
    }
  }

  private async diagnose(
    actor: Actor,
    slots: Record<string, unknown>,
    body: CreateAssistantTurnBody,
    session: AssistantModelSession | null,
    signal?: AbortSignal,
  ) {
    const runId = String(slots.runId ?? body.pageContext?.runId ?? '')
    const observation = await loadRunObservation(this.db, runId).catch(rethrowDomain)
    if (!observation) throw new DomainError('not_found', 'RUN_NOT_FOUND', '运行不存在')
    await this.requireVisibleTarget(actor, observation.run.targetId)
    const focus = assistantFocusSchema.safeParse(slots.focus).success
      ? assistantFocusSchema.parse(slots.focus)
      : 'overview'
    const pack = projectRunFacts(observation, {
      stepId: typeof slots.stepId === 'string' ? slots.stepId : body.pageContext?.stepId,
      focus,
      now: new Date().toISOString(),
    })
    const nextActions = [...pack.nextActions]
    if (hasAllPermissions(actor.permissions, ['target:read'])) {
      nextActions.push({
        kind: 'target.accounts',
        label: '查看目标账号',
        href: `/targets/${observation.run.targetId}`,
        citations: [citationKey('run', observation.run.id)],
      })
    }
    if (hasAllPermissions(actor.permissions, ['workflow:read'])) {
      nextActions.push({
        kind: 'studio.step',
        label: '打开场景工作区',
        href: `/scenarios/${observation.run.scenarioId}`,
        citations: [citationKey('run', observation.run.id)],
      })
    }
    const missingInformation = [...pack.missingInformation]
    let hypotheses: Awaited<ReturnType<typeof generateDiagnosisHypotheses>>['hypotheses'] = []
    if (session) {
      const generated = await generateDiagnosisHypotheses(
        session,
        body.question,
        pack.text,
        pack.citations,
        signal,
      )
      hypotheses = generated.hypotheses
      if (generated.error) missingInformation.push('模型未能提出经引用校验的可能原因')
      else if (hypotheses.length === 0) missingInformation.push('模型没有给出可引用的可能原因')
    }
    return {
      kind: 'diagnosis' as const,
      observedAt: new Date().toISOString(),
      eventSeq: observation.eventSeq,
      facts: pack.facts,
      hypotheses,
      missingInformation,
      nextActions,
    }
  }

  private async explain(
    actor: Actor,
    slots: Record<string, unknown>,
    question: string,
    session: AssistantModelSession | null,
    signal?: AbortSignal,
  ) {
    const scenarioId = String(slots.scenarioId ?? '')
    const detail = await getScenario(this.db, scenarioId).catch(rethrowDomain)
    await this.requireVisibleTarget(actor, detail.targetId)
    const document = await this.loadExplainDocument(detail, slots)
    if (!document) {
      return {
        kind: 'clarify' as const,
        question: '请指定要解释的已保存草稿或已发布版本。',
        missingFields: ['definitionRef'],
      }
    }
    const compile = compileForAssistant(document)
    const step = typeof slots.stepId === 'string' ? document.steps.find((item) => item.id === slots.stepId) : undefined
    let summary = `场景「${detail.name}」共 ${document.steps.length} 步，绑定目标 ${detail.targetId}。本轮解释的是已保存定义。`
    let stepSummary = step ? `当前步骤「${step.name}」类型为 ${step.type}。` : undefined
    if (session) {
      const polished = await generateExplanationText(
        session,
        question,
        scenarioFactsForModel(document, typeof slots.stepId === 'string' ? slots.stepId : undefined),
        signal,
      )
      if (polished.summary) summary = polished.summary
      if (polished.stepSummary) stepSummary = polished.stepSummary
    }
    return {
      kind: 'explanation' as const,
      summary,
      stepSummary,
      references: document.steps.flatMap((item) =>
        'from' in item.input && item.input.from ? [`${item.name} 引用 ${item.input.from}`] : [],
      ),
      diagnostics: compile.diagnostics.map((item) => ({
        code: item.code,
        stepId: item.stepId,
        fieldPath: item.fieldPath,
        message: item.message,
        baseline: true,
      })),
      executable: compile.ok,
    }
  }

  private async loadExplainDocument(
    detail: Awaited<ReturnType<typeof getScenario>>,
    slots: Record<string, unknown>,
  ): Promise<ScenarioDocument | null> {
    if (slots.draftRevision != null) {
      const revision = Number(slots.draftRevision)
      if (!detail.draft || detail.draft.revision !== revision) {
        throw new DomainError('conflict', 'ASSISTANT_DRAFT_STALE', '请基于当前已保存草稿重新解释')
      }
      return requireFlatDocument(detail.draft.document)
    }
    if (typeof slots.versionId === 'string' && slots.versionId) {
      const loaded = await loadScenarioVersion(this.db, detail.id, slots.versionId).catch(rethrowDomain)
      return loaded.version.definition
    }
    return null
  }

  private async propose(
    actor: Actor,
    slots: Record<string, unknown>,
    question: string,
    platformAi: { maxOutputTokens: number },
    session: AssistantModelSession | null,
    signal?: AbortSignal,
  ) {
    const scenarioId = String(slots.scenarioId ?? '')
    const stepId = String(slots.stepId ?? '')
    const draftRevision = Number(slots.draftRevision)
    const detail = await getScenario(this.db, scenarioId).catch(rethrowDomain)
    await this.requireVisibleTarget(actor, detail.targetId)
    if (!detail.draft || detail.draft.revision !== draftRevision) {
      throw new DomainError('conflict', 'ASSISTANT_DRAFT_STALE', '请基于当前已保存草稿重新生成')
    }
    const document = requireFlatDocument(detail.draft.document)
    const change = await this.proposeChange(
      document,
      stepId,
      question,
      platformAi.maxOutputTokens,
      session,
      signal,
    )
    if (isUnsupportedChange(change)) return change
    const applied = applyStepProposal(document, stepId, change)
    if (!applied.ok) {
      return {
        kind: 'unsupported' as const,
        reasonCode: applied.error.code,
        message: applied.error.message,
      }
    }
    const baseline = compileForAssistant(document)
    const next = compileForAssistant(applied.document)
    const compared = compareCompileDiagnostics(baseline.diagnostics, next.diagnostics)
    if (compared.added.some((item) => item.severity === 'error')) {
      return {
        kind: 'unsupported' as const,
        reasonCode: 'COMPILER_REGRESSION',
        message: compared.added[0]?.message ?? '候选引入了新的编译错误',
      }
    }
    return {
      kind: 'proposal' as const,
      change,
      document: applied.document,
      stepId,
      draftRevision,
      documentDigest: await scenarioDocumentDigest(document),
      reason: '已按你的要求生成受限单步候选，采纳后仍需保存并试跑。',
      diffs: applied.diffs,
      diagnostics: next.diagnostics.map((item) => ({
        code: item.code,
        stepId: item.stepId,
        fieldPath: item.fieldPath,
        message: item.message,
        baseline: compared.leftover.some(
          (left) => left.code === item.code && left.stepId === item.stepId,
        ),
      })),
      executable: next.ok,
    }
  }

  private async proposeChange(
    document: ScenarioDocument,
    stepId: string,
    question: string,
    maxInstructionChars: number,
    session: AssistantModelSession | null,
    signal?: AbortSignal,
  ): Promise<AssistantStepChange | Extract<AssistantResult, { kind: 'unsupported' }>> {
    const constructed = this.constructStepChange(document, stepId, question, maxInstructionChars)
    if (!isUnsupportedChange(constructed)) return constructed
    if (constructed.reasonCode === 'STEP_NOT_FOUND' || !session) return constructed
    const generated = await generateStepChange(
      session,
      question,
      scenarioFactsForModel(document, stepId),
      signal,
    )
    if (generated.change) return generated.change
    return constructed
  }

  private constructStepChange(
    document: ScenarioDocument,
    stepId: string,
    question: string,
    maxInstructionChars: number,
  ): AssistantStepChange | Extract<AssistantResult, { kind: 'unsupported' }> {
    const step = document.steps.find((item) => item.id === stepId)
    if (!step) {
      return { kind: 'unsupported', reasonCode: 'STEP_NOT_FOUND', message: '步骤不在该草稿中' }
    }
    if (step.type === 'fill') {
      const match = /引用\s*([a-zA-Z][\w-]*)/.exec(question) ?? /from\s+([a-zA-Z][\w-]*)/.exec(question)
      if (!match) {
        return { kind: 'unsupported', reasonCode: 'NEED_BINDING', message: '请指明要引用的前序输出或输入名称' }
      }
      return { kind: 'fill_binding', from: match[1]! }
    }
    if (step.type === 'assert') {
      const text = /改成[「"](.+?)[」"]/.exec(question)?.[1]
      if (!text) {
        return { kind: 'unsupported', reasonCode: 'NEED_EXPECTATION', message: '请明确新的断言预期文字' }
      }
      return { kind: 'assert_expectation', expect: { kind: 'text_contains', value: text } }
    }
    if (step.type.startsWith('ai_')) {
      const instruction = question.replace(/^(把|请|帮我)?(这条)?(AI)?指令/, '').trim() || question
      return { kind: 'ai_instruction', instruction: instruction.slice(0, maxInstructionChars) }
    }
    return { kind: 'unsupported', reasonCode: 'STEP_TYPE_UNSUPPORTED', message: '一期不能修改这类步骤' }
  }

  private async sanitizeStoredTurn(
    actor: Actor,
    turn: Awaited<ReturnType<typeof getAssistantTurnRecord>>['turn'],
    slots: Record<string, unknown> | null,
  ) {
    if (!turn.result || turn.result.kind === 'inaccessible' || turn.result.kind === 'clarify') return turn
    if (turn.result.kind === 'guide') {
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
    if (turn.result.kind === 'diagnosis') {
      const runId =
        typeof slots?.runId === 'string'
          ? slots.runId
          : turn.result.nextActions.find((item) => item.kind === 'run.detail')?.href.split('/').pop()
      if (!runId || !hasAllPermissions(actor.permissions, ['run:read', 'target:read'])) {
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
    if (turn.result.kind === 'explanation' || turn.result.kind === 'proposal' || turn.result.kind === 'knowledge_proposal') {
      const scenarioId = typeof slots?.scenarioId === 'string' ? slots.scenarioId : ''
      if (
        !scenarioId ||
        !hasAllPermissions(actor.permissions, assistantCapability('scenario.explain').requiredPermissions)
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
    return turn
  }
}
