import {
  isAiStepType,
  type EffectType,
  type ExecutableStepType,
  type ScenarioCapabilities,
  type Step,
} from '@cairn/shared'
import { uniqueOutputKey, usedContextKeys } from './studio-document'

/** ST02 起步骤库 / 改类型的显式八种允许列表，禁止遍历 EXECUTABLE_STEP_TYPES。 */
export const DETERMINISTIC_STUDIO_TYPES = [
  'navigate',
  'click',
  'fill',
  'extract',
  'assert',
  'echo',
  'delay',
  'fail',
] as const

export type DeterministicStudioType = (typeof DETERMINISTIC_STUDIO_TYPES)[number]

export const STEP_TYPE_LABELS: Record<ExecutableStepType, string> = {
  echo: '回显',
  delay: '等待',
  fail: '失败',
  navigate: '导航',
  click: '点击',
  fill: '填写',
  extract: '提取',
  assert: '断言',
  ai_action: 'AI 操作',
  ai_extract: 'AI 提取',
  ai_assert: 'AI 判断',
}

export const STEP_TYPE_HINTS: Record<ExecutableStepType, string> = {
  navigate: '打开页面',
  click: '点击元素',
  fill: '填写输入',
  extract: '提取文本或属性',
  assert: '确定性断言',
  echo: '回显上下文',
  delay: '等待一段时间',
  fail: '主动失败',
  ai_action: '按业务意图操作页面',
  ai_extract: '按契约提取结构化字段',
  ai_assert: '判断业务条件是否成立',
}

export const DEFAULT_EFFECT: Record<DeterministicStudioType, EffectType> = {
  extract: 'READ_ONLY',
  assert: 'READ_ONLY',
  echo: 'READ_ONLY',
  delay: 'READ_ONLY',
  navigate: 'SIDE_EFFECT',
  click: 'SIDE_EFFECT',
  fill: 'SIDE_EFFECT',
  fail: 'SIDE_EFFECT',
}

export function stepTypeLabel(type: string): string {
  return type in STEP_TYPE_LABELS ? STEP_TYPE_LABELS[type as ExecutableStepType] : type
}

export function isDeterministicStudioType(type: string): type is DeterministicStudioType {
  return (DETERMINISTIC_STUDIO_TYPES as readonly string[]).includes(type)
}

export function selectableStudioTypes(capabilities: ScenarioCapabilities | undefined): ExecutableStepType[] {
  const open = new Set(capabilities?.executableStepTypes ?? DETERMINISTIC_STUDIO_TYPES)
  const types: ExecutableStepType[] = DETERMINISTIC_STUDIO_TYPES.filter((type) => open.has(type))
  for (const type of ['ai_action', 'ai_extract', 'ai_assert'] as const) {
    if (open.has(type)) types.push(type)
  }
  return types
}

export function unavailableStudioTypes(
  capabilities: ScenarioCapabilities | undefined,
): { type: ExecutableStepType; message: string }[] {
  return (capabilities?.unavailableReasons ?? [])
    .filter((item) => isAiStepType(item.type))
    .map((item) => ({ type: item.type as ExecutableStepType, message: item.message }))
}

export function defaultTarget(label = '目标元素') {
  return {
    framePath: [] as [],
    candidates: [{ by: 'label' as const, value: label }],
  }
}

export function createBlankStep(type: ExecutableStepType, used: Iterable<string> = []): Step {
  const id = crypto.randomUUID()
  const name = STEP_TYPE_LABELS[type]
  const taken = usedContextKeys(used)
  if (type === 'ai_action') {
    return { id, name, type, effectType: 'SIDE_EFFECT', input: { instruction: '完成指定的页面操作' } }
  }
  if (type === 'ai_extract') {
    return {
      id,
      name,
      type,
      effectType: 'READ_ONLY',
      outputKey: uniqueOutputKey('extracted', taken),
      input: {
        instruction: '提取当前页的结构化字段',
        outputSchema: { kind: 'object', fields: [{ name: 'value', type: 'string', required: true }] },
      },
    }
  }
  if (type === 'ai_assert') {
    return {
      id,
      name,
      type,
      effectType: 'READ_ONLY',
      outputKey: uniqueOutputKey('asserted', taken),
      input: { instruction: '判断当前页是否满足业务条件' },
    }
  }
  const effectType = DEFAULT_EFFECT[type]
  switch (type) {
    case 'navigate':
      return { id, name, type, effectType, input: { url: 'https://example.com' } }
    case 'click':
      return { id, name, type, effectType, input: { target: defaultTarget('按钮') } }
    case 'fill':
      return { id, name, type, effectType, input: { target: defaultTarget('输入框'), value: '' } }
    case 'extract':
      return {
        id,
        name,
        type,
        effectType,
        outputKey: uniqueOutputKey('extracted', taken),
        input: { target: defaultTarget('文本'), as: 'text' },
      }
    case 'assert':
      return { id, name, type, effectType, input: { target: defaultTarget('结果'), expect: { kind: 'exists' } } }
    case 'echo':
      return { id, name, type, effectType, input: { value: '' } }
    case 'delay':
      return { id, name, type, effectType, input: { durationMs: 100 } }
    case 'fail':
      return { id, name, type, effectType, input: { message: '主动失败' } }
  }
}
