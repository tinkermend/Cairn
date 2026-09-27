import type { CompileDiagnostic } from '@cairn/shared'

export interface FriendlyDiagnosticInfo {
  title: string
  suggestion?: string
  targetLabel: string
}

export const DIAGNOSTIC_FRIENDLY_MAP: Record<string, { title: string; suggestion: string; targetLabel: string }> = {
  MODULE_VERIFICATION_MISSING: {
    title: '缺少可执行验证',
    suggestion: '模块已声明后置条件，但实现中缺少有效断言。请在右侧实现中添加断言步骤（assert / ai_assert），或在后置条件中绑定验证逻辑。',
    targetLabel: '后置条件与断言',
  },
  MODULE_PRECONDITION_MISSING: {
    title: '缺少前置防护断言',
    suggestion: '包含持久写操作的非只读模块必须在前置条件中声明副作用执行前的断言检查，以防误写入脏数据。',
    targetLabel: '前置条件',
  },
  MODULE_VERIFICATION_TOO_WEAK: {
    title: '后置验证时机过弱',
    suggestion: '交互后须提取必需输出，或等待加载指示消失后再执行后置断言校验。',
    targetLabel: '后置验证时机',
  },
  MODULE_INPUT_UNUSED: {
    title: '输入参数未被引用',
    suggestion: '声明的输入未在任何实现步骤中被使用，建议在步骤中引用（${inputs.xxx}）或删除无用输入。',
    targetLabel: '输入声明',
  },
  MODULE_INPUT_UNDECLARED: {
    title: '引用未声明参数',
    suggestion: '引用的变量既不是已声明的模块输入，也不是更早步骤的输出产物，请检查拼写或补充声明。',
    targetLabel: '步骤变量引用',
  },
  MODULE_EFFECT_EXCEEDS_CEILING: {
    title: '步骤副作用超出上限',
    suggestion: '步骤声明的写副作用等级高于模块整体的“副作用上限”，请调整步骤副作用或调高模块上限。',
    targetLabel: '副作用上限',
  },
  MODULE_OUTPUT_UNMAPPED: {
    title: '输出产物未映射',
    suggestion: '契约声明了模块输出，但未在实现步骤的输出映射中指定来源步骤。',
    targetLabel: '输出映射',
  },
  MODULE_IMPLEMENTATION_EMPTY: {
    title: '实现步骤为空',
    suggestion: '发布模块必须至少包含一个可执行的步骤。',
    targetLabel: '实现步骤',
  },
  MODULE_BINDING_UNSUPPORTED: {
    title: '参数绑定格式不受支持',
    suggestion: '请检查字段绑定类型或表达式语法（例如 ${inputs.key}）。',
    targetLabel: '字段绑定',
  },
  MODULE_CONDITION_STEP_INVALID: {
    title: '前/后置条件绑定无效',
    suggestion: '绑定的验证步骤必须是有效的断言步骤或已映射的输出。',
    targetLabel: '条件绑定',
  },
  MODULE_CONDITION_OUTPUT_INVALID: {
    title: '条件输出验证无效',
    suggestion: '引用的输出必须在契约 outputs 中已声明并正确映射。',
    targetLabel: '条件输出',
  },
}

export function formatFieldPath(fieldPath?: string[]): string {
  if (!fieldPath || fieldPath.length === 0) return ''
  const [root, second, third] = fieldPath
  if (root === 'contract') {
    if (second === 'inputs') return third !== undefined ? `输入参数 #${Number(third) + 1}` : '输入声明'
    if (second === 'outputs') return third !== undefined ? `输出产物 #${Number(third) + 1}` : '输出声明'
    if (second === 'preconditions') return third !== undefined ? `前置条件 #${Number(third) + 1}` : '契约前置条件'
    if (second === 'postconditions') return third !== undefined ? `后置条件 #${Number(third) + 1}` : '契约后置条件'
    if (second === 'effectCeiling') return '副作用上限'
    if (second === 'entryState') return '前置起始状态'
    if (second === 'exitState') return '后置结束状态'
    return `契约配置 (${second})`
  }
  if (root === 'implementations') {
    if (second && third === 'steps') {
      const stepIdx = fieldPath[3]
      return stepIdx !== undefined ? `步骤 #${Number(stepIdx) + 1}` : '实现步骤'
    }
    return '模块实现'
  }
  return fieldPath.join('.')
}

export function getFriendlyDiagnostic(
  diagnostic: CompileDiagnostic
): FriendlyDiagnosticInfo {
  const mapped = DIAGNOSTIC_FRIENDLY_MAP[diagnostic.code]
  const pathLabel = formatFieldPath(diagnostic.fieldPath)
  if (mapped) {
    return {
      title: mapped.title,
      suggestion: mapped.suggestion,
      targetLabel: pathLabel || mapped.targetLabel,
    }
  }
  return {
    title: diagnostic.message,
    suggestion: undefined,
    targetLabel: pathLabel || '模块配置',
  }
}
