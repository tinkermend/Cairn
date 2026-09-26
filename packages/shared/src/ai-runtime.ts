import { z } from 'zod'
import { aiOutputSchemaSchema } from './output-schema.js'
import {
  FACTORY_PLATFORM_CONFIG,
  assertAiRequestTimeoutFitsSteps,
  platformAiProviderSchema,
  platformModelUrlSchema,
  platformRuntimeDefaultsFrom,
  platformRuntimeDefaultsSchema,
  resolvePlatformExecutionPolicy,
  type PlatformConfigDocument,
} from './platform-config.js'
import { LOCAL_SECRET_PROVIDER, secretRefSchema } from './secret-ref.js'
import { authoringCapabilitiesSchema, type AuthoringCapabilities } from './authoring-observation.js'
import {
  effectivePoliciesForSteps,
  FACTORY_COMPILE_RESOLUTION,
  resolutionCapabilitiesSchema,
  snapshotNeedsBrowserAi,
  WAIT_KINDS_AVAILABLE_NOW,
  type ResolutionCapabilities,
} from './resolution.js'
export type { ResolutionCapabilities }
import {
  FACTORY_RESOLUTION_CEILING,
  FACTORY_RESOLUTION_DEFAULT,
  type ResolutionPolicy,
} from './resolution-policy.js'
import type { LocatorRoute } from './locator-plan.js'
import {
  AI_STEP_TYPES,
  aiAtomicActionInputSchema,
  EXECUTABLE_STEP_TYPES,
  FIXTURE_STEP_TYPES,
  isAiStepType,
  isFixtureStepType,
  isMapExploreStepType,
  type ExecutionPolicy,
  type Step,
} from './step.js'
import { entityIdSchema, jsonValueSchema, runtimeSchemaVersionSchema, utcInstantSchema } from './wire.js'

export const BROWSER_AI_ADAPTER = 'midscene' as const
export const BROWSER_AI_ADAPTER_VERSION = '1' as const
export const BROWSER_AI_SDK_VERSION = '1.12.6' as const
export const BROWSER_AI_ROUTE_ID = 'browser-default' as const
export const BROWSER_AI_CONFIG_VERSION = '1' as const
export const BROWSER_AI_PROMPT_VERSION = '1' as const
export const BROWSER_AI_POLICY_VERSION = '1' as const

export const AI_UNAVAILABLE_CODES = ['AI_DISABLED', 'AI_CONFIG_INVALID'] as const
export type AiUnavailableCode = (typeof AI_UNAVAILABLE_CODES)[number]

/** 夹具步骤未开放时，编写闸门与创建运行闸门共用同一组文案，不各写一份。 */
export const FIXTURE_STEPS_DISABLED_CODE = 'FIXTURE_STEPS_DISABLED' as const
export const FIXTURE_STEPS_DISABLED_MESSAGE =
  '调试夹具步骤未开放：echo / delay / fail 不访问目标系统，结果不构成业务事实'

export const scenarioCapabilitiesSchema = z.strictObject({
  executableStepTypes: z.array(z.string().min(1)).min(1),
  unavailableReasons: z.array(
    z.strictObject({
      type: z.string().min(1),
      code: z.string().min(1).max(64),
      message: z.string().min(1).max(512),
    }),
  ),
  defaults: platformRuntimeDefaultsSchema,
  authoring: authoringCapabilitiesSchema.optional(),
  authoringSchemaVersions: z.array(z.union([z.literal(1), z.literal(2)])).min(1).max(2).default([1, 2]),
  actionModules: z.boolean().default(true),
  demonstrationImport: z.boolean().optional(),
  resolution: resolutionCapabilitiesSchema.optional(),
})
export type ScenarioCapabilities = z.infer<typeof scenarioCapabilitiesSchema>

export const platformAiExecutionConfigSchema = z.strictObject({
  provider: platformAiProviderSchema.optional(),
  baseUrl: platformModelUrlSchema,
  model: z.string().trim().min(1).max(256),
  secretRef: secretRefSchema.optional(),
  requestTimeoutMs: z.number().int().positive().max(120_000).optional(),
  maxOutputTokens: z.number().int().positive().max(8192).optional(),
})
export type PlatformAiExecutionConfig = z.infer<typeof platformAiExecutionConfigSchema>

export const aiExecutionConfigSchema = z.strictObject({
  adapter: z.literal(BROWSER_AI_ADAPTER),
  adapterVersion: z.string().min(1).max(64),
  sdkVersion: z.string().min(1).max(64),
  routeId: z.string().min(1).max(64),
  configVersion: z.string().min(1).max(64),
  modelBaseUrl: z.string().url().max(2048),
  modelName: z.string().min(1).max(256),
  modelFamily: z.string().min(1).max(64),
  secretRef: secretRefSchema.optional(),
  promptVersion: z.string().min(1).max(64),
  policyVersion: z.string().min(1).max(64),
  maxCalls: z.number().int().positive().max(200),
  maxOutputTokens: z.number().int().positive().max(32_768),
  requestTimeoutMs: z.number().int().positive().max(300_000),
  hangWaitMs: z.number().int().positive().max(60_000),
  preferAriaTree: z.boolean().optional(),
  visionEnabled: z.boolean().optional(),
  platformAi: platformAiExecutionConfigSchema.optional(),
})
export type AiExecutionConfig = z.infer<typeof aiExecutionConfigSchema>

export const AI_COMMAND_TYPES = ['ai_action', 'ai_extract', 'ai_assert'] as const
export type AiCommandType = (typeof AI_COMMAND_TYPES)[number]

export const aiCommandSchema = z.strictObject({
  type: z.enum(AI_COMMAND_TYPES),
  instruction: z.string().trim().min(1).max(4096).optional(),
  action: aiAtomicActionInputSchema.optional(),
  outputSchema: aiOutputSchemaSchema.optional(),
  maxCalls: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  hangWaitMs: z.number().int().positive(),
  allowedOrigins: z.array(z.string().min(1)).min(1).max(16),
  loginOrigin: z.string().min(1).max(256).optional(),
  loginPath: z.string().max(2048).optional(),
  contextValues: z.record(z.string(), jsonValueSchema).optional(),
}).superRefine((command, ctx) => {
  if (command.action) {
    if (command.type !== 'ai_action' || command.instruction !== undefined ||
      (command.action.operation === 'input' && command.action.from !== undefined)) {
      ctx.addIssue({ code: 'custom', message: '原子 AI 命令必须是已解析输入的 ai_action，不能同时携带 instruction' })
    }
  } else if (!command.instruction) {
    ctx.addIssue({ code: 'custom', message: 'AI 命令缺少 instruction 或 action' })
  }
})
export type AiCommand = z.infer<typeof aiCommandSchema>

export const aiUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cost: z.number().nonnegative().nullable(),
})
export type AiUsage = z.infer<typeof aiUsageSchema>

export const aiResultSchema = z.strictObject({
  ok: z.boolean(),
  output: jsonValueSchema.optional(),
  summary: z.string().max(2048).optional(),
  hung: z.boolean().optional(),
  usage: aiUsageSchema.optional(),
})
export type AiResult = z.infer<typeof aiResultSchema>

export const AI_CALL_KIND = 'ai_call' as const

export const aiCallEvidenceSchema = z.strictObject({
  schemaVersion: runtimeSchemaVersionSchema,
  kind: z.literal(AI_CALL_KIND),
  n: z.number().int().positive(),
  phase: z.enum(['reserved', 'completed', 'failed']),
  model: z.string().min(1).max(256).optional(),
  startedAt: utcInstantSchema,
  endedAt: utcInstantSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  cost: z.number().nonnegative().nullable().optional(),
  errorCode: z.string().min(1).max(128).optional(),
  summary: z.string().max(2048).optional(),
  attemptId: entityIdSchema.optional(),
  route: z.enum(['vision', 'aria_text']).optional(),
})
export type AiCallEvidence = z.infer<typeof aiCallEvidenceSchema>

export function isAiCallEvidence(payload: unknown): payload is AiCallEvidence {
  return aiCallEvidenceSchema.safeParse(payload).success
}

/**
 * 可编写的步骤类型。两道闸门都在这里收口：
 * 浏览器 AI 未启用则去掉三类 AI 步，调试夹具未开放则去掉 echo/delay/fail。
 * 夹具步不产生真实业务事实，出厂关闭；打开只应发生在排查编排的环境。
 * 第二个参数刻意不给默认值：漏传就会悄悄按「关闭」处理，等于在没人察觉时把
 * 已开放的能力拦掉，所以每个调用点都得自己读平台配置并显式传入。
 */
export function executableStepTypesFor(
  browserAiEnabled: boolean,
  fixtureStepsEnabled: boolean,
): string[] {
  const authoring = EXECUTABLE_STEP_TYPES.filter(
    (type) => !isMapExploreStepType(type) && (fixtureStepsEnabled || !isFixtureStepType(type)),
  )
  if (browserAiEnabled) return [...authoring]
  return authoring.filter((type) => !isAiStepType(type))
}

export function defaultAuthoringCapabilities(): AuthoringCapabilities {
  return {
    indicate: 'open',
    highlight: 'open',
    debugHold: 'open',
    assist: 'closed',
    stepTypesExtra: ['select', 'keyboard', 'wait'],
  }
}

export function resolutionCapabilitiesFromPlatform(document: PlatformConfigDocument): ResolutionCapabilities {
  const textReady = Boolean(document.platformAi.enabled && document.platformAi.baseUrl && document.platformAi.model && document.platformAi.secretRef)
  const visionReady = Boolean(document.browserAi.enabled && document.browserAi.baseUrl && document.browserAi.model && document.browserAi.modelFamily && document.browserAi.secretRef)
  const ceiling = document.browserAi.enabled
    ? (document.browserAi.resolutionCeiling ?? FACTORY_RESOLUTION_CEILING)
    : 'deterministic_only'
  const reasons: ResolutionCapabilities['reasons'] = []
  if (!document.browserAi.enabled) {
    reasons.push({ code: 'AI_DISABLED', message: '浏览器仿真 AI 未启用' })
  } else if (!document.browserAi.baseUrl || !document.browserAi.model || !document.browserAi.modelFamily || !document.browserAi.secretRef) {
    reasons.push({ code: 'AI_CONFIG_INVALID', message: '浏览器仿真 AI 配置不完整' })
  }
  if (document.browserAi.enabled && ceiling === 'deterministic_only') {
    reasons.push({ code: 'CEILING_CLOSED', message: 'AI 定位能力上限未开放 AI 级' })
  }
  return {
    ceiling,
    default: document.browserAi.defaultResolution ?? FACTORY_RESOLUTION_DEFAULT,
    textReady,
    visionReady,
    aiRungAvailable:
      document.browserAi.enabled &&
      ceiling !== 'deterministic_only' &&
      !reasons.some((item) => item.code === 'AI_DISABLED' || item.code === 'AI_CONFIG_INVALID'),
    reasons,
    waitKindsAvailable: [...WAIT_KINDS_AVAILABLE_NOW],
  }
}

export function scenarioCapabilitiesFor(input: {
  browserAiEnabled: boolean
  fixtureStepsEnabled?: boolean
  unavailableMessage?: string
  defaults?: ScenarioCapabilities['defaults']
  authoring?: AuthoringCapabilities
  resolution?: ResolutionCapabilities
}): ScenarioCapabilities {
  const fixtureStepsEnabled = input.fixtureStepsEnabled ?? false
  return {
    executableStepTypes: executableStepTypesFor(input.browserAiEnabled, fixtureStepsEnabled),
    unavailableReasons: [
      ...(input.browserAiEnabled
        ? []
        : AI_STEP_TYPES.map((type) => ({
            type: type as string,
            code: 'AI_DISABLED',
            message: input.unavailableMessage ?? '浏览器仿真 AI 未启用',
          }))),
      ...(fixtureStepsEnabled
        ? []
        : FIXTURE_STEP_TYPES.map((type) => ({
            type: type as string,
            code: FIXTURE_STEPS_DISABLED_CODE,
            message: FIXTURE_STEPS_DISABLED_MESSAGE,
          }))),
    ],
    defaults: input.defaults ?? platformRuntimeDefaultsFrom(FACTORY_PLATFORM_CONFIG, 1),
    authoring: input.authoring ?? defaultAuthoringCapabilities(),
    authoringSchemaVersions: [1, 2],
    actionModules: true,
    resolution:
      input.resolution ??
      resolutionCapabilitiesFromPlatform({
        ...FACTORY_PLATFORM_CONFIG,
        browserAi: { ...FACTORY_PLATFORM_CONFIG.browserAi, enabled: input.browserAiEnabled },
      }),
  }
}

export function runNeedsAiExecute(input: {
  steps: readonly { id?: string; type: string; policy?: { resolution?: ResolutionPolicy } }[]
  document: PlatformConfigDocument
  documentResolution?: ResolutionPolicy
  targetCeiling?: ResolutionPolicy
  targetPreference?: ResolutionPolicy
  effectiveSteps?: Readonly<Record<string, ResolutionPolicy>>
}): boolean {
  const resolution = resolutionCapabilitiesFromPlatform(input.document)
  const effective =
    input.effectiveSteps ??
    (input.steps.every((step) => typeof step.id === 'string')
      ? effectivePoliciesForSteps(
          input.steps as unknown as { id: string; policy?: { resolution?: ResolutionPolicy } }[],
          {
            ...FACTORY_COMPILE_RESOLUTION,
            ceiling: resolution.ceiling,
            default: resolution.default,
            targetCeiling: input.targetCeiling,
            targetPreference: input.targetPreference,
            documentResolution: input.documentResolution,
            aiRungAvailable: resolution.aiRungAvailable,
          },
          input.document.browserAi.enabled,
        )
      : undefined)
  return snapshotNeedsBrowserAi(input.steps as Step[], effective)
}

export function resolveAiExecutionFromPlatform(
  steps: readonly { id?: string; type: string; policy?: { timeoutMs?: number; retryLimit?: number; resolution?: ResolutionPolicy } }[],
  document: PlatformConfigDocument,
  extras: {
    revision: number
    hangWaitMs: number
    policy?: ExecutionPolicy
    documentResolution?: ResolutionPolicy
    targetCeiling?: ResolutionPolicy
    targetPreference?: ResolutionPolicy
    effectiveSteps?: Readonly<Record<string, ResolutionPolicy>>
    requiredLocatorRoutes?: readonly LocatorRoute[]
  },
) {
  const explicitAiStep = steps.some((step) => !('disabled' in step && step.disabled) && isAiStepType(step.type))
  const needsLocator = extras.requiredLocatorRoutes?.some((route) => route !== 'rule') ?? false
  const legacyNeedsAi = extras.requiredLocatorRoutes === undefined && runNeedsAiExecute({
    steps,
    document,
    documentResolution: extras.documentResolution,
    targetCeiling: extras.targetCeiling,
    targetPreference: extras.targetPreference,
    effectiveSteps: extras.effectiveSteps,
  })
  if (!explicitAiStep && !needsLocator && !legacyNeedsAi) return undefined
  const needsVision = explicitAiStep || extras.requiredLocatorRoutes?.includes('vision_ai') === true || !extras.requiredLocatorRoutes
  const needsText = extras.requiredLocatorRoutes?.includes('text_ai') === true
  if (needsVision && !document.browserAi.enabled) {
    throw Object.assign(new Error('浏览器仿真 AI 未启用'), { code: 'AI_DISABLED' })
  }
  const ai = document.browserAi
  if (needsVision && (!ai.baseUrl || !ai.model || !ai.modelFamily || !ai.secretRef)) {
    throw Object.assign(new Error('浏览器仿真 AI 配置不完整'), { code: 'AI_CONFIG_INVALID' })
  }
  if (needsText && (!document.platformAi.enabled || !document.platformAi.baseUrl || !document.platformAi.model || !document.platformAi.secretRef)) {
    throw Object.assign(new Error('平台 AI 文本模型未就绪，请检查启用状态、地址、模型和绑定密钥'), { code: 'AI_CONFIG_INVALID' })
  }
  const snapshotPolicy = resolvePlatformExecutionPolicy(extras.policy, document.execution)
  const requestTimeoutMs = needsVision ? ai.requestTimeoutMs : document.platformAi.requestTimeoutMs
  assertAiRequestTimeoutFitsSteps(steps, snapshotPolicy, requestTimeoutMs)
  const platformAi =
    document.platformAi?.enabled && document.platformAi?.baseUrl && document.platformAi?.model && document.platformAi?.secretRef
      ? {
          provider: document.platformAi.provider,
          baseUrl: document.platformAi.baseUrl,
          model: document.platformAi.model,
          secretRef: document.platformAi.secretRef,
          requestTimeoutMs: document.platformAi.requestTimeoutMs,
          maxOutputTokens: document.platformAi.maxOutputTokens,
        }
      : undefined
  return aiExecutionConfigSchema.parse({
    adapter: BROWSER_AI_ADAPTER,
    adapterVersion: BROWSER_AI_ADAPTER_VERSION,
    sdkVersion: BROWSER_AI_SDK_VERSION,
    routeId: BROWSER_AI_ROUTE_ID,
    configVersion: String(extras.revision),
    modelBaseUrl: needsVision ? ai.baseUrl : document.platformAi.baseUrl,
    modelName: needsVision ? ai.model : document.platformAi.model,
    modelFamily: needsVision ? ai.modelFamily : (document.platformAi.provider ?? 'openai'),
    secretRef: needsVision ? ai.secretRef : document.platformAi.secretRef,
    promptVersion: BROWSER_AI_PROMPT_VERSION,
    policyVersion: BROWSER_AI_POLICY_VERSION,
    maxCalls: ai.stepMaxCalls,
    maxOutputTokens: needsVision ? ai.maxOutputTokens : document.platformAi.maxOutputTokens,
    requestTimeoutMs,
    hangWaitMs: extras.hangWaitMs,
    preferAriaTree: ai.preferAriaTree ?? false,
    visionEnabled: needsVision,
    ...(platformAi ? { platformAi } : {}),
  })
}

export const ASSERT_FAILED_CODE = 'ASSERT_FAILED' as const

export function aiExecutionFromEnv(env: {
  CAIRN_BROWSER_AI_BASE_URL: string
  CAIRN_BROWSER_AI_MODEL: string
  CAIRN_BROWSER_AI_MODEL_FAMILY: string
  CAIRN_BROWSER_AI_API_KEY_SECRET_ID?: string
  CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS: number
  CAIRN_BROWSER_AI_HANG_WAIT_MS: number
  CAIRN_BROWSER_AI_STEP_MAX_CALLS: number
  CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS: number
}): AiExecutionConfig {
  return aiExecutionConfigSchema.parse({
    adapter: BROWSER_AI_ADAPTER,
    adapterVersion: BROWSER_AI_ADAPTER_VERSION,
    sdkVersion: BROWSER_AI_SDK_VERSION,
    routeId: BROWSER_AI_ROUTE_ID,
    configVersion: BROWSER_AI_CONFIG_VERSION,
    modelBaseUrl: env.CAIRN_BROWSER_AI_BASE_URL,
    modelName: env.CAIRN_BROWSER_AI_MODEL,
    modelFamily: env.CAIRN_BROWSER_AI_MODEL_FAMILY,
    secretRef: env.CAIRN_BROWSER_AI_API_KEY_SECRET_ID
      ? { provider: LOCAL_SECRET_PROVIDER, secretId: env.CAIRN_BROWSER_AI_API_KEY_SECRET_ID }
      : undefined,
    promptVersion: BROWSER_AI_PROMPT_VERSION,
    policyVersion: BROWSER_AI_POLICY_VERSION,
    maxCalls: env.CAIRN_BROWSER_AI_STEP_MAX_CALLS,
    maxOutputTokens: env.CAIRN_BROWSER_AI_MAX_OUTPUT_TOKENS,
    requestTimeoutMs: env.CAIRN_BROWSER_AI_REQUEST_TIMEOUT_MS,
    hangWaitMs: env.CAIRN_BROWSER_AI_HANG_WAIT_MS,
  })
}
