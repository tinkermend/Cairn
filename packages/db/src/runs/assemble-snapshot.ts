import {
  DEFAULT_BROWSER_AI_HANG_WAIT_MS,
  AI_ATOMIC_ACTIONS_PROTOCOL,
  LIST_OUTPUT_PROTOCOL,
  IMPORTED_OUTCOME_PROTOCOL,
  FACTORY_PLATFORM_CONFIG,
  MAP_JOB_EVIDENCE_POLICY,
  RUNTIME_SCHEMA_VERSION,
  CONTROL_FLOW_PROTOCOL,
  assertAiRequestTimeoutFitsSteps,
  freezeExecutorVersions,
  resolveAiTaskEvidence,
  frozenTargetAuthSchema,
  effectiveAccountSessionCap,
  effectivePoliciesForSteps,
  FACTORY_COMPILE_RESOLUTION,
  freezeResolutionSnapshot,
  frozenLocatorResolutionSchema,
  LOCATOR_RESOLUTION_PROTOCOL,
  resolveLocatorPlansForSteps,
  mergeResolutionCeiling,
  parseTargetResolutionPolicy,
  loginScopeFromTargetUrl,
  resolveAiExecutionFromPlatform,
  resolutionCapabilitiesFromPlatform,
  snapshotNeedsBrowserAi,
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
  type ControlFlowManifest,
  type PlatformConfigDocument,
  type ResolutionPolicy,
  type LocatorPlan,
  type LocatorResolution,
  type LocatorRoute,
  type RunSnapshot,
  type ScenarioOutputDecl,
  type ServiceDeliveryPolicy,
  type SessionPolicyOverride,
  type Step,
  type SuiteAdmissionSnapshot,
  type ValidationSubject,
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
  documentResolution?: ResolutionPolicy
  targetCeiling?: ResolutionPolicy
  targetPreference?: ResolutionPolicy
  effectiveSteps?: Readonly<Record<string, ResolutionPolicy>>
  locatorPlans?: Readonly<Record<string, LocatorResolution>>
}): AiExecutionConfig | undefined {
  const document = input.platformDocument ?? FACTORY_PLATFORM_CONFIG
  const policy = resolvePlatformExecutionPolicy(input.executionPolicyOverride, document.execution)
  const resolution = resolutionCapabilitiesFromPlatform(document)
  const effective =
    input.effectiveSteps ??
    effectivePoliciesForSteps(
      input.steps,
      {
        ...FACTORY_COMPILE_RESOLUTION,
        ceiling: resolution.ceiling,
        default: resolution.default,
        targetCeiling: input.targetCeiling,
        targetPreference: input.targetPreference,
        documentResolution: input.documentResolution,
        aiRungAvailable: resolution.aiRungAvailable,
      },
      document.browserAi.enabled,
    )
  const requiredLocatorRoutes = input.locatorPlans
    ? [...new Set(Object.values(input.locatorPlans).flatMap((plan) => plan.actual))] as LocatorRoute[]
    : undefined
  const needsAi = requiredLocatorRoutes
    ? input.steps.some((step) => !step.disabled && (step.type === 'ai_action' || step.type === 'ai_extract' || step.type === 'ai_assert')) ||
      requiredLocatorRoutes.some((route) => route !== 'rule')
    : snapshotNeedsBrowserAi(input.steps, effective)
  if (!needsAi) return undefined
  let aiExecution = input.aiExecution
  if (!aiExecution) {
    try {
      aiExecution = resolveAiExecutionFromPlatform(input.steps, document, {
        revision: input.platformRevision ?? 1,
        hangWaitMs: input.hangWaitMs ?? DEFAULT_BROWSER_AI_HANG_WAIT_MS,
        policy,
        documentResolution: input.documentResolution,
        targetCeiling: input.targetCeiling,
        targetPreference: input.targetPreference,
        effectiveSteps: effective,
        requiredLocatorRoutes,
      })
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'AI_CONFIG_INVALID'
      throw new AssembleRunSnapshotError(code, error instanceof Error ? error.message : '浏览器仿真 AI 配置无效')
    }
  }
  if (!aiExecution) {
    throw new AssembleRunSnapshotError('AI_CONFIG_INVALID', '含 AI 步骤或 AI 解析档位的运行必须冻结 AI 执行配置')
  }
  try {
    assertAiRequestTimeoutFitsSteps(input.steps, policy, aiExecution.requestTimeoutMs)
  } catch (error) {
    throw new AssembleRunSnapshotError(
      'AI_CONFIG_INVALID',
      error instanceof Error ? error.message : 'AI 请求超时配置无效',
    )
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
  controlFlow?: ControlFlowManifest | null
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
    resolutionPolicy?: unknown
    sensitiveSelectors?: string[] | null
    /** Target 级 AI 动作采集开关：'inherit' 沿用平台配置，'off' 关闭。 */
    aiActionTrace?: string | null
  }
  maxConcurrentSessions?: number
  platformDocument: PlatformConfigDocument
  platformRevision?: number
  aiExecution?: AiExecutionConfig
  hangWaitMs?: number
  authVerification: FrozenAuthVerification
  allowedOrigins: string[]
  accessPolicy: FrozenTargetAccessPolicy
  mapConsumption: FrozenMapConsumption
  suiteAdmission?: SuiteAdmissionSnapshot
  documentResolution?: ResolutionPolicy
  documentLocatorPlan?: LocatorPlan
  locatorProtocol?: 2
  outputs?: ScenarioOutputDecl
  serviceDelivery?: ServiceDeliveryPolicy
  pauseBeforeStepId?: string
  validationSubject?: ValidationSubject
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
  const resolutionCaps = resolutionCapabilitiesFromPlatform(document)
  const targetResolution = parseTargetResolutionPolicy(input.target.resolutionPolicy)
  const useLocatorV2 = Boolean(input.locatorProtocol === 2 || input.documentLocatorPlan || input.steps.some((step) => step.policy?.locatorPlan))
  let locatorPlans: Record<string, LocatorResolution> | undefined
  if (useLocatorV2) {
    try {
      locatorPlans = resolveLocatorPlansForSteps({
        steps: input.steps,
        document,
        target: targetResolution,
        scenarioPlan: input.documentLocatorPlan,
        scenarioPolicy: input.documentResolution,
      })
    } catch (error) {
      throw new AssembleRunSnapshotError('LOCATOR_ROUTE_UNAVAILABLE', error instanceof Error ? error.message : '定位计划不可用')
    }
  }
  const effectiveSteps = effectivePoliciesForSteps(
    input.steps,
    {
      ...FACTORY_COMPILE_RESOLUTION,
      ceiling: resolutionCaps.ceiling,
      default: resolutionCaps.default,
      targetCeiling: targetResolution?.ceiling,
      targetPreference: targetResolution?.preference,
      documentResolution: input.documentResolution,
      aiRungAvailable: resolutionCaps.aiRungAvailable,
    },
    document.browserAi.enabled,
  )
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
    ...(input.steps.some(
      (step) =>
        (step.type === 'extract' && Boolean(step.input.many)) ||
        (step.type === 'ai_extract' && step.input.outputSchema?.kind === 'list'),
    )
      ? { listOutputProtocol: LIST_OUTPUT_PROTOCOL } : {}),
    ...(input.outcomeManifest?.entries.some((entry) => entry.provenance === 'imported' || entry.provenance === 'generalized')
      ? { importedOutcomeProtocol: IMPORTED_OUTCOME_PROTOCOL } : {}),
    moduleManifest: input.moduleManifest ?? undefined,
    ...(input.moduleManifest?.candidateGroups?.length
      ? { candidateGroups: { groups: input.moduleManifest.candidateGroups } }
      : {}),
    ...(input.outcomeManifest ? { outcomeManifest: input.outcomeManifest } : {}),
    ...(input.runtimeInvariantManifest
      ? { runtimeInvariantManifest: input.runtimeInvariantManifest }
      : {}),
    ...(input.controlFlow
      ? { controlFlow: input.controlFlow }
      : input.steps.some(
          (s) => s.type === 'decide' || s.type === 'probe' || s.type === 'compute' || Boolean(s.optional),
        )
        ? { controlFlow: { protocol: CONTROL_FLOW_PROTOCOL, blocks: [] } }
        : {}),
    ...(input.outputs ? { outputs: input.outputs } : {}),
    ...(input.serviceDelivery ? { serviceDelivery: input.serviceDelivery } : {}),
    ...(input.pauseBeforeStepId ? { pauseBeforeStepId: input.pauseBeforeStepId } : {}),
    ...(input.validationSubject ? { validationSubject: input.validationSubject } : {}),
    input: input.input,
    createdAt: input.createdAt.toISOString(),
    ...(input.deadlineAt ? { deadlineAt: input.deadlineAt.toISOString() } : {}),
    policy,
    sessionPolicy,
    accountSessionEffectiveCap: effectiveAccountSessionCap({
      accountSessionMode: sessionPolicy.accountSessionMode,
      maxConcurrentSessions: input.maxConcurrentSessions,
    }),
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
      documentResolution: input.documentResolution,
      targetCeiling: targetResolution?.ceiling,
      targetPreference: targetResolution?.preference,
      effectiveSteps,
      locatorPlans,
    }),
    mapCapturePolicy: resolveMapCapturePolicy(
      input.mapJob ? { ...input.mapCapturePolicyOverride, enabled: true } : input.mapCapturePolicyOverride,
      document.mapCapture,
    ),
    ...(() => {
      // 关闭或无 ai_action 时不写字段：旧快照与未启用能力的 Run 的摘要逐字节不变
      const aiTaskEvidence = resolveAiTaskEvidence({
        platform: document.aiPathLearning,
        targetMode: (input.target.aiActionTrace as 'inherit' | 'off' | null | undefined) ?? null,
        steps: input.steps,
      })
      return aiTaskEvidence ? { aiTaskEvidence } : {}
    })(),
  }
  const frozenResolution = locatorPlans ? frozenLocatorResolutionSchema.parse({
    protocol: LOCATOR_RESOLUTION_PROTOCOL,
    allowed: [...new Set(Object.values(locatorPlans).flatMap((plan) => plan.allowed).concat(
      Object.keys(locatorPlans).length === 0 ? (document.locator?.limits.allowed ?? ['rule']) : [],
    ))],
    steps: Object.fromEntries(Object.entries(locatorPlans).map(([id, plan]) => [id, {
      requested: plan.requested, actual: plan.actual, skipped: plan.skipped, source: plan.source,
    }])),
    ...(input.platformRevision ? { textConfigVersion: String(input.platformRevision), visionConfigVersion: String(input.platformRevision) } : {}),
  }) : freezeResolutionSnapshot({
    ceiling: mergeResolutionCeiling({
      ceiling: resolutionCaps.ceiling,
      targetCeiling: targetResolution?.ceiling,
      browserAiEnabled: document.browserAi.enabled,
    }),
    scenarioDefault: targetResolution?.preference ?? resolutionCaps.default,
    targetCeiling: targetResolution?.ceiling,
    targetPreference: targetResolution?.preference,
    steps: effectiveSteps,
  })
  const parsed = runSnapshotSchema.parse({
    ...snapshotBase,
    allowedOrigins: input.allowedOrigins,
    accessPolicy: input.accessPolicy,
    mapConsumption: input.mapConsumption,
    ...(input.mapJob ? { mapJob: input.mapJob } : {}),
    ...(input.suiteAdmission ? { suiteAdmission: input.suiteAdmission } : {}),
    ...(frozenResolution ? { resolution: frozenResolution } : {}),
  })
  const digest = computeSnapshotDigest(parsed)
  return runSnapshotSchema.parse({ ...parsed, digest }) as RunSnapshot & { digest: string }
}
