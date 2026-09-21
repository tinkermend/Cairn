import {
  ASSERT_FAILED_CODE,
  isAiStepType,
  isSessionConfigErrorCode,
  type AuthObservation,
  type DebugCheckpoint,
  type DebugCheckpointReason,
  type DebugMode,
  type DebugOverlay,
  type ExecutionError,
  type MapRunSourceType,
  type PageRef,
  type RunGrant,
  type SessionGrant,
  type Step,
} from '@cairn/shared'

export function confirmFromCause(message?: string): AuthObservation | null {
  if (message === 'MATCH') {
    return {
      authState: 'AUTHENTICATED',
      identityState: 'MATCH',
      observedIdentity: null,
      unknownClass: null,
      evidenceSummary: '确认核验通过',
      authProfileRevision: null,
      diagnosticCode: 'verified',
    }
  }
  if (message === 'MISMATCH') {
    return {
      authState: 'AUTHENTICATED',
      identityState: 'MISMATCH',
      observedIdentity: null,
      unknownClass: null,
      evidenceSummary: '确认核验身份不符',
      authProfileRevision: null,
      diagnosticCode: 'verified',
    }
  }
  return {
    authState: message === 'EXPIRED' ? 'EXPIRED' : 'UNKNOWN',
    identityState: 'UNVERIFIED',
    observedIdentity: null,
    unknownClass: null,
    evidenceSummary: message === 'EXPIRED' ? '确认核验登录已失效' : '无法确认登录状态',
    authProfileRevision: null,
    diagnosticCode: 'verified',
  }
}

export function shouldNeedsReview(step: Step, error: ExecutionError, timedOut: boolean, aborted: boolean): boolean {
  if (step.effectType !== 'SIDE_EFFECT') return false
  if (error.category === 'UNKNOWN') return true
  if (error.category === 'TIMEOUT' || timedOut) return true
  return aborted
}

const ACQUIRE_FAIL_MESSAGES: Record<string, string> = {
  SESSION_ACCOUNT_REQUIRED: '浏览器步骤未指定目标账号，无法建立会话',
  SESSION_TARGET_MISSING: '目标系统不存在或已被删除',
  SESSION_POLICY_INVALID: '会话策略不合法',
}

export function acquireValidationError(outcome: { code: string; message: string }): ExecutionError {
  return {
    code: outcome.code,
    category: isSessionConfigErrorCode(outcome.code) ? 'VALIDATION' : 'INFRASTRUCTURE',
    retryable: false,
    safeMessage: ACQUIRE_FAIL_MESSAGES[outcome.code] ?? outcome.message,
  }
}

export function checkpointOf(input: {
  debugMode: DebugMode
  reason: DebugCheckpointReason
  stepId: string
  stepOrdinal: number
  contextKeys: string[]
  sessionGrant?: SessionGrant
  grant: RunGrant
  overlay?: DebugOverlay | null
  pageRef?: PageRef
  url?: string
}): DebugCheckpoint {
  return {
    mode: input.debugMode === 'holdAfterEach' ? 'holdAfterEach' : 'holdOnFailure',
    reason: input.reason,
    stepId: input.stepId,
    stepOrdinal: input.stepOrdinal,
    ...(input.pageRef ? { pageRef: input.pageRef } : {}),
    ...(input.url ? { url: input.url } : {}),
    contextKeys: input.contextKeys,
    sessionGeneration: input.sessionGrant?.generation ?? 0,
    fencingToken: String(input.grant.fencingToken),
    overlayRevision: input.overlay?.revision ?? 0,
  }
}

export function shouldRetry(step: Step, error: ExecutionError, attemptNo: number, retryLimit: number): boolean {
  if (attemptNo >= retryLimit + 1) return false
  if (error.code === ASSERT_FAILED_CODE) return false
  // 同一次执行复用同一份会话授权，guard 撤销后不再刷新：丢租后重试注定失败。
  if (error.code === 'SESSION_LEASE_LOST') return false
  if (isAiStepType(step.type) && step.type === 'ai_action') return false
  if (step.effectType === 'SIDE_EFFECT' && (error.category === 'UNKNOWN' || error.category === 'TIMEOUT')) {
    return false
  }
  if (error.category === 'VALIDATION' || error.category === 'CANCELLED') return false
  return error.category === 'TIMEOUT' || error.category === 'EXECUTOR' || error.category === 'INFRASTRUCTURE'
}

export function isTrialOrDebugRun(input: { debugMode: DebugMode; mapSourceType: MapRunSourceType }): boolean {
  return input.debugMode !== 'runThrough' || input.mapSourceType === 'trial'
}

export interface ShouldAttemptSelfHealInput {
  policy: import('@cairn/shared').HealerPolicy
  isTrialOrDebug: boolean
  step: Step
  error: ExecutionError
  attemptNo: number
  maxHealAttempts: number
  hasModelBudget: boolean
  pageContextMatch: boolean
}

/**
 * 判定当前失败是否符合自愈条件：
 * 1. 策略门禁（off 全关，authoring_only 仅限试跑/调试，safe_runtime 允许受控自愈）
 * 2. 页面上下文守卫（URL/Title 发生未预期跳转时绝对禁止自愈）
 * 3. 次数与模型预算熔断
 * 4. 排除丢租、断言失败、验证失败等确定性错误
 * 5. 副作用断流：有副作用步骤仅在动作未发出（TARGET_NOT_FOUND / RESOLVER_EXHAUSTED）时允许自愈
 */
export function shouldAttemptSelfHeal(input: ShouldAttemptSelfHealInput): boolean {
  if (input.policy === 'off') return false
  if (input.policy === 'authoring_only' && !input.isTrialOrDebug) return false
  if (!input.pageContextMatch) return false
  if (input.attemptNo > input.maxHealAttempts || !input.hasModelBudget) return false

  if (input.error.code === 'SESSION_LEASE_LOST' || input.error.code === ASSERT_FAILED_CODE) return false
  if (input.error.category === 'VALIDATION' || input.error.category === 'CANCELLED') return false

  if (input.step.effectType === 'SIDE_EFFECT') {
    return input.error.code === 'TARGET_NOT_FOUND' || input.error.code === 'RESOLVER_EXHAUSTED'
  }

  return (
    input.error.code === 'TARGET_NOT_FOUND' ||
    input.error.code === 'RESOLVER_EXHAUSTED' ||
    input.error.category === 'TIMEOUT'
  )
}

