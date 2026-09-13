import type { EffectType, ExecutableStepType, Step, TargetDescriptor } from '@cairn/shared'
import { STEP_TYPE_LABELS } from './labels'

export const DEFAULT_EFFECT: Record<ExecutableStepType, EffectType> = {
  extract: 'READ_ONLY',
  assert: 'READ_ONLY',
  echo: 'READ_ONLY',
  delay: 'READ_ONLY',
  navigate: 'SIDE_EFFECT',
  click: 'SIDE_EFFECT',
  fill: 'SIDE_EFFECT',
  fail: 'SIDE_EFFECT',
}

export function defaultTarget(label = '目标元素'): TargetDescriptor {
  return {
    framePath: [],
    candidates: [{ by: 'label', value: label }],
  }
}

export function createBlankStep(type: ExecutableStepType): Step {
  const id = crypto.randomUUID()
  const name = STEP_TYPE_LABELS[type]
  const effectType = DEFAULT_EFFECT[type]
  switch (type) {
    case 'navigate':
      return { id, name, type, effectType, input: { url: 'https://example.com' } }
    case 'click':
      return { id, name, type, effectType, input: { target: defaultTarget('按钮') } }
    case 'fill':
      return { id, name, type, effectType, input: { target: defaultTarget('输入框'), value: '' } }
    case 'extract':
      return { id, name, type, effectType, outputKey: 'extracted', input: { target: defaultTarget('文本'), as: 'text' } }
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
