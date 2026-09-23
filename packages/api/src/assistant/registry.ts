import {
  type AssistantCapabilityId,
  type AssistantPageContext,
  type AssistantResult,
  type CapabilityDescriptor,
  ASSISTANT_PUBLISHED_CAPABILITY_IDS,
  assistantCompareSchema,
  assistantDiagnosisSchema,
  assistantDiscoveryResultSchema,
  assistantExplanationSchema,
  assistantGuideSchema,
  assistantInPageGuidanceSchema,
  assistantKnowledgeProposalSchema,
  assistantProposalSchema,
  operationsActionProposalSchema,
} from '@cairn/shared'
import { z } from 'zod'
import type { DbHandle } from '@cairn/db'
import type { PlatformConfigService } from '../platform-config/platform-config.service'
import type { TargetsService } from '../targets/targets.service'
import type { PlatformModelClient } from './model-client'
import type { AssistantModelSession } from './model-session'
import type { RequestAccount as Actor } from '../common/request-account'

export interface AssistantCapabilityHandlerContext {
  db: DbHandle
  actor: Actor
  slots: Record<string, unknown>
  question: string
  body: {
    question: string
    capabilityHint?: string
    pageContext?: AssistantPageContext
    replyToTurnId?: string
  }
  session: AssistantModelSession | null
  platformConfig: PlatformConfigService
  targets: TargetsService
  models: PlatformModelClient
  signal?: AbortSignal
  onProgress?: (stage: 'routing' | 'loading_facts' | 'generating' | 'validating' | 'persisting', note?: string) => Promise<void>
}

export type AssistantCapabilityHandler = (
  ctx: AssistantCapabilityHandlerContext,
) => Promise<AssistantResult>

export interface AssistantCapabilityRegistration {
  descriptor: CapabilityDescriptor
  inputSchema?: z.ZodTypeAny
  outputSchema?: z.ZodTypeAny
  handler: AssistantCapabilityHandler
  promptTemplates?: Record<string, string>
  activePromptVersion?: string
  previousPromptVersion?: string
}

export class AssistantCapabilityRegistry {
  private readonly registrations = new Map<string, AssistantCapabilityRegistration>()
  private readonly promptVersionHistory = new Map<string, string[]>()

  constructor() {
    this.registerBuiltins()
    this.assertIntegrity()
  }

  /**
   * Register a capability descriptor + handler.
   */
  register(registration: AssistantCapabilityRegistration): void {
    const { descriptor, handler } = registration
    if (!descriptor) throw new Error('CapabilityRegistration requires a valid descriptor')
    if (!descriptor.id || typeof descriptor.id !== 'string') {
      throw new Error(`CapabilityDescriptor id must be a non-empty string`)
    }
    if (!descriptor.version || typeof descriptor.version !== 'string') {
      throw new Error(`CapabilityDescriptor ${descriptor.id} version must be a non-empty string`)
    }
    if (!descriptor.label || typeof descriptor.label !== 'string') {
      throw new Error(`CapabilityDescriptor ${descriptor.id} label must be a non-empty string`)
    }
    if (!descriptor.requiredPermissions || descriptor.requiredPermissions.length === 0) {
      throw new Error(`CapabilityDescriptor ${descriptor.id} must declare non-empty requiredPermissions`)
    }
    if (!descriptor.inputSchemaRef || !descriptor.outputSchemaRef) {
      throw new Error(`CapabilityDescriptor ${descriptor.id} must declare both inputSchemaRef and outputSchemaRef`)
    }
    if (typeof handler !== 'function') {
      throw new Error(`Capability ${descriptor.id} must provide an executable handler function`)
    }

    const key = `${descriptor.id}@${descriptor.version}`
    if (this.registrations.has(key)) {
      throw new Error(`Duplicate capability registration: ${key}`)
    }

    const activeVersion = registration.activePromptVersion ?? 'v1'
    this.registrations.set(key, {
      ...registration,
      activePromptVersion: activeVersion,
    })

    if (!this.promptVersionHistory.has(descriptor.id)) {
      this.promptVersionHistory.set(descriptor.id, [activeVersion])
    }
  }

  /**
   * AIF-02: Startup integrity check.
   * Asserts all registrations have schemas, handlers, permissions, and unique id@version.
   */
  assertIntegrity(): void {
    if (this.registrations.size === 0) {
      throw new Error('AssistantCapabilityRegistry must contain at least one registered capability')
    }
    const seen = new Set<string>()
    for (const [key, reg] of this.registrations.entries()) {
      if (seen.has(key)) {
        throw new Error(`AIF-02 startup assertion failure: duplicate key ${key}`)
      }
      seen.add(key)
      if (!reg.descriptor.id || !reg.descriptor.version) {
        throw new Error(`AIF-02 startup assertion failure: capability missing id or version: ${key}`)
      }
      if (!reg.descriptor.requiredPermissions || reg.descriptor.requiredPermissions.length === 0) {
        throw new Error(`AIF-02 startup assertion failure: capability ${key} missing requiredPermissions`)
      }
      if (!reg.descriptor.inputSchemaRef || !reg.descriptor.outputSchemaRef) {
        throw new Error(`AIF-02 startup assertion failure: capability ${key} missing input or output schema ref`)
      }
      if (typeof reg.handler !== 'function') {
        throw new Error(`AIF-02 startup assertion failure: capability ${key} missing valid handler`)
      }
      if (!reg.descriptor.internal) {
        if (!ASSISTANT_PUBLISHED_CAPABILITY_IDS.includes(reg.descriptor.id as any)) {
          throw new Error(
            `AIF-02 startup assertion failure: public capability ${reg.descriptor.id} must be in ASSISTANT_PUBLISHED_CAPABILITY_IDS`,
          )
        }
      }
    }
    for (const pubId of ASSISTANT_PUBLISHED_CAPABILITY_IDS) {
      if (!this.get(pubId)) {
        throw new Error(`AIF-02 startup assertion failure: published capability ${pubId} is missing from registry`)
      }
    }
  }

  /**
   * Find capability registration by id (defaults to latest version registered).
   */
  get(id: string, version?: string): AssistantCapabilityRegistration | undefined {
    if (version) {
      return this.registrations.get(`${id}@${version}`)
    }
    for (const [key, reg] of this.registrations.entries()) {
      if (key.startsWith(`${id}@`)) {
        return reg
      }
    }
    return undefined
  }

  /**
   * List all registered capability descriptors. Defaults to published descriptors only.
   */
  listDescriptors(options?: { includeInternal?: boolean }): CapabilityDescriptor[] {
    const all = Array.from(this.registrations.values()).map((r) => r.descriptor)
    if (options?.includeInternal) {
      return all
    }
    return all.filter((d) => !d.internal)
  }

  /**
   * AIF-20: Update active prompt version for a capability at runtime.
   */
  setPromptVersion(capabilityId: string, newVersion: string): void {
    const reg = this.get(capabilityId)
    if (!reg) throw new Error(`Capability not found: ${capabilityId}`)
    const history = this.promptVersionHistory.get(capabilityId) ?? []
    reg.previousPromptVersion = reg.activePromptVersion
    reg.activePromptVersion = newVersion
    history.push(newVersion)
    this.promptVersionHistory.set(capabilityId, history)
  }

  /**
   * AIF-20: Rollback prompt version for a single capability without process restart.
   */
  rollbackPromptVersion(capabilityId: string): string {
    const reg = this.get(capabilityId)
    if (!reg) throw new Error(`Capability not found: ${capabilityId}`)
    const history = this.promptVersionHistory.get(capabilityId) ?? []
    if (history.length <= 1) {
      if (reg.previousPromptVersion) {
        const prev = reg.previousPromptVersion
        reg.activePromptVersion = prev
        return prev
      }
      return reg.activePromptVersion ?? 'v1'
    }
    history.pop() // remove current
    const target = history[history.length - 1]!
    reg.previousPromptVersion = reg.activePromptVersion
    reg.activePromptVersion = target
    return target
  }

  /**
   * Get active prompt template for a capability.
   */
  getPromptTemplate(capabilityId: string, version?: string): string {
    const reg = this.get(capabilityId)
    if (!reg) throw new Error(`Capability not found: ${capabilityId}`)
    const ver = version ?? reg.activePromptVersion ?? 'v1'
    return reg.promptTemplates?.[ver] ?? ''
  }

  /**
   * Register the 6 built-in capabilities (migrated 5 + run.compare).
   */
  private registerBuiltins(): void {
    // 1. run.diagnose
    this.register({
      descriptor: {
        id: 'run.diagnose',
        version: '1.0.0',
        label: '运行诊断',
        purpose: '分析 Run 失败或慢跑事实，提出可能原因与下一步动作',
        notApplicable: ['未完成的运行', '非本租户的运行'],
        requiredPermissions: ['ai:assist', 'run:read', 'target:read'],
        inputSchemaRef: 'assistantDiagnoseInputSchema',
        outputSchemaRef: 'assistantDiagnosisSchema',
        contextProfileRef: 'diagnose:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'diagnose_policy:v1',
        promptRef: { id: 'diagnose_prompt', version: 'v1' },
        validatorRefs: ['grounding_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '诊断' },
          { kind: 'regex', pattern: '为什么(失败|报错|卡住|慢)' },
        ],
        slotBindings: [
          { slot: 'runId', from: 'pageContext', key: 'runId', required: true },
          { slot: 'stepId', from: 'pageContext', key: 'stepId', required: false },
        ],
        requiredContextKeys: ['runId'],
      },
      inputSchema: z.strictObject({
        runId: z.string(),
        stepId: z.string().optional(),
        focus: z.enum(['overview', 'timing', 'network', 'console']).optional(),
      }),
      outputSchema: assistantDiagnosisSchema,
      handler: async (ctx) => {
        const { handleRunDiagnose } = await import('./handlers/diagnose.handler.js')
        return handleRunDiagnose(ctx)
      },
      promptTemplates: {
        v1: '根据已确认事实提出可能原因。每条必须引用事实包中已有的 citation 键，标为推断。证据不足时不要编造根因。输出 JSON {"hypotheses":[{"text":"...","citations":["run:..."]}]}。',
      },
    })

    // 2. run.compare (AIF-03)
    this.register({
      descriptor: {
        id: 'run.compare',
        version: '1.0.0',
        label: '运行对比',
        purpose: '对比两次 Run 的步骤、耗时与失败差异',
        notApplicable: ['未结束的运行'],
        requiredPermissions: ['ai:assist', 'run:read', 'target:read'],
        inputSchemaRef: 'assistantCompareInputSchema',
        outputSchemaRef: 'assistantCompareSchema',
        contextProfileRef: 'compare:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'compare_policy:v1',
        promptRef: { id: 'compare_prompt', version: 'v1' },
        validatorRefs: ['grounding_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '对比' },
          { kind: 'regex', pattern: '比对.*(差异|变化|区别)' },
        ],
        slotBindings: [
          { slot: 'baseRunId', from: 'question', key: 'baseRunId', required: true },
          { slot: 'compareRunId', from: 'question', key: 'compareRunId', required: true },
        ],
        requiredContextKeys: ['baseRunId', 'compareRunId'],
      },
      inputSchema: z.strictObject({
        baseRunId: z.string().uuid(),
        compareRunId: z.string().uuid(),
      }),
      outputSchema: assistantCompareSchema,
      handler: async (ctx) => {
        const { handleRunCompare } = await import('./handlers/compare.handler.js')
        return handleRunCompare(ctx)
      },
      promptTemplates: {
        v1: '对比两次运行的执行事实，指出步骤状态差异、耗时变化及失败根因转移。',
      },
    })

    // 3. scenario.explain
    this.register({
      descriptor: {
        id: 'scenario.explain',
        version: '1.0.0',
        label: '场景解释',
        purpose: '解释已保存场景版本或草稿中的步骤与引用',
        notApplicable: ['空草稿'],
        requiredPermissions: ['ai:assist', 'workflow:read', 'target:read'],
        inputSchemaRef: 'assistantExplainInputSchema',
        outputSchemaRef: 'assistantExplanationSchema',
        contextProfileRef: 'explain:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'explain_policy:v1',
        promptRef: { id: 'explain_prompt', version: 'v1' },
        validatorRefs: ['schema_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '解释' },
          { kind: 'regex', pattern: '(这步|场景|步骤)在干什么' },
        ],
        slotBindings: [
          { slot: 'scenarioId', from: 'pageContext', key: 'scenarioId', required: true },
          { slot: 'draftRevision', from: 'pageContext', key: 'draftRevision', required: false },
        ],
        requiredContextKeys: ['scenarioId'],
      },
      inputSchema: z.strictObject({
        scenarioId: z.string(),
        draftRevision: z.number().optional(),
        versionId: z.string().optional(),
        stepId: z.string().optional(),
      }),
      outputSchema: assistantExplanationSchema,
      handler: async (ctx) => {
        const { handleScenarioExplain } = await import('./handlers/explain.handler.js')
        return handleScenarioExplain(ctx)
      },
      promptTemplates: {
        v1: '用中文解释已保存的场景定义。不要编造定位器或未出现的步骤。输出 JSON {"summary":"...","stepSummary":"..."}。',
      },
    })

    // 4. scenario.propose-step
    this.register({
      descriptor: {
        id: 'scenario.propose-step',
        version: '1.0.0',
        label: '单步修改建议',
        purpose: '为已保存草稿中的现有步骤生成受限候选',
        notApplicable: ['未保存草稿', '已发布版本'],
        requiredPermissions: ['ai:assist', 'workflow:read', 'workflow:write', 'target:read'],
        inputSchemaRef: 'assistantProposeStepInputSchema',
        outputSchemaRef: 'assistantProposalSchema',
        contextProfileRef: 'propose:v1',
        executionMode: 'single_turn',
        sideEffect: 'draft_change',
        allowedTools: [],
        policyRef: 'propose_policy:v1',
        promptRef: { id: 'propose_prompt', version: 'v1' },
        validatorRefs: ['compiler_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '修改这步' },
          { kind: 'regex', pattern: '(把|将)当前步骤(改成|调整为)' },
        ],
        slotBindings: [
          { slot: 'scenarioId', from: 'pageContext', key: 'scenarioId', required: true },
          { slot: 'stepId', from: 'pageContext', key: 'stepId', required: true },
          { slot: 'draftRevision', from: 'pageContext', key: 'draftRevision', required: true },
        ],
        requiredContextKeys: ['scenarioId', 'stepId', 'draftRevision'],
      },
      inputSchema: z.strictObject({
        scenarioId: z.string(),
        stepId: z.string(),
        draftRevision: z.number(),
      }),
      outputSchema: assistantProposalSchema,
      handler: async (ctx) => {
        const { handleScenarioProposeStep } = await import('./handlers/propose-step.handler.js')
        return handleScenarioProposeStep(ctx)
      },
      promptTemplates: {
        v1: '只生成一种受限单步变更：ai_instruction、assert_expectation 或 fill_binding。不要输出 value，不要改定位器。输出对应 JSON。',
      },
    })

    // 5. scenario.compose_with_knowledge
    this.register({
      descriptor: {
        id: 'scenario.compose_with_knowledge',
        version: '1.0.0',
        label: '知识辅助编写',
        purpose: '基于已授权术语、地图与已发布做法生成可编辑草稿建议',
        notApplicable: ['无地图授权的目标'],
        requiredPermissions: ['ai:assist', 'workflow:read', 'workflow:write', 'target:read', 'map:read'],
        inputSchemaRef: 'assistantComposeKnowledgeInputSchema',
        outputSchemaRef: 'assistantKnowledgeProposalSchema',
        contextProfileRef: 'compose:v1',
        executionMode: 'single_turn',
        sideEffect: 'draft_change',
        allowedTools: [],
        policyRef: 'compose_policy:v1',
        promptRef: { id: 'compose_prompt', version: 'v1' },
        validatorRefs: ['schema_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '知识建议' },
          { kind: 'keyword', pattern: '根据知识编写' },
        ],
        slotBindings: [
          { slot: 'scenarioId', from: 'pageContext', key: 'scenarioId', required: true },
          { slot: 'draftRevision', from: 'pageContext', key: 'draftRevision', required: true },
        ],
        requiredContextKeys: ['scenarioId', 'draftRevision'],
      },
      inputSchema: z.strictObject({
        scenarioId: z.string(),
        draftRevision: z.number(),
      }),
      outputSchema: assistantKnowledgeProposalSchema,
      handler: async (ctx) => {
        const { handleComposeKnowledge } = await import('./handlers/compose-knowledge.handler.js')
        return handleComposeKnowledge(ctx)
      },
      promptTemplates: {
        v1: '根据知识库与术语字典，为场景编排提供建议草稿。',
      },
    })

    // 6. platform.guide
    this.register({
      descriptor: {
        id: 'platform.guide',
        version: '1.0.0',
        label: '功能导览',
        purpose: '返回当前权限可达的控制台入口',
        notApplicable: [],
        requiredPermissions: ['ai:assist'],
        inputSchemaRef: 'assistantGuideInputSchema',
        outputSchemaRef: 'assistantGuideSchema',
        contextProfileRef: 'guide:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'guide_policy:v1',
        promptRef: null,
        validatorRefs: [],
        intentMatchers: [
          { kind: 'keyword', pattern: '怎么打开' },
          { kind: 'keyword', pattern: '在哪里' },
          { kind: 'keyword', pattern: '导览' },
        ],
        slotBindings: [
          { slot: 'topic', from: 'question', key: 'topic', required: false },
        ],
        requiredContextKeys: [],
      },
      inputSchema: z.strictObject({
        topic: z.string().optional(),
      }),
      outputSchema: assistantGuideSchema,
      handler: async (ctx) => {
        const { handlePlatformGuide } = await import('./handlers/guide.handler.js')
        return handlePlatformGuide(ctx)
      },
    })

    // 7. scenario.discover
    this.register({
      descriptor: {
        id: 'scenario.discover',
        version: '1.0.0',
        label: '场景发现',
        purpose: '在已授权 Target 范围内检索场景列表与状态',
        notApplicable: [],
        requiredPermissions: ['ai:assist', 'target:read', 'workflow:read'],
        inputSchemaRef: 'assistantDiscoverInputSchema',
        outputSchemaRef: 'assistantDiscoveryResultSchema',
        contextProfileRef: 'discover:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'discover_policy:v1',
        promptRef: null,
        validatorRefs: ['schema_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '有哪些场景' },
          { kind: 'keyword', pattern: '搜索场景' },
          { kind: 'keyword', pattern: '查找场景' },
          { kind: 'keyword', pattern: '列出场景' },
        ],
        slotBindings: [
          { slot: 'targetId', from: 'pageContext', key: 'targetId', required: false },
          { slot: 'filter', from: 'question', key: 'filter', required: false },
        ],
        requiredContextKeys: [],
      },
      inputSchema: z.strictObject({
        targetId: z.string().optional(),
        filter: z.string().optional(),
        status: z.enum(['draft', 'published', 'archived']).optional(),
        cursor: z.string().optional(),
        limit: z.number().optional(),
      }),
      outputSchema: assistantDiscoveryResultSchema,
      handler: async (ctx) => {
        const { handleScenarioDiscover } = await import('./handlers/discover.handler.js')
        return handleScenarioDiscover(ctx)
      },
    })

    // 8. target.business-records.list
    this.register({
      descriptor: {
        id: 'target.business-records.list',
        version: '1.0.0',
        label: '业务记录查询',
        purpose: '在指定 Target 下查询受控业务实体记录（如厂家、供应商）',
        notApplicable: ['未指定 Target 的跨域查询'],
        requiredPermissions: ['ai:assist', 'target:read', 'dataset:read'],
        inputSchemaRef: 'targetBusinessRecordsInputSchema',
        outputSchemaRef: 'assistantDiscoveryResultSchema',
        contextProfileRef: 'business_records:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'business_records_policy:v1',
        promptRef: null,
        validatorRefs: ['schema_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '厂家' },
          { kind: 'keyword', pattern: '制造商' },
          { kind: 'keyword', pattern: '供应商' },
        ],
        slotBindings: [
          { slot: 'targetId', from: 'pageContext', key: 'targetId', required: true },
          { slot: 'entityType', from: 'question', key: 'entityType', required: false },
        ],
        requiredContextKeys: ['targetId'],
      },
      inputSchema: z.strictObject({
        targetId: z.string(),
        entityType: z.string().optional(),
        filter: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().optional(),
      }),
      outputSchema: assistantDiscoveryResultSchema,
      handler: async (ctx) => {
        const { handleTargetBusinessRecordsList } = await import('./handlers/business-records.handler.js')
        return handleTargetBusinessRecordsList(ctx)
      },
    })

    // 9. operations.diagnose (AI-04 D2 - internal candidate)
    this.register({
      descriptor: {
        id: 'operations.diagnose',
        version: '1.0.0',
        label: '运营诊断',
        purpose: '分析平台状态、队列积压、Worker 槽位与会话认证等待',
        notApplicable: [],
        requiredPermissions: ['ai:assist', 'monitor:read'],
        inputSchemaRef: 'operationsDiagnoseInputSchema',
        outputSchemaRef: 'assistantDiagnosisSchema',
        contextProfileRef: 'operations:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'operations_policy:v1',
        promptRef: null,
        validatorRefs: ['schema_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '积压' },
          { kind: 'keyword', pattern: '排队' },
          { kind: 'keyword', pattern: '认证等待' },
          { kind: 'keyword', pattern: '运营状态' },
          { kind: 'keyword', pattern: 'Worker' },
        ],
        slotBindings: [
          { slot: 'targetId', from: 'pageContext', key: 'targetId', required: false },
          { slot: 'kind', from: 'question', key: 'kind', required: false },
        ],
        requiredContextKeys: [],
        internal: true,
      },
      inputSchema: z.strictObject({
        targetId: z.string().optional(),
        kind: z.string().optional(),
      }),
      outputSchema: assistantDiagnosisSchema,
      handler: async (ctx) => {
        const { handleOperationsDiagnose } = await import('./handlers/operations.handler.js')
        return handleOperationsDiagnose(ctx)
      },
    })

    // 10. schedules.propose (AI-04 D2 - internal candidate)
    this.register({
      descriptor: {
        id: 'schedules.propose',
        version: '1.0.0',
        label: '调度草案生成',
        purpose: '将自然语言调度意图转为带时区与5次确定性触发预览的调度草案',
        notApplicable: [],
        requiredPermissions: ['ai:assist', 'schedule:read'],
        inputSchemaRef: 'schedulesProposeInputSchema',
        outputSchemaRef: 'assistantExplanationSchema',
        contextProfileRef: 'schedules_propose:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'schedules_propose_policy:v1',
        promptRef: null,
        validatorRefs: ['schema_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '定时' },
          { kind: 'keyword', pattern: '调度' },
          { kind: 'keyword', pattern: '每天' },
          { kind: 'keyword', pattern: '每隔' },
        ],
        slotBindings: [
          { slot: 'cronExpr', from: 'question', key: 'cronExpr', required: false },
          { slot: 'timezone', from: 'pageContext', key: 'timezone', required: false },
          { slot: 'name', from: 'question', key: 'name', required: false },
        ],
        requiredContextKeys: [],
        internal: true,
      },
      inputSchema: z.strictObject({
        cronExpr: z.string().optional(),
        timezone: z.string().optional(),
        name: z.string().optional(),
      }),
      outputSchema: assistantExplanationSchema,
      handler: async (ctx) => {
        const { handleSchedulePropose } = await import('./handlers/operations.handler.js')
        return handleSchedulePropose(ctx)
      },
    })

    // 11. operations.action (AI-04 D2 - internal candidate)
    this.register({
      descriptor: {
        id: 'operations.action',
        version: '1.0.0',
        label: '运营受控动作提案',
        purpose: '生成受控单资源写操作提案，经用户二次确认后执行',
        notApplicable: [],
        requiredPermissions: ['ai:assist', 'schedule:write'],
        inputSchemaRef: 'operationsActionInputSchema',
        outputSchemaRef: 'operationsActionProposalSchema',
        contextProfileRef: 'operations_action:v1',
        executionMode: 'single_turn',
        sideEffect: 'draft_change',
        allowedTools: [],
        policyRef: 'operations_action_policy:v1',
        promptRef: null,
        validatorRefs: ['schema_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '暂停调度' },
          { kind: 'keyword', pattern: '恢复调度' },
          { kind: 'keyword', pattern: '取消运行' },
        ],
        slotBindings: [
          { slot: 'actionKey', from: 'question', key: 'actionKey', required: true },
          { slot: 'resourceId', from: 'question', key: 'resourceId', required: true },
          { slot: 'resourceKind', from: 'question', key: 'resourceKind', required: false },
        ],
        requiredContextKeys: ['actionKey', 'resourceId'],
        internal: true,
      },
      inputSchema: z.strictObject({
        actionKey: z.string(),
        resourceId: z.string(),
        resourceKind: z.string().optional(),
        expectedRevision: z.number().optional(),
      }),
      outputSchema: operationsActionProposalSchema,
      handler: async (ctx) => {
        const { handleOperationsAction } = await import('./handlers/operations.handler.js')
        return (handleOperationsAction(ctx) as any)
      },
    })

    // 12. in-page.guidance
    this.register({
      descriptor: {
        id: 'in-page.guidance',
        version: '1.0.0',
        label: '页面操作指引',
        purpose: '结合当前页面结构与地标指引关键按钮、操作入口与交互动线',
        notApplicable: [],
        requiredPermissions: ['ai:assist'],
        inputSchemaRef: 'assistantInPageGuidanceInputSchema',
        outputSchemaRef: 'assistantInPageGuidanceSchema',
        contextProfileRef: 'in_page_guidance:v1',
        executionMode: 'single_turn',
        sideEffect: 'read_only',
        allowedTools: [],
        policyRef: 'in_page_guidance_policy:v1',
        promptRef: null,
        validatorRefs: ['schema_validator'],
        intentMatchers: [
          { kind: 'keyword', pattern: '添加步骤' },
          { kind: 'keyword', pattern: '怎么添加' },
          { kind: 'keyword', pattern: '在页面哪里' },
          { kind: 'keyword', pattern: '保存草稿' },
        ],
        slotBindings: [
          { slot: 'question', from: 'question', key: 'question', required: true },
          { slot: 'page', from: 'pageContext', key: 'page', required: false },
        ],
        requiredContextKeys: [],
      },
      inputSchema: z.strictObject({
        question: z.string().optional(),
        page: z.string().optional(),
        stepId: z.string().optional(),
        scenarioId: z.string().optional(),
      }),
      outputSchema: assistantInPageGuidanceSchema,
      handler: async (ctx) => {
        const { handleInPageGuidance } = await import('./handlers/in-page-guidance.handler.js')
        return handleInPageGuidance(ctx)
      },
    })
  }
}

