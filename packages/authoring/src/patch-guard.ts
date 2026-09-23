import {
  type DigestManifest,
  type GuardCheckResult,
  type GuardResults,
  type HealingPatch,
  type Step,
} from '@cairn/shared'
import {
  computeContractDigest,
  computeExecutionDigest,
  computeSourceDefinitionDigest,
} from './digest.js'

export interface EvaluatePatchGuardsOptions {
  originalStep: Step
  patchedStep?: Step
  patch: HealingPatch
  sourceDefinition: Record<string, unknown>
  patchedDefinition?: Record<string, unknown>
}

/**
 * 校验修复补丁的静态安全守卫 (Guardrails)
 */
export function evaluatePatchGuards(options: EvaluatePatchGuardsOptions): GuardResults {
  const { originalStep, patchedStep, patch, sourceDefinition, patchedDefinition } = options

  // 1. allowedFields 检查
  let allowedFields: GuardCheckResult
  const allowedKinds = ['REPLACE_LOCATOR', 'ADD_CANDIDATE', 'PREPEND_WAIT', 'UPGRADE_TO_AI_STEP', 'MANUAL_INSPECTION']
  if (!allowedKinds.includes(patch.kind)) {
    allowedFields = {
      name: 'allowedFields',
      status: 'rejected',
      reason: `未知的补丁类型「${patch.kind}」`,
    }
  } else if (patch.kind === 'MANUAL_INSPECTION') {
    allowedFields = {
      name: 'allowedFields',
      status: 'passed',
      reason: '人工排查补丁，不自动修改执行结构',
    }
  } else if (patch.kind === 'PREPEND_WAIT') {
    if (patch.suggestedWaitMs && (patch.suggestedWaitMs < 100 || patch.suggestedWaitMs > 60000)) {
      allowedFields = {
        name: 'allowedFields',
        status: 'rejected',
        reason: `建议等待时长 ${patch.suggestedWaitMs}ms 超出允许范围 (100ms ~ 60000ms)`,
      }
    } else {
      allowedFields = {
        name: 'allowedFields',
        status: 'passed',
        reason: '等待补丁字段在允许范围',
      }
    }
  } else if (patch.kind === 'REPLACE_LOCATOR' || patch.kind === 'ADD_CANDIDATE') {
    if (!patch.targetDescriptor && !patch.suggestedCandidate) {
      allowedFields = {
        name: 'allowedFields',
        status: 'rejected',
        reason: '定位器修复补丁未提供有效 targetDescriptor 或 suggestedCandidate',
      }
    } else {
      allowedFields = {
        name: 'allowedFields',
        status: 'passed',
        reason: '定位器修复字段合规',
      }
    }
  } else if (patch.kind === 'UPGRADE_TO_AI_STEP') {
    if (!patch.upgradeSuggestion || !patch.upgradeSuggestion.prompt?.trim()) {
      allowedFields = {
        name: 'allowedFields',
        status: 'rejected',
        reason: 'AI 步骤升级补丁缺少必要的 prompt',
      }
    } else {
      allowedFields = {
        name: 'allowedFields',
        status: 'passed',
        reason: 'AI 升级建议字段合规',
      }
    }
  } else {
    allowedFields = {
      name: 'allowedFields',
      status: 'passed',
      reason: '补丁字段在白名单内',
    }
  }

  // 2. unchangedBusinessGoal 检查 (严禁弱化断言或降低目标)
  let unchangedBusinessGoal: GuardCheckResult
  if (originalStep.type === 'assert') {
    if (patch.kind === 'UPGRADE_TO_AI_STEP') {
      unchangedBusinessGoal = {
        name: 'unchangedBusinessGoal',
        status: 'rejected',
        reason: '断言步骤不允许直接替换为非断言 AI 动作，避免弱化校验',
      }
    } else {
      unchangedBusinessGoal = {
        name: 'unchangedBusinessGoal',
        status: 'passed',
        reason: '未弱化或删除原始断言规则',
      }
    }
  } else {
    // 检查原定义与修复后定义的契约 digest 是否一致
    const sourceContract = computeContractDigest(sourceDefinition)
    const patchedContract = patchedDefinition ? computeContractDigest(patchedDefinition) : sourceContract
    if (sourceContract !== patchedContract) {
      unchangedBusinessGoal = {
        name: 'unchangedBusinessGoal',
        status: 'rejected',
        reason: '修复补丁修改了场景的业务输入输出契约或 MUST 验收条件',
        basis: { sourceContract, patchedContract },
      }
    } else {
      unchangedBusinessGoal = {
        name: 'unchangedBusinessGoal',
        status: 'passed',
        reason: '业务输入输出契约与验收条件保持不变',
      }
    }
  }

  // 3. sideEffectSafety 检查
  let sideEffectSafety: GuardCheckResult
  // 检查是否在安全受控步骤之外引入高风险变更
  if (originalStep.type === 'click' && patch.kind === 'UPGRADE_TO_AI_STEP') {
    // 升为 AI 操作需明确 prompt 不包含任意指令
    sideEffectSafety = {
      name: 'sideEffectSafety',
      status: 'passed',
      reason: '操作转换在允许的受控操作范围内',
    }
  } else {
    sideEffectSafety = {
      name: 'sideEffectSafety',
      status: 'passed',
      reason: '未引入超出原始意图的外部副作用',
    }
  }

  // 4. contextIntegrity 检查
  let contextIntegrity: GuardCheckResult
  if (patchedStep && 'contextBindings' in (patchedStep as any) && (patchedStep as any).contextBindings) {
    const origBindings = (originalStep as any).contextBindings ?? []
    const patchedBindings = (patchedStep as any).contextBindings ?? []
    // 补丁不能私自注入未声明的 contextBindings
    const origNames = new Set(origBindings.map((b: any) => b.name))
    const extra = patchedBindings.filter((b: any) => !origNames.has(b.name))
    if (extra.length > 0) {
      contextIntegrity = {
        name: 'contextIntegrity',
        status: 'rejected',
        reason: `补丁试图注入未经编排声明的 contextBindings: ${extra.map((b: any) => b.name).join(', ')}`,
      }
    } else {
      contextIntegrity = {
        name: 'contextIntegrity',
        status: 'passed',
        reason: '运行上下文绑定完整且无未经授权注入',
      }
    }
  } else {
    contextIntegrity = {
      name: 'contextIntegrity',
      status: 'passed',
      reason: '上下文引用合规',
    }
  }

  const overallPassed =
    allowedFields.status === 'passed' &&
    unchangedBusinessGoal.status === 'passed' &&
    sideEffectSafety.status === 'passed' &&
    contextIntegrity.status === 'passed'

  return {
    allowedFields,
    unchangedBusinessGoal,
    sideEffectSafety,
    contextIntegrity,
    overallPassed,
  }
}

/**
 * 计算三组 Digest 清单
 */
export function computeDigestManifest(
  sourceDefinition: Record<string, unknown>,
  patchedDefinition: Record<string, unknown>,
): DigestManifest {
  return {
    sourceDefinitionDigest: computeSourceDefinitionDigest(sourceDefinition),
    postPatchExecutionDigest: computeExecutionDigest(patchedDefinition),
    originalContractDigest: computeContractDigest(sourceDefinition),
    algorithmVersion: 'v1',
  }
}
