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
