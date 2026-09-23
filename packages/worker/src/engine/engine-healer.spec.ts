import { describe, expect, it } from 'vitest'
import {
  ASSERT_FAILED_CODE,
  type ExecutionError,
  type Step,
  type TargetDescriptor,
  healingAttemptEvidenceSchema,
} from '@cairn/shared'
import { isTrialOrDebugRun, shouldAttemptSelfHeal } from './engine-decisions.js'
import {
  applyPatchToStep,
  applyPatchToTarget,
  buildHealingAttemptEvidence,
  verifyPageContext,
} from './engine-healer.js'

describe('SH-1 & SH-2: Step Healer Decisions and Guardrails', () => {
  const readStep: Step = {
    id: 'step-read',
    name: '提取文本',
    type: 'extract',
    effectType: 'READ_ONLY',
  }

  const sideEffectStep: Step = {
    id: 'step-click',
    name: '点击提交',
    type: 'click',
    effectType: 'SIDE_EFFECT',
  }

  const targetNotFoundError: ExecutionError = {
    code: 'TARGET_NOT_FOUND',
    category: 'EXECUTOR',
    retryable: true,
    safeMessage: '未找到指定元素',
  }

  const timeoutError: ExecutionError = {
    code: 'STEP_TIMEOUT',
    category: 'TIMEOUT',
    retryable: false,
    safeMessage: '步骤超时',
  }

  describe('verifyPageContext (Page Context Guard)', () => {
    it('SH04-A: 正常同域 URL 校验通过', () => {
      expect(
        verifyPageContext({
          currentUrl: 'https://app.cairn.dev/orders/123',
          pathPrefix: '/orders',
        }),
      ).toBe(true)
    })

    it('SH04-B: 页面跳转至 404 / 500 / error / login 错误页时熔断拒绝', () => {
      expect(verifyPageContext({ currentUrl: 'https://app.cairn.dev/404' })).toBe(false)
      expect(verifyPageContext({ currentUrl: 'https://app.cairn.dev/500' })).toBe(false)
      expect(verifyPageContext({ currentUrl: 'https://app.cairn.dev/login?expired=1' })).toBe(false)
      expect(verifyPageContext({ currentUrl: 'https://app.cairn.dev/auth/signin' })).toBe(false)
    })

    it('SH04-C: 偏离 pathPrefix 时熔断拒绝', () => {
      expect(
        verifyPageContext({
          currentUrl: 'https://app.cairn.dev/settings/profile',
          pathPrefix: '/orders',
        }),
      ).toBe(false)
    })

    it('SH04-D: expectedUrlPattern 正则匹配与不匹配', () => {
      expect(
        verifyPageContext({
          currentUrl: 'https://app.cairn.dev/orders/details/999',
          expectedUrlPattern: '^https://app\\.cairn\\.dev/orders/',
        }),
      ).toBe(true)

      expect(
        verifyPageContext({
          currentUrl: 'https://app.cairn.dev/users/list',
          expectedUrlPattern: '^https://app\\.cairn\\.dev/orders/',
        }),
      ).toBe(false)
    })

    it('SH04-E: 页面为空白页 about:blank、空字符串或缺少 URL 时熔断拒绝', () => {
      expect(verifyPageContext({ currentUrl: 'about:blank' })).toBe(false)
      expect(verifyPageContext({ currentUrl: '   ' })).toBe(false)
      expect(verifyPageContext({})).toBe(false)
      expect(verifyPageContext({ currentUrl: undefined })).toBe(false)
    })
  })

  describe('shouldAttemptSelfHeal (Healer Admission Decisions)', () => {
    it('B4 门禁: 缺少有效 suggestedPatch 时严禁伪自愈', () => {
      const healable = shouldAttemptSelfHeal({
        policy: 'safe_runtime',
        isTrialOrDebug: false,
        step: readStep,
        error: targetNotFoundError,
        attemptNo: 1,
        maxHealAttempts: 1,
        hasModelBudget: true,
        pageContextMatch: true,
        hasSuggestedPatch: false,
      })
      expect(healable).toBe(false)
    })
    it('SH01: 只读步骤定位失败在 safe_runtime 下允许自愈', () => {
      const healable = shouldAttemptSelfHeal({
        policy: 'safe_runtime',
        isTrialOrDebug: false,
        step: readStep,
        error: targetNotFoundError,
        attemptNo: 1,
        maxHealAttempts: 1,
        hasModelBudget: true,
        pageContextMatch: true,
      })
      expect(healable).toBe(true)
    })

    it('SH02: 副作用步骤未触碰（TARGET_NOT_FOUND）在 safe_runtime 下允许自愈', () => {
      const healable = shouldAttemptSelfHeal({
        policy: 'safe_runtime',
        isTrialOrDebug: false,
        step: sideEffectStep,
        error: targetNotFoundError,
        attemptNo: 1,
        maxHealAttempts: 1,
        hasModelBudget: true,
        pageContextMatch: true,
      })
      expect(healable).toBe(true)
    })

    it('SH03: 副作用步骤超时（动作可能已发出）坚决拒绝自愈', () => {
      const healable = shouldAttemptSelfHeal({
        policy: 'safe_runtime',
        isTrialOrDebug: false,
        step: sideEffectStep,
        error: timeoutError,
        attemptNo: 1,
        maxHealAttempts: 1,
        hasModelBudget: true,
        pageContextMatch: true,
      })
      expect(healable).toBe(false)
    })

    it('SH04: 页面上下文守卫不通过时坚决拒绝自愈', () => {
      const healable = shouldAttemptSelfHeal({
        policy: 'safe_runtime',
        isTrialOrDebug: false,
        step: readStep,
        error: targetNotFoundError,
        attemptNo: 1,
        maxHealAttempts: 1,
        hasModelBudget: true,
        pageContextMatch: false, // 守卫未通过
      })
      expect(healable).toBe(false)
    })

    it('试跑或调试模式才视为 authoring_only 可激活范围', () => {
      expect(isTrialOrDebugRun({ debugMode: 'runThrough', mapSourceType: 'formal_run' })).toBe(false)
      expect(isTrialOrDebugRun({ debugMode: 'runThrough', mapSourceType: 'trial' })).toBe(true)
      expect(isTrialOrDebugRun({ debugMode: 'holdOnFailure', mapSourceType: 'formal_run' })).toBe(true)
      expect(isTrialOrDebugRun({ debugMode: 'holdAfterEach', mapSourceType: 'formal_run' })).toBe(true)
    })

    it('SH05: authoring_only 策略在正式生产 Run 拒绝，但在试跑/调试 Run 允许', () => {
      // 生产 Run (isTrialOrDebug: false)
      const prodHeal = shouldAttemptSelfHeal({
        policy: 'authoring_only',
        isTrialOrDebug: false,
        step: readStep,
        error: targetNotFoundError,
        attemptNo: 1,
        maxHealAttempts: 1,
        hasModelBudget: true,
        pageContextMatch: true,
      })
      expect(prodHeal).toBe(false)

      // 试跑/调试 Run (isTrialOrDebug: true)
      const trialHeal = shouldAttemptSelfHeal({
        policy: 'authoring_only',
        isTrialOrDebug: true,
        step: readStep,
        error: targetNotFoundError,
        attemptNo: 1,
        maxHealAttempts: 1,
        hasModelBudget: true,
        pageContextMatch: true,
      })
      expect(trialHeal).toBe(true)
    })

    it('SH06: off 策略完全关闭自愈', () => {
      const healable = shouldAttemptSelfHeal({
        policy: 'off',
        isTrialOrDebug: true,
        step: readStep,
        error: targetNotFoundError,
        attemptNo: 1,
        maxHealAttempts: 1,
        hasModelBudget: true,
        pageContextMatch: true,
      })
      expect(healable).toBe(false)
    })

    it('SH07: 丢租或断言失败等确定性错误坚决拒绝自愈', () => {
      expect(
        shouldAttemptSelfHeal({
          policy: 'safe_runtime',
          isTrialOrDebug: true,
          step: readStep,
          error: { code: 'SESSION_LEASE_LOST', category: 'INFRASTRUCTURE', retryable: false, safeMessage: '丢租' },
          attemptNo: 1,
          maxHealAttempts: 1,
          hasModelBudget: true,
          pageContextMatch: true,
        }),
      ).toBe(false)

      expect(
        shouldAttemptSelfHeal({
          policy: 'safe_runtime',
          isTrialOrDebug: true,
          step: readStep,
          error: { code: ASSERT_FAILED_CODE, category: 'EXECUTOR', retryable: false, safeMessage: '断言不成立' },
          attemptNo: 1,
          maxHealAttempts: 1,
          hasModelBudget: true,
          pageContextMatch: true,
        }),
      ).toBe(false)
    })

    it('SH08: 尝试次数超限或无模型预算拒绝自愈', () => {
      // attemptNo > maxHealAttempts
      expect(
        shouldAttemptSelfHeal({
          policy: 'safe_runtime',
          isTrialOrDebug: true,
          step: readStep,
          error: targetNotFoundError,
          attemptNo: 2,
          maxHealAttempts: 1,
          hasModelBudget: true,
          pageContextMatch: true,
        }),
      ).toBe(false)

      // hasModelBudget: false
      expect(
        shouldAttemptSelfHeal({
          policy: 'safe_runtime',
          isTrialOrDebug: true,
          step: readStep,
          error: targetNotFoundError,
          attemptNo: 1,
          maxHealAttempts: 1,
          hasModelBudget: false,
          pageContextMatch: true,
        }),
      ).toBe(false)
    })
  })

  describe('applyPatchToTarget (Target Materialization)', () => {
    const originalTarget: TargetDescriptor = {
      framePath: [],
      candidates: [{ by: 'css', value: '#old-btn' }],
    }

    it('REPLACE_LOCATOR: 替换主定位器', () => {
      const newTarget: TargetDescriptor = {
        framePath: [],
        candidates: [{ by: 'role', value: 'button', name: '提交订单' }],
      }
      const patched = applyPatchToTarget(originalTarget, {
        kind: 'REPLACE_LOCATOR',
        targetDescriptor: newTarget,
      })
      expect(patched).toEqual(newTarget)
    })

    it('ADD_CANDIDATE: 追加建议候选项至首位（反向物化）', () => {
      const patched = applyPatchToTarget(originalTarget, {
        kind: 'ADD_CANDIDATE',
        suggestedCandidate: { by: 'text', value: '确认' },
      })
      expect(patched?.candidates).toEqual([
        { by: 'text', value: '确认' },
        { by: 'css', value: '#old-btn' },
      ])
    })
  })

  describe('buildHealingAttemptEvidence (Evidence Structure)', () => {
    it('构造合法的 HealingAttemptEvidence 对象并通过 schema 校验', () => {
      const evidence = buildHealingAttemptEvidence({
        sourceAttemptId: '00000000-0000-4000-8000-000000000001',
        diagnosis: {
          cause: 'LOCATOR_DRIFT',
          confidence: 0.95,
          analysisSummary: '按钮 class 发生哈希刷新，语义文本保持不变',
          contextVerified: true,
          suggestedPatch: {
            kind: 'ADD_CANDIDATE',
            suggestedCandidate: { by: 'role', value: 'button', name: '登录' },
          },
        },
        patchApplied: {
          kind: 'ADD_CANDIDATE',
          suggestedCandidate: { by: 'role', value: 'button', name: '登录' },
        },
        outcome: 'HEALED_SUCCESS',
      })

      const parseResult = healingAttemptEvidenceSchema.safeParse(evidence)
      expect(parseResult.success).toBe(true)
    })
  })

  describe('applyPatchToStep (Step Dynamic Patching)', () => {
    const originalStep: Step = {
      id: 'step-1',
      name: '点击保存',
      type: 'click',
      effectType: 'SIDE_EFFECT',
      input: {
        target: { framePath: [], candidates: [{ by: 'css', value: '#save' }] },
      },
    }

    it('UPGRADE_TO_AI_STEP: 将步骤转换为 ai_action 并在 input.instruction 回填', () => {
      const patched = applyPatchToStep(originalStep, {
        kind: 'UPGRADE_TO_AI_STEP',
        upgradeSuggestion: {
          stepType: 'ai_action',
          prompt: '点击保存按钮',
        },
      })
      expect(patched.type).toBe('ai_action')
      expect(patched.input).toEqual({ instruction: '点击保存按钮' })
    })

    it('ADD_CANDIDATE: 向 step.input.target 追加候选', () => {
      const patched = applyPatchToStep(originalStep, {
        kind: 'ADD_CANDIDATE',
        suggestedCandidate: { by: 'text', value: '保存' },
      })
      expect((patched.input as Record<string, unknown>).target).toEqual({
        framePath: [],
        candidates: [
          { by: 'text', value: '保存' },
          { by: 'css', value: '#save' },
        ],
      })
    })
  })
})

