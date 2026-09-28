import {
  hasAiSteps,
  insertNodeAfter,
  moveNodeWithin,
  outputShapeForStep,
  removeNode,
  replaceNode,
  scenarioAuthoringDocumentV2Schema,
  isAuthoringDocumentV2,
  toAuthoringDocumentV2,
  stepUsesBrowser,
  walkAuthoringNodes,
  type AuthoringBlockNode,
  type ModuleInputBinding,
  type OutputShape,
  type ScenarioDocument,
  type ScenarioAuthoringDocumentV2,
  type ScenarioAuthoringNode,
  type ScenarioStepNode,
  type ScenarioModuleInvocationNode,
  type Step,
  MAX_LOCATOR_CANDIDATES,
  type LocatorCandidate,
  type TargetDescriptor,
} from '@cairn/shared'
import {
  documentContextKeys,
  priorOutputShapes,
  usedContextKeys,
  type BindingOption,
} from '@/features/authoring/document'
import { createBlankStep } from '@/features/authoring/step-registry'

export { isAuthoringDocumentV2, toAuthoringDocumentV2 }
export type {
  AuthoringBlockNode,
  ScenarioAuthoringDocumentV2,
  ScenarioAuthoringNode,
  ScenarioStepNode,
  ScenarioModuleInvocationNode,
}
export {
  documentContextKeys,
  fieldElementId,
  focusStudioField,
  outputConsumers,
  priorBindings,
  priorOutputShapes,
  stepBindingFrom,
  tryReplaceInputs,
  tryReplaceStep,
  uniqueOutputKey,
  usedContextKeys,
  type BindingOption,
} from '@/features/authoring/document'

export function sameDocument(
  left: ScenarioDocument | ScenarioAuthoringDocumentV2,
  right: ScenarioDocument | ScenarioAuthoringDocumentV2
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]'
    )
  )
}

export function insertStep(
  document: ScenarioDocument,
  step: Step,
  afterIndex: number
): ScenarioDocument {
  const steps = [...document.steps]
  const index = afterIndex < 0 ? steps.length : afterIndex + 1
  steps.splice(index, 0, step)
  return { ...document, steps }
}

export function moveStep(
  document: ScenarioDocument,
  index: number,
  delta: number
): ScenarioDocument | null {
  const nextIndex = index + delta
  if (nextIndex < 0 || nextIndex >= document.steps.length) return null
  const steps = [...document.steps]
  const [item] = steps.splice(index, 1)
  if (!item) return null
  steps.splice(nextIndex, 0, item)
  return { ...document, steps }
}

export function nodeId(node: ScenarioAuthoringNode): string {
  if (node.kind === 'step') return node.step.id
  if (node.kind === 'block') return node.blockId
  return node.invocationId
}

export function createBlankBlockNode(name?: string): AuthoringBlockNode {
  const genId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `blk_${Math.random().toString(36).slice(2, 10)}`
  return {
    kind: 'block',
    blockId: genId,
    name: name ?? '条件分支',
    control: {
      type: 'if',
      condition: {
        kind: 'compare',
        op: 'eq',
        left: { kind: 'literal', value: true },
        right: { kind: 'literal', value: true },
      },
    },
    then: [
      {
        kind: 'step',
        step: createBlankStep('wait'),
      },
    ],
  }
}

export function consecutiveExtractStepIds(
  document: ScenarioAuthoringDocumentV2,
  selectedIds: readonly string[]
): string[] {
  const wanted = new Set(selectedIds)
  if (wanted.size === 0) return []
  const items = walkAuthoringNodes(document)
  const indexes: number[] = []
  for (const [index, item] of items.entries()) {
    const node = item.node
    if (node.kind === 'module' && wanted.has(node.invocationId)) return []
    if (node.kind === 'step' && wanted.has(node.step.id)) indexes.push(index)
  }
  if (indexes.length === 0 || indexes.length !== wanted.size) return []
  const start = indexes[0]!
  const end = indexes[indexes.length - 1]!
  if (end - start + 1 !== indexes.length) return []
  for (let index = start; index <= end; index++) {
    if (items[index]?.node.kind !== 'step') return []
  }
  return items
    .slice(start, end + 1)
    .flatMap((item) => (item.node.kind === 'step' ? [item.node.step.id] : []))
}

export function authoringNodes(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2
): ScenarioAuthoringNode[] {
  if (isAuthoringDocumentV2(document)) {
    return walkAuthoringNodes(document).map((item) => item.node)
  }
  return document.steps.map((step) => ({ kind: 'step' as const, step }))
}

export function firstAuthoringNodeId(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2
): string | null {
  const first = authoringNodes(document)[0]
  return first ? nodeId(first) : null
}

export function documentNodeCount(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2
): number {
  return authoringNodes(document).length
}

export function documentHasAiSteps(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2
): boolean {
  return authoringNodes(document).some(
    (node) => node.kind === 'step' && hasAiSteps([node.step])
  )
}

export function documentUsesBrowser(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2
): boolean {
  return authoringNodes(document).some(
    (node) =>
      node.kind === 'module' ||
      (node.kind === 'step' && stepUsesBrowser(node.step.type))
  )
}

export function documentContextKeysAny(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2
): Set<string> {
  if (isAuthoringDocumentV2(document)) {
    return usedContextKeys([
      ...document.inputs.map((input) => input.key),
      ...walkAuthoringNodes(document).flatMap((item) => {
        const node = item.node
        if (node.kind === 'step' && node.step.outputKey)
          return [node.step.outputKey]
        if (node.kind === 'module')
          return Object.values(node.outputBindings).filter(Boolean)
        return []
      }),
    ])
  }
  return documentContextKeys(document)
}

export interface VariableSourceItem {
  key: string
  label: string
  category: 'input' | 'step' | 'module'
  categoryLabel: string
  description: string
  stepIndex?: number
  stepName?: string
  nodeId?: string
}

export function collectVariableSources(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2 | null | undefined
): VariableSourceItem[] {
  if (!document) return []
  const sources: VariableSourceItem[] = []

  // 1. 场景输入
  if (isAuthoringDocumentV2(document)) {
    for (const input of document.inputs) {
      if (input.key) {
        sources.push({
          key: input.key,
          label: input.label || input.key,
          category: 'input',
          categoryLabel: '场景输入',
          description: `场景输入 · ${input.label || input.key} (${input.key})`,
        })
      }
    }
  } else if ('inputs' in document && Array.isArray(document.inputs)) {
    for (const input of document.inputs) {
      if (input.key) {
        sources.push({
          key: input.key,
          label: input.label || input.key,
          category: 'input',
          categoryLabel: '场景输入',
          description: `场景输入 · ${input.label || input.key} (${input.key})`,
        })
      }
    }
  }

  // 2. 步骤产出与模块产出
  if (isAuthoringDocumentV2(document)) {
    let stepOrdinal = 1
    for (const item of walkAuthoringNodes(document)) {
      const node = item.node
      if (node.kind === 'step') {
        const currentOrdinal = stepOrdinal++
        if (node.step.outputKey) {
          sources.push({
            key: node.step.outputKey,
            label: node.step.name || `步骤 ${currentOrdinal}`,
            category: 'step',
            categoryLabel: `第 ${currentOrdinal} 步`,
            description: `第 ${currentOrdinal} 步 · ${node.step.name || '步骤'} (${node.step.outputKey})`,
            stepIndex: currentOrdinal - 1,
            stepName: node.step.name,
            nodeId: node.step.id,
          })
        }
      } else if (node.kind === 'module') {
        if (node.outputBindings) {
          for (const [moduleOutKey, targetKey] of Object.entries(node.outputBindings)) {
            if (targetKey) {
              sources.push({
                key: targetKey,
                label: `${node.name || '模块'}.${moduleOutKey}`,
                category: 'module',
                categoryLabel: `模块「${node.name || '模块'}」`,
                description: `模块「${node.name || '模块'}」· ${moduleOutKey} (${targetKey})`,
                nodeId: node.invocationId,
              })
            }
          }
        }
      }
    }
  } else if ('steps' in document && Array.isArray(document.steps)) {
    document.steps.forEach((step, idx) => {
      if (step.outputKey) {
        sources.push({
          key: step.outputKey,
          label: step.name || `步骤 ${idx + 1}`,
          category: 'step',
          categoryLabel: `第 ${idx + 1} 步`,
          description: `第 ${idx + 1} 步 · ${step.name || '步骤'} (${step.outputKey})`,
          stepIndex: idx,
          stepName: step.name,
          nodeId: step.id,
        })
      }
    })
  }

  return sources
}

export function removeAuthoringNode(
  document: ScenarioAuthoringDocumentV2,
  id: string
): ScenarioAuthoringDocumentV2 {
  return removeNode(document, id)
}

export function findInsertedModuleInvocationId(
  previous: ScenarioAuthoringDocumentV2 | undefined,
  next: ScenarioAuthoringDocumentV2
): string | undefined {
  const before = new Set(
    (previous ? walkAuthoringNodes(previous) : [])
      .filter(
        (item): item is typeof item & { node: ScenarioModuleInvocationNode } => item.node.kind === 'module'
      )
      .map((item) => item.node.invocationId)
  )
  return walkAuthoringNodes(next).find(
    (item): item is typeof item & { node: ScenarioModuleInvocationNode } =>
      item.node.kind === 'module' && !before.has(item.node.invocationId)
  )?.node.invocationId
}

export function insertNode(
  document: ScenarioAuthoringDocumentV2,
  node: ScenarioAuthoringNode,
  afterIndex: number
): ScenarioAuthoringDocumentV2 {
  const items = walkAuthoringNodes(document)
  if (afterIndex < 0 || afterIndex >= items.length) {
    const lastId = items.length > 0 ? items[items.length - 1]!.id : null
    return insertNodeAfter(document, lastId, node)
  }
  return insertNodeAfter(document, items[afterIndex]!.id, node)
}

export function moveNode(
  document: ScenarioAuthoringDocumentV2,
  index: number,
  delta: number
): ScenarioAuthoringDocumentV2 | null {
  const items = walkAuthoringNodes(document)
  const item = items[index]
  if (!item) return null
  const nextDoc = moveNodeWithin(document, item.id, delta)
  return nextDoc === document ? null : nextDoc
}

export function tryReplaceNode(
  document: ScenarioAuthoringDocumentV2,
  next: ScenarioAuthoringNode
): { ok: true; document: ScenarioAuthoringDocumentV2 } | { ok: false } {
  const targetId = nodeId(next)
  const candidate = replaceNode(document, targetId, next)
  const parsed = scenarioAuthoringDocumentV2Schema.safeParse(candidate)
  return parsed.success ? { ok: true, document: parsed.data } : { ok: false }
}

export function priorOutputShapesAny(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2,
  nodeIndex: number
): Map<string, OutputShape> {
  if (!isAuthoringDocumentV2(document))
    return priorOutputShapes(document, nodeIndex)
  const shapes = new Map<string, OutputShape>()
  const items = walkAuthoringNodes(document)
  for (let i = 0; i < Math.min(items.length, Math.max(0, nodeIndex)); i++) {
    const node = items[i]!.node
    if (node.kind === 'step' && node.step.outputKey) {
      shapes.set(node.step.outputKey, outputShapeForStep(node.step))
    }
  }
  return shapes
}

export function authoringNodeLabel(node: ScenarioAuthoringNode): string {
  if (node.kind === 'module') return node.name || '动作模块'
  if (node.kind === 'block') return node.name || (node.control.type === 'if' ? '条件分支' : '流程控制')
  return node.step.name
}

export function bindingUiKind(
  binding: ModuleInputBinding | undefined,
  scenarioInputKeys: readonly string[]
): 'literal' | 'input' | 'step' {
  if (!binding || binding.kind === 'literal') return 'literal'
  return scenarioInputKeys.includes(binding.key) ? 'input' : 'step'
}

export function priorBindingsV2(
  document: ScenarioAuthoringDocumentV2,
  nodeIndex: number
): BindingOption[] {
  const items = walkAuthoringNodes(document)
  const prior = items.slice(0, Math.max(0, nodeIndex)).map((item) => item.node)
  const options: BindingOption[] = document.inputs.map((input) => ({
    key: input.key,
    label: `输入 · ${input.label}`,
    typeLabel: input.type ?? '未声明类型',
    description: input.description ?? '场景运行输入',
  }))
  for (const node of prior) {
    if (node.kind === 'step') {
      if (node.step.outputKey) {
        options.push({
          key: node.step.outputKey,
          label: `步骤 · ${node.step.name}`,
          typeLabel: outputShapeForStep(node.step).kind,
          description: `前序步骤「${node.step.name}」的输出`,
        })
      }
    } else if (node.kind === 'module') {
      if (node.outputBindings) {
        for (const exposedKey of Object.values(node.outputBindings)) {
          if (exposedKey) {
            options.push({
              key: exposedKey,
              label: `模块 · ${node.name || node.moduleId} · ${exposedKey}`,
              typeLabel: '模块输出',
              description: `前序模块「${node.name || node.moduleId}」对外暴露的输出`,
            })
          }
        }
      }
    }
  }
  return options
}

export function outputConsumersAny(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2 | null | undefined,
  outputKey: string | undefined
): { id: string; name: string }[] {
  if (!document || !outputKey) return []
  const nodes = authoringNodes(document)
  const consumers: { id: string; name: string }[] = []
  for (const node of nodes) {
    if (node.kind === 'step') {
      const s = node.step
      if ((s.type === 'echo' || s.type === 'fill' || s.type === 'select') && s.input.from === outputKey) {
        consumers.push({ id: s.id, name: s.name })
      } else if (s.fieldRefs && Object.values(s.fieldRefs).some((ref) => ref?.from === outputKey)) {
        consumers.push({ id: s.id, name: s.name })
      }
    } else if (node.kind === 'module') {
      if (node.inputBindings && Object.values(node.inputBindings).some((b) => b?.kind === 'from' && b?.key === outputKey)) {
        consumers.push({ id: node.invocationId, name: node.name || '动作模块' })
      }
    }
  }
  return consumers
}

/** 步骤的元素定位目标：定位目标放在 step.input.target 上，没有则返回 undefined。 */
export function stepTargetDescriptor(step: Step | null | undefined): TargetDescriptor | undefined {
  if (!step || !('input' in step) || !step.input || typeof step.input !== 'object' || !('target' in step.input)) {
    return undefined
  }
  const target = step.input.target
  return target && typeof target === 'object' && 'candidates' in target ? (target as TargetDescriptor) : undefined
}

/** 把修复候选置顶到步骤的定位候选里（同档同值去重，保留上限）；步骤没有元素目标时返回 null。 */
export function withPromotedCandidate(step: Step, candidate: LocatorCandidate): Step | null {
  const target = stepTargetDescriptor(step)
  if (!target) return null
  const candidates = [
    candidate,
    ...target.candidates.filter((c) => !(c.by === candidate.by && c.value === candidate.value)),
  ].slice(0, MAX_LOCATOR_CANDIDATES)
  const input = (step as Step & { input: Record<string, unknown> }).input
  return { ...step, input: { ...input, target: { ...target, candidates } } } as Step
}
