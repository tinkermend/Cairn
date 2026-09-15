import { z } from 'zod'
import { aiOutputSchemaSchema } from './output-schema.js'
import {
  FACTORY_PLATFORM_CONFIG,
  assertAiRequestTimeoutFitsSteps,
  platformRuntimeDefaultsFrom,
  platformRuntimeDefaultsSchema,
  resolvePlatformExecutionPolicy,
  type PlatformConfigDocument,
} from './platform-config.js'
import { LOCAL_SECRET_PROVIDER, secretRefSchema } from './secret-ref.js'
import { authoringCapabilitiesSchema, type AuthoringCapabilities } from './authoring-observation.js'
import { AI_STEP_TYPES, EXECUTABLE_STEP_TYPES, hasAiSteps, isAiStepType, type ExecutionPolicy } from './step.js'
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
})
export type ScenarioCapabilities = z.infer<typeof scenarioCapabilitiesSchema>

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
})
export type AiExecutionConfig = z.infer<typeof aiExecutionConfigSchema>

export const AI_COMMAND_TYPES = ['ai_action', 'ai_extract', 'ai_assert'] as const
export type AiCommandType = (typeof AI_COMMAND_TYPES)[number]

export const aiCommandSchema = z.strictObject({
  type: z.enum(AI_COMMAND_TYPES),
  instruction: z.string().trim().min(1).max(4096),
  outputSchema: aiOutputSchemaSchema.optional(),
  maxCalls: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  hangWaitMs: z.number().int().positive(),
  allowedOrigins: z.array(z.string().min(1)).min(1).max(16),
  loginOrigin: z.string().min(1).max(256).optional(),
  loginPath: z.string().max(2048).optional(),
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
})
export type AiCallEvidence = z.infer<typeof aiCallEvidenceSchema>

export function isAiCallEvidence(payload: unknown): payload is AiCallEvidence {
  return aiCallEvidenceSchema.safeParse(payload).success
}

export function executableStepTypesFor(browserAiEnabled: boolean): string[] {
  if (browserAiEnabled) return [...EXECUTABLE_STEP_TYPES]
  return EXECUTABLE_STEP_TYPES.filter((type) => !isAiStepType(type))
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

export function scenarioCapabilitiesFor(input: {
  browserAiEnabled: boolean
  unavailableMessage?: string
  defaults?: ScenarioCapabilities['defaults']
  authoring?: AuthoringCapabilities
}): ScenarioCapabilities {
  return {
    executableStepTypes: executableStepTypesFor(input.browserAiEnabled),
    unavailableReasons: input.browserAiEnabled
      ? []
      : AI_STEP_TYPES.map((type) => ({
          type,
          code: 'AI_DISABLED',
          message: input.unavailableMessage ?? '浏览器仿真 AI 未启用',
        })),
    defaults: input.defaults ?? platformRuntimeDefaultsFrom(FACTORY_PLATFORM_CONFIG, 1),
    authoring: input.authoring ?? defaultAuthoringCapabilities(),
  }
}

export function resolveAiExecutionFromPlatform(
  steps: readonly { type: string; policy?: { timeoutMs?: number; retryLimit?: number } }[],
  document: PlatformConfigDocument,
  extras: { revision: number; hangWaitMs: number; policy?: ExecutionPolicy },
) {
  if (!hasAiSteps(steps)) return undefined
  if (!document.browserAi.enabled) {
    throw Object.assign(new Error('浏览器仿真 AI 未启用'), { code: 'AI_DISABLED' })
  }
  const ai = document.browserAi
  if (!ai.baseUrl || !ai.model || !ai.modelFamily || !ai.secretRef) {
    throw Object.assign(new Error('浏览器仿真 AI 配置不完整'), { code: 'AI_CONFIG_INVALID' })
  }
  const snapshotPolicy = resolvePlatformExecutionPolicy(extras.policy, document.execution)
  assertAiRequestTimeoutFitsSteps(steps, snapshotPolicy, ai.requestTimeoutMs)
  return aiExecutionConfigSchema.parse({
    adapter: BROWSER_AI_ADAPTER,
    adapterVersion: BROWSER_AI_ADAPTER_VERSION,
    sdkVersion: BROWSER_AI_SDK_VERSION,
    routeId: BROWSER_AI_ROUTE_ID,
    configVersion: String(extras.revision),
    modelBaseUrl: ai.baseUrl,
    modelName: ai.model,
    modelFamily: ai.modelFamily,
    secretRef: ai.secretRef,
    promptVersion: BROWSER_AI_PROMPT_VERSION,
    policyVersion: BROWSER_AI_POLICY_VERSION,
    maxCalls: ai.stepMaxCalls,
    maxOutputTokens: ai.maxOutputTokens,
    requestTimeoutMs: ai.requestTimeoutMs,
    hangWaitMs: extras.hangWaitMs,
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
