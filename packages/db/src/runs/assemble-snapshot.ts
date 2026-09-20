import {
  DEFAULT_BROWSER_AI_HANG_WAIT_MS,
  AI_ATOMIC_ACTIONS_PROTOCOL,
  IMPORTED_OUTCOME_PROTOCOL,
  FACTORY_PLATFORM_CONFIG,
  MAP_JOB_EVIDENCE_POLICY,
  RUNTIME_SCHEMA_VERSION,
  assertAiRequestTimeoutFitsSteps,
  freezeExecutorVersions,
  frozenTargetAuthSchema,
  hasAiSteps,
  loginScopeFromTargetUrl,
  resolveAiExecutionFromPlatform,
  resolveMapCapturePolicy,
  resolvePlatformEvidencePolicy,
  resolvePlatformExecutionPolicy,
  resolvePlatformSessionPolicy,
  runSnapshotSchema,
  targetSessionPolicyOverrideSchema,
  type AiExecutionConfig,
  type EvidencePolicy,
  type ExecutionPolicy,
  type FrozenAuthVerification,
  type FrozenMapConsumption,
  type FrozenMapJob,
  type FrozenTargetAccessPolicy,
  type JsonValue,
  type MapCapturePolicyOverride,
  type ModuleManifest,
  type OutcomeManifest,
  type RuntimeInvariantManifest,
  type PlatformConfigDocument,
  type RunSnapshot,
  type SessionPolicyOverride,
  type Step,
  type SuiteAdmissionSnapshot,
} from '@cairn/shared'
import { computeSnapshotDigest } from './digest.js'

export class AssembleRunSnapshotError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AssembleRunSnapshotError'
  }
}

function parseTargetSessionPolicyOverride(value: unknown) {
  if (value == null) return null
  return targetSessionPolicyOverrideSchema.parse(value)
}

export function resolveAssembledAiExecution(input: {
  steps: readonly Step[]
  platformDocument: PlatformConfigDocument
  platformRevision?: number
  aiExecution?: AiExecutionConfig
  hangWaitMs?: number
  executionPolicyOverride?: ExecutionPolicy
}): AiExecutionConfig | undefined {
  const document = input.platformDocument ?? FACTORY_PLATFORM_CONFIG
  const policy = resolvePlatformExecutionPolicy(input.executionPolicyOverride, document.execution)
  let aiExecution = input.aiExecution
  if (hasAiSteps(input.steps) && !aiExecution) {
    try {
      aiExecution = resolveAiExecutionFromPlatform(input.steps, document, {
        revision: input.platformRevision ?? 1,
        hangWaitMs: input.hangWaitMs ?? DEFAULT_BROWSER_AI_HANG_WAIT_MS,
        policy,
      })
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'AI_CONFIG_INVALID'
      throw new AssembleRunSnapshotError(code, error instanceof Error ? error.message : '浏览器仿真 AI 配置无效')
    }
  }
  if (hasAiSteps(input.steps) && !aiExecution) {
    throw new AssembleRunSnapshotError('AI_CONFIG_INVALID', '含 AI 步骤的运行必须冻结 AI 执行配置')
  }
  if (aiExecution) {
    try {
      assertAiRequestTimeoutFitsSteps(input.steps, policy, aiExecution.requestTimeoutMs)
    } catch (error) {
      throw new AssembleRunSnapshotError(
        'AI_CONFIG_INVALID',
        error instanceof Error ? error.message : 'AI 请求超时配置无效',
      )
    }
  }
  return aiExecution
}

export type AssembleRunSnapshotInput = {
  runId: string
  createdAt: Date
  deadlineAt?: Date
  targetId: string
  targetAccountId?: string
  secretRef?: RunSnapshot['secretRef']
  credentialBinding?: RunSnapshot['credentialBinding']
  scenarioId: string
  scenarioVersionId: string
  steps: readonly Step[]
  moduleManifest?: ModuleManifest | null
  outcomeManifest?: OutcomeManifest | null
  runtimeInvariantManifest?: RuntimeInvariantManifest | null
  input: Record<string, JsonValue>
  sessionPolicyOverride?: SessionPolicyOverride | null
  evidencePolicyOverride?: EvidencePolicy | null
  executionPolicyOverride?: ExecutionPolicy
  mapCapturePolicyOverride?: MapCapturePolicyOverride | null
  mapJob?: FrozenMapJob
  target: {
    entryUrl: string
    loginUrl: string | null
    authMethod: string
    captchaMode: string
    loginFields: unknown
    captcha?: unknown
    sessionPolicy: unknown
    sensitiveSelectors?: string[] | null
  }
  platformDocument: PlatformConfigDocument
  platformRevision?: number
  aiExecution?: AiExecutionConfig
  hangWaitMs?: number
  authVerification: FrozenAuthVerification
  allowedOrigins: string[]
  accessPolicy: FrozenTargetAccessPolicy
  mapConsumption: FrozenMapConsumption
  suiteAdmission?: SuiteAdmissionSnapshot
}

export function assembleRunSnapshot(input: AssembleRunSnapshotInput): RunSnapshot & { digest: string } {
  const document = input.platformDocument ?? FACTORY_PLATFORM_CONFIG
  const sessionPolicy = resolvePlatformSessionPolicy(
    input.sessionPolicyOverride,
    document.session,
    parseTargetSessionPolicyOverride(input.target.sessionPolicy),
  )
  const evidencePolicy = resolvePlatformEvidencePolicy(
    input.mapJob ? MAP_JOB_EVIDENCE_POLICY : input.evidencePolicyOverride,
    document.evidence,
  )
  const policy = resolvePlatformExecutionPolicy(input.executionPolicyOverride, document.execution)
  const snapshotBase = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    runId: input.runId,
    targetId: input.targetId,
    targetAccountId: input.targetAccountId,
    secretRef: input.secretRef,
    ...(input.credentialBinding ? { credentialBinding: input.credentialBinding } : {}),
    scenarioId: input.scenarioId,
    scenarioVersionId: input.scenarioVersionId,
    steps: [...input.steps],
    ...(input.steps.some((step) => step.type === 'ai_action' && 'operation' in step.input)
      ? { aiAtomicActionsProtocol: AI_ATOMIC_ACTIONS_PROTOCOL } : {}),
    ...(input.outcomeManifest?.entries.some((entry) => entry.provenance === 'imported')
      ? { importedOutcomeProtocol: IMPORTED_OUTCOME_PROTOCOL } : {}),
    moduleManifest: input.moduleManifest ?? undefined,
    ...(input.moduleManifest?.candidateGroups?.length
      ? { candidateGroups: { groups: input.moduleManifest.candidateGroups } }
      : {}),
    ...(input.outcomeManifest ? { outcomeManifest: input.outcomeManifest } : {}),
    ...(input.runtimeInvariantManifest
      ? { runtimeInvariantManifest: input.runtimeInvariantManifest }
      : {}),
    input: input.input,
    createdAt: input.createdAt.toISOString(),
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt.toISOString() } : {}),
    policy,
    sessionPolicy,
    evidencePolicy: {
      ...evidencePolicy,
      captureContractVersion: 1 as const,
      screenshotViewport: evidencePolicy.screenshotViewport,
    },
    executorVersions: freezeExecutorVersions(input.steps.map((step) => step.type)),
    ...loginScopeFromTargetUrl(input.target.entryUrl, input.target.loginUrl),
    targetAuth: frozenTargetAuthSchema.parse({
      entryUrl: input.target.entryUrl,
      loginUrl: input.target.loginUrl,
      authMethod: input.target.authMethod,
      captchaMode: input.target.captchaMode,
      loginFields: input.target.loginFields ?? null,
      captcha: input.target.captcha ?? undefined,
      ...(input.target.sensitiveSelectors?.length
        ? { sensitiveSelectors: input.target.sensitiveSelectors }
        : {}),
    }),
    authVerification: input.authVerification,
    ...(input.platformRevision ? { platformConfigRevision: input.platformRevision } : {}),
    runAuthRecovery: document.runAuthRecovery,
    aiExecution: resolveAssembledAiExecution({
      steps: input.steps,
      platformDocument: document,
      platformRevision: input.platformRevision,
      aiExecution: input.aiExecution,
      hangWaitMs: input.hangWaitMs,
      executionPolicyOverride: input.executionPolicyOverride,
    }),
    mapCapturePolicy: resolveMapCapturePolicy(
      input.mapJob ? { ...input.mapCapturePolicyOverride, enabled: true } : input.mapCapturePolicyOverride,
      document.mapCapture,
    ),
  }
  const parsed = runSnapshotSchema.parse({
    ...snapshotBase,
    allowedOrigins: input.allowedOrigins,
    accessPolicy: input.accessPolicy,
    mapConsumption: input.mapConsumption,
    ...(input.mapJob ? { mapJob: input.mapJob } : {}),
    ...(input.suiteAdmission ? { suiteAdmission: input.suiteAdmission } : {}),
  })
  const digest = computeSnapshotDigest(parsed)
  return runSnapshotSchema.parse({ ...parsed, digest }) as RunSnapshot & { digest: string }
}
