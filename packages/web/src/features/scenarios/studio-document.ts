import {
  hasAiSteps,
  outputShapeForStep,
  scenarioDocumentSchema,
  scenarioAuthoringDocumentV2Schema,
  isAuthoringDocumentV2,
  toAuthoringDocumentV2,
  stepSchema,
  stepUsesBrowser,
  type CompileDiagnostic,
  type ModuleInputBinding,
  type OutputShape,
  type ScenarioDocument,
  type ScenarioAuthoringDocumentV2,
  type ScenarioAuthoringNode,
  type ScenarioStepNode,
  type ScenarioModuleInvocationNode,
  type ScenarioInputDecl,
  type Step,
} from '@cairn/shared'

export { isAuthoringDocumentV2, toAuthoringDocumentV2 }
export type { ScenarioAuthoringDocumentV2, ScenarioAuthoringNode, ScenarioStepNode, ScenarioModuleInvocationNode }

export function sameDocument(
  left: ScenarioDocument | ScenarioAuthoringDocumentV2,
  right: ScenarioDocument | ScenarioAuthoringDocumentV2,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function usedContextKeys(values: Iterable<string>): Set<string> {
  return new Set([...values].filter(Boolean))
}

export function documentContextKeys(document: ScenarioDocument): Set<string> {
  return usedContextKeys([
    ...document.inputs.map((input) => input.key),
    ...document.steps.flatMap((step) => (step.outputKey ? [step.outputKey] : [])),
  ])
}

export function uniqueOutputKey(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  let index = 2
  while (used.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}

export type BindingOption = { key: string; label: string; stale?: boolean }

export function priorBindings(document: ScenarioDocument, stepIndex: number): BindingOption[] {
  const current = document.steps[stepIndex]
  const prior = document.steps.slice(0, Math.max(0, stepIndex))
  const options: BindingOption[] = document.inputs.map((input) => ({
    key: input.key,
    label: `输入 · ${input.label}`,
  }))
  for (const step of prior) {
    if (!step.outputKey) continue
    options.push({ key: step.outputKey, label: `步骤 · ${step.name}` })
  }
  const from = current ? stepBindingFrom(current) : undefined
  if (from && !options.some((item) => item.key === from)) {
    options.push({ key: from, label: `失效引用 · ${from}`, stale: true })
  }
  return options
}

export function priorOutputShapes(document: ScenarioDocument, stepIndex: number): Map<string, OutputShape> {
  const shapes = new Map<string, OutputShape>()
  for (const step of document.steps.slice(0, Math.max(0, stepIndex))) {
    if (step.outputKey) shapes.set(step.outputKey, outputShapeForStep(step))
  }
  return shapes
}

export function stepBindingFrom(step: Step): string | undefined {
  if (step.type === 'echo' || step.type === 'fill' || step.type === 'select') return step.input.from
  return undefined
}

export function outputConsumers(document: ScenarioDocument, outputKey: string | undefined): { id: string; name: string }[] {
  if (!outputKey) return []
  return document.steps.filter((step) => {
    if (step.type !== 'echo' && step.type !== 'fill' && step.type !== 'select') return false
    return step.input.from === outputKey
  }).map((step) => ({ id: step.id, name: step.name }))
}

export function tryReplaceStep(
  document: ScenarioDocument,
  next: Step,
): { ok: true; document: ScenarioDocument } | { ok: false } {
  if (!stepSchema.safeParse(next).success) return { ok: false }
  const candidate = {
    ...document,
    steps: document.steps.map((step) => (step.id === next.id ? next : step)),
  }
  const parsed = scenarioDocumentSchema.safeParse(candidate)
  return parsed.success ? { ok: true, document: parsed.data } : { ok: false }
}

export function tryReplaceInputs(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2,
  inputs: ScenarioInputDecl[],
): { ok: true; document: ScenarioDocument | ScenarioAuthoringDocumentV2 } | { ok: false } {
  if (isAuthoringDocumentV2(document)) {
    const parsed = scenarioAuthoringDocumentV2Schema.safeParse({ ...document, inputs })
    return parsed.success ? { ok: true, document: parsed.data } : { ok: false }
  }
  const parsed = scenarioDocumentSchema.safeParse({ ...document, inputs })
  return parsed.success ? { ok: true, document: parsed.data } : { ok: false }
}

export function fieldElementId(stepId: string, fieldPath?: readonly (string | number)[]): string {
  if (!fieldPath || fieldPath.length === 0) return `studio-step-diagnostics-${stepId}`
  return `studio-field-${stepId}-${fieldPath.join('-')}`
}

export function focusStudioField(diagnostic: Pick<CompileDiagnostic, 'stepId' | 'inputKey' | 'fieldPath'>): void {
  if (diagnostic.fieldPath && diagnostic.stepId) {
    document.getElementById(fieldElementId(diagnostic.stepId, diagnostic.fieldPath))?.focus()
    return
  }
  if (diagnostic.stepId) {
    document.getElementById(`studio-step-diagnostics-${diagnostic.stepId}`)?.focus()
    return
  }
  if (diagnostic.inputKey) {
    document.getElementById(`studio-input-${diagnostic.inputKey}`)?.focus()
  }
}

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]'),
  )
}

export function insertStep(document: ScenarioDocument, step: Step, afterIndex: number): ScenarioDocument {
  const steps = [...document.steps]
  const index = afterIndex < 0 ? steps.length : afterIndex + 1
  steps.splice(index, 0, step)
  return { ...document, steps }
}

export function moveStep(document: ScenarioDocument, index: number, delta: number): ScenarioDocument | null {
  const nextIndex = index + delta
  if (nextIndex < 0 || nextIndex >= document.steps.length) return null
  const steps = [...document.steps]
  const [item] = steps.splice(index, 1)
  if (!item) return null
  steps.splice(nextIndex, 0, item)
  return { ...document, steps }
}

export function nodeId(node: ScenarioAuthoringNode): string {
  return node.kind === 'step' ? node.step.id : node.invocationId
}

export function consecutiveExtractStepIds(
  document: ScenarioAuthoringDocumentV2,
  selectedIds: readonly string[],
): string[] {
  const wanted = new Set(selectedIds)
  if (wanted.size === 0) return []
  const indexes: number[] = []
  for (const [index, node] of document.nodes.entries()) {
    if (node.kind === 'module' && wanted.has(node.invocationId)) return []
    if (node.kind === 'step' && wanted.has(node.step.id)) indexes.push(index)
  }
  if (indexes.length === 0 || indexes.length !== wanted.size) return []
  const start = indexes[0]!
  const end = indexes[indexes.length - 1]!
  if (end - start + 1 !== indexes.length) return []
  for (let index = start; index <= end; index++) {
    if (document.nodes[index]?.kind !== 'step') return []
  }
  return document.nodes.slice(start, end + 1).flatMap((node) => (node.kind === 'step' ? [node.step.id] : []))
}

export function authoringNodes(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2,
): ScenarioAuthoringNode[] {
  if (isAuthoringDocumentV2(document)) return document.nodes
  return document.steps.map((step) => ({ kind: 'step' as const, step }))
}

export function firstAuthoringNodeId(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2,
): string | null {
  const first = authoringNodes(document)[0]
  return first ? nodeId(first) : null
}

export function documentNodeCount(document: ScenarioDocument | ScenarioAuthoringDocumentV2): number {
  return authoringNodes(document).length
}

export function documentHasAiSteps(document: ScenarioDocument | ScenarioAuthoringDocumentV2): boolean {
  return authoringNodes(document).some((node) => node.kind === 'step' && hasAiSteps([node.step]))
}

export function documentUsesBrowser(document: ScenarioDocument | ScenarioAuthoringDocumentV2): boolean {
  return authoringNodes(document).some(
    (node) => node.kind === 'module' || (node.kind === 'step' && stepUsesBrowser(node.step.type)),
  )
}

export function documentContextKeysAny(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2,
): Set<string> {
  if (isAuthoringDocumentV2(document)) {
    return usedContextKeys([
      ...document.inputs.map((input) => input.key),
      ...document.nodes.flatMap((node) => {
        if (node.kind === 'step' && node.step.outputKey) return [node.step.outputKey]
        if (node.kind === 'module') return Object.values(node.outputBindings).filter(Boolean)
        return []
      }),
    ])
  }
  return documentContextKeys(document)
}

export function removeAuthoringNode(
  document: ScenarioAuthoringDocumentV2,
  id: string,
): ScenarioAuthoringDocumentV2 {
  return { ...document, nodes: document.nodes.filter((node) => nodeId(node) !== id) }
}

export function findInsertedModuleInvocationId(
  previous: ScenarioAuthoringDocumentV2 | undefined,
  next: ScenarioAuthoringDocumentV2,
): string | undefined {
  const before = new Set(
    (previous?.nodes ?? [])
      .filter((node): node is ScenarioModuleInvocationNode => node.kind === 'module')
      .map((node) => node.invocationId),
  )
  return next.nodes.find((node): node is ScenarioModuleInvocationNode => node.kind === 'module' && !before.has(node.invocationId))?.invocationId
}

export function insertNode(
  document: ScenarioAuthoringDocumentV2,
  node: ScenarioAuthoringNode,
  afterIndex: number,
): ScenarioAuthoringDocumentV2 {
  const nodes = [...document.nodes]
  const index = afterIndex < 0 ? nodes.length : afterIndex + 1
  nodes.splice(index, 0, node)
  return { ...document, nodes }
}

export function moveNode(
  document: ScenarioAuthoringDocumentV2,
  index: number,
  delta: number,
): ScenarioAuthoringDocumentV2 | null {
  const nextIndex = index + delta
  if (nextIndex < 0 || nextIndex >= document.nodes.length) return null
  const nodes = [...document.nodes]
  const [item] = nodes.splice(index, 1)
  if (!item) return null
  nodes.splice(nextIndex, 0, item)
  return { ...document, nodes }
}

export function tryReplaceNode(
  document: ScenarioAuthoringDocumentV2,
  next: ScenarioAuthoringNode,
): { ok: true; document: ScenarioAuthoringDocumentV2 } | { ok: false } {
  const targetId = nodeId(next)
  const candidate = {
    ...document,
    nodes: document.nodes.map((n) => (nodeId(n) === targetId ? next : n)),
  }
  const parsed = scenarioAuthoringDocumentV2Schema.safeParse(candidate)
  return parsed.success ? { ok: true, document: parsed.data } : { ok: false }
}

export function priorOutputShapesAny(
  document: ScenarioDocument | ScenarioAuthoringDocumentV2,
  nodeIndex: number,
): Map<string, OutputShape> {
  if (!isAuthoringDocumentV2(document)) return priorOutputShapes(document, nodeIndex)
  const shapes = new Map<string, OutputShape>()
  for (const node of document.nodes.slice(0, Math.max(0, nodeIndex))) {
    if (node.kind === 'step' && node.step.outputKey) {
      shapes.set(node.step.outputKey, outputShapeForStep(node.step))
    }
  }
  return shapes
}

export function authoringNodeLabel(node: ScenarioAuthoringNode): string {
  return node.kind === 'module' ? node.name || '动作模块' : node.step.name
}

export function bindingUiKind(
  binding: ModuleInputBinding | undefined,
  scenarioInputKeys: readonly string[],
): 'literal' | 'input' | 'step' {
  if (!binding || binding.kind === 'literal') return 'literal'
  return scenarioInputKeys.includes(binding.key) ? 'input' : 'step'
}

export function priorBindingsV2(
  document: ScenarioAuthoringDocumentV2,
  nodeIndex: number,
): BindingOption[] {
  const prior = document.nodes.slice(0, Math.max(0, nodeIndex))
  const options: BindingOption[] = document.inputs.map((input) => ({
    key: input.key,
    label: `输入 · ${input.label}`,
  }))
  for (const node of prior) {
    if (node.kind === 'step') {
      if (node.step.outputKey) {
        options.push({ key: node.step.outputKey, label: `步骤 · ${node.step.name}` })
      }
    } else if (node.kind === 'module') {
      for (const exposedKey of Object.values(node.outputBindings)) {
        if (exposedKey) {
          options.push({
            key: exposedKey,
            label: `模块 · ${node.name || node.moduleId} · ${exposedKey}`,
          })
        }
      }
    }
  }
  return options
}
