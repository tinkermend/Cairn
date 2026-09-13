import {
  outputShapeForStep,
  scenarioDocumentSchema,
  stepSchema,
  type CompileDiagnostic,
  type OutputShape,
  type ScenarioDocument,
  type ScenarioInputDecl,
  type Step,
} from '@cairn/shared'

export function sameDocument(left: ScenarioDocument, right: ScenarioDocument): boolean {
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
  if (step.type === 'echo' || step.type === 'fill') return step.input.from
  return undefined
}

export function outputConsumers(document: ScenarioDocument, outputKey: string | undefined): { id: string; name: string }[] {
  if (!outputKey) return []
  return document.steps.filter((step) => {
    if (step.type !== 'echo' && step.type !== 'fill') return false
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
  document: ScenarioDocument,
  inputs: ScenarioInputDecl[],
): { ok: true; document: ScenarioDocument } | { ok: false } {
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
