import type {
  ExecutionError,
  HealerPolicy,
  HealingAttemptEvidence,
  HealingDiagnosis,
  HealingPatch,
  Step,
  TargetDescriptor,
} from '@cairn/shared'

/**
 * 页面上下文守卫检查器：
 * 验证当前页面的 URL 是否与预期上下文吻合。
 * 若发生了未捕获的重定向、跳转到 404/500 报错页或退出登录页面，立即返回 false 熔断自愈。
 */
export function verifyPageContext(input: {
  currentUrl?: string
  expectedUrlPattern?: string
  pageTitle?: string
  pathPrefix?: string
}): boolean {
  if (!input.currentUrl) return false

  const trimmedUrl = input.currentUrl.trim().toLowerCase()
  if (trimmedUrl === '' || trimmedUrl === 'about:blank') {
    return false
  }

  // 1. 错误页面与鉴权失效特征检测
  const urlLower = trimmedUrl
  if (
    urlLower.includes('/404') ||
    urlLower.includes('/500') ||
    urlLower.includes('/error') ||
    urlLower.includes('error=') ||
    urlLower.includes('/login') ||
    urlLower.includes('/auth/signin')
  ) {
    return false
  }

  // 2. pathPrefix 守卫（若配置）
  if (input.pathPrefix) {
    try {
      const urlObj = new URL(input.currentUrl)
      if (!urlObj.pathname.startsWith(input.pathPrefix)) {
        return false
      }
    } catch {
      return false
    }
  }

  // 3. expectedUrlPattern 匹配（若提供正则或通配）
  if (input.expectedUrlPattern) {
    try {
      const regex = new RegExp(input.expectedUrlPattern)
      if (!regex.test(input.currentUrl)) {
        return false
      }
    } catch {
      // 若非有效正则，进行子串匹配
      if (!input.currentUrl.includes(input.expectedUrlPattern)) {
        return false
      }
    }
  }

  return true
}

/**
 * 将自愈补丁应用到步骤输入中，生成供重试 Attempt 执行的新 TargetDescriptor
 */
export function applyPatchToTarget(
  originalTarget: TargetDescriptor | undefined,
  patch: HealingPatch,
): TargetDescriptor | undefined {
  if (patch.kind === 'REPLACE_LOCATOR') {
    if (patch.targetDescriptor) return patch.targetDescriptor
    if (patch.suggestedCandidate) {
      return {
        framePath: [],
        candidates: [patch.suggestedCandidate],
      }
    }
  }

  if (patch.kind === 'ADD_CANDIDATE' && patch.suggestedCandidate && originalTarget) {
    return {
      ...originalTarget,
      candidates: [patch.suggestedCandidate, ...originalTarget.candidates].slice(0, 5),
    }
  }

  return originalTarget
}

/**
 * 将自愈补丁应用到 Step 实例中，生成供重试 Attempt 执行的新 Step
 */
export function applyPatchToStep(step: Step, patch: HealingPatch): Step {
  if (patch.kind === 'UPGRADE_TO_AI_STEP' && patch.upgradeSuggestion) {
    const upgraded: Step = {
      id: step.id,
      name: step.name,
      type: 'ai_action',
      effectType: 'SIDE_EFFECT',
      input: { instruction: patch.upgradeSuggestion.prompt },
    }
    if (step.outputKey) upgraded.outputKey = step.outputKey
    if (step.policy) upgraded.policy = { ...step.policy, retryLimit: 0 }
    return upgraded
  }

  if (patch.kind === 'PREPEND_WAIT' && step.type === 'wait' && patch.suggestedWaitMs) {
    return {
      ...step,
      input: {
        ...step.input,
        timeoutMs: patch.suggestedWaitMs,
      },
    }
  }

  if (step.input && typeof step.input === 'object' && 'target' in step.input) {
    const patchedTarget = applyPatchToTarget(
      step.input.target as TargetDescriptor | undefined,
      patch,
    )
    return {
      ...step,
      input: {
        ...step.input,
        target: patchedTarget,
      },
    } as Step
  }

  return step
}

/**
 * 构建 Attempt 级别的自愈证据
 */
export function buildHealingAttemptEvidence(input: {
  sourceAttemptId: string
  diagnosis: HealingDiagnosis
  patchApplied?: HealingPatch
  outcome: 'HEALED_SUCCESS' | 'HEAL_FAILED' | 'ESCALATED' | 'REJECTED_BY_GUARD'
  candidateId?: string
  postPatchDigest?: string
}): HealingAttemptEvidence {
  return {
    sourceAttemptId: input.sourceAttemptId,
    diagnosis: input.diagnosis,
    ...(input.patchApplied ? { patchApplied: input.patchApplied } : {}),
    outcome: input.outcome,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    ...(input.postPatchDigest ? { postPatchDigest: input.postPatchDigest } : {}),
  }
}

