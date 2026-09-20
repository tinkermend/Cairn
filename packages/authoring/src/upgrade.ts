import {
  authoringModuleInvocationSchema,
  canonicalJson,
  moduleContentSchema,
  moduleExtractProposalSchema,
  replaceStepCompareSchema,
  scenarioAuthoringDocumentV2Schema,
  upgradeDiffSchema,
  upgradeModuleVersionSchema,
  upgradeWarningKey,
  type AuthoringModuleInvocation,
  type AuthoringNode,
  type EffectType,
  type JsonValue,
  type ModuleContent,
  type ModuleContract,
  type ModuleExtractParameter,
  type ModuleExtractProposal,
  type ModuleInputBinding,
  type ModuleInputDecl,
  type ModuleOutputDecl,
  type ModuleValueType,
  type OutputShape,
  type ReplaceStepCompare,
  type ScenarioAuthoringDocumentV2,
  type Step,
  type UpgradeDiff,
  type UpgradeImplementationChange,
  type UpgradeModuleVersion,
} from '@cairn/shared'

const EFFECT_LEVEL: Record<EffectType, number> = {
  READ_ONLY: 0,
  IDEMPOTENT: 1,
  SIDE_EFFECT: 2,
}

function contractOf(version: UpgradeModuleVersion): ModuleContract {
  return version.content.contract
}

function implementationSteps(version: UpgradeModuleVersion): Step[] {
  return version.content.implementations[0]?.steps ?? []
}

function summarizeImplementation(from: UpgradeModuleVersion, to: UpgradeModuleVersion): UpgradeImplementationChange {
  const fromSteps = implementationSteps(from)
  const toSteps = implementationSteps(to)
  const fromById = new Map(fromSteps.map((step) => [step.id, step]))
  const toById = new Map(toSteps.map((step) => [step.id, step]))
  const added: string[] = []
  const removed: string[] = []
  const changed: string[] = []
  for (const step of toSteps) {
    const prev = fromById.get(step.id)
    if (!prev) added.push(step.name)
    else if (
      prev.type !== step.type ||
      prev.name !== step.name ||
      prev.effectType !== step.effectType ||
      canonicalJson(prev.input) !== canonicalJson(step.input)
    ) {
      changed.push(step.name)
    }
  }
  for (const step of fromSteps) {
    if (!toById.has(step.id)) removed.push(step.name)
  }
  return { added, removed, changed }
}

function invocationIndex(document: ScenarioAuthoringDocumentV2, invocationId: string): number {
  return document.nodes.findIndex((node) => node.kind === 'module' && node.invocationId === invocationId)
}

type ContextRef = { nodeId: string; name: string; field?: string }

function nodeDisplayName(node: AuthoringNode): string {
  return node.kind === 'module' ? node.name || '动作模块' : node.step.name
}

function laterReferences(
  document: ScenarioAuthoringDocumentV2,
  afterIndex: number,
  key: string,
): ContextRef[] {
  const refs: ContextRef[] = []
  for (let index = afterIndex + 1; index < document.nodes.length; index++) {
    const node = document.nodes[index]!
    if (node.kind === 'step') {
      const from = stepFrom(node.step)
      if (from?.key === key) {
        refs.push({ nodeId: node.step.id, name: node.step.name, field: from.field })
      }
    } else {
      for (const [inputKey, binding] of Object.entries(node.inputBindings)) {
        if (binding.kind === 'from' && binding.key === key) {
          refs.push({
            nodeId: node.invocationId,
            name: `${nodeDisplayName(node)}/${inputKey}`,
            field: binding.field,
          })
        }
      }
    }
  }
  return refs
}

function stepFrom(step: Step): { key: string; field?: string } | undefined {
  const binding = stepBinding(step)
  return binding?.from ? { key: binding.from, field: binding.fromField } : undefined
}

function stepLiteralValue(step: Step): JsonValue | undefined {
  const binding = stepBinding(step)
  return binding?.from === undefined ? binding?.value : undefined
}

function stepBinding(step: Step): { from?: string; fromField?: string; value?: JsonValue } | undefined {
  if (step.type === 'echo' || step.type === 'fill' || step.type === 'select') return step.input
  if (step.type === 'ai_action' && 'operation' in step.input && step.input.operation === 'input') return step.input
  return undefined
}

function outputShapeHasField(shape: ModuleOutputDecl['shape'] | OutputShape, field: string): boolean | 'unknown' {
  if (shape.kind === 'unknown') return 'unknown'
  if (shape.kind === 'scalar') return false
  return shape.fields.some((item) => item.name === field)
}

function bindingTypeOk(binding: ModuleInputBinding, valueType: ModuleValueType): boolean {
  if (binding.kind === 'from') return true
  if (valueType === 'string') return typeof binding.value === 'string'
  if (valueType === 'number') return typeof binding.value === 'number' && Number.isFinite(binding.value)
  if (valueType === 'boolean') return typeof binding.value === 'boolean'
  return binding.value !== undefined
}

export function diffModuleVersions(input: {
  from: UpgradeModuleVersion
  to: UpgradeModuleVersion
  document: ScenarioAuthoringDocumentV2
  invocation: AuthoringModuleInvocation
}): UpgradeDiff[] {
  const from = upgradeModuleVersionSchema.parse(input.from)
  const to = upgradeModuleVersionSchema.parse(input.to)
  const document = scenarioAuthoringDocumentV2Schema.parse(input.document)
  const invocation = authoringModuleInvocationSchema.parse(input.invocation)
  const diffs: UpgradeDiff[] = []
  const add = (diff: UpgradeDiff) => diffs.push(upgradeDiffSchema.parse(diff))

  if (to.publicationStatus === 'withdrawn') {
    add({
      code: 'MODULE_UPGRADE_WITHDRAWN',
      severity: 'blocking',
      message: `目标版本 v${to.versionNo} 已撤回，不能作为升级目标`,
    })
    return diffs
  }
  if (to.publicationStatus === 'deprecated') {
    add({
      code: 'MODULE_UPGRADE_DEPRECATED',
      severity: 'warning',
      message: `目标版本 v${to.versionNo} 已弃用，升级需确认`,
    })
  }

  const fromContract = contractOf(from)
  const toContract = contractOf(to)
  const nodeIndex = invocationIndex(document, invocation.invocationId)
  const fromInputs = new Map(fromContract.inputs.map((item) => [item.key, item]))
  const toInputs = new Map(toContract.inputs.map((item) => [item.key, item]))
  const fromOutputs = new Map(fromContract.outputs.map((item) => [item.key, item]))
  const toOutputs = new Map(toContract.outputs.map((item) => [item.key, item]))

  if (from.contractDigest === to.contractDigest && from.implementationDigest !== to.implementationDigest) {
    add({
      code: 'MODULE_UPGRADE_IMPLEMENTATION_ONLY',
      severity: 'info',
      message: '契约未变，仅实现变化',
      implementationSummary: summarizeImplementation(from, to),
    })
  }

  for (const inputDecl of toContract.inputs) {
    const previous = fromInputs.get(inputDecl.key)
    if (!previous) {
      add({
        code: inputDecl.required ? 'MODULE_UPGRADE_INPUT_REQUIRED' : 'MODULE_UPGRADE_INPUT_OPTIONAL',
        severity: inputDecl.required ? 'blocking' : 'info',
        message: inputDecl.required
          ? `新增必填输入「${inputDecl.label}」(${inputDecl.key})，必须补绑定`
          : `新增可选输入「${inputDecl.label}」(${inputDecl.key})`,
        inputKey: inputDecl.key,
      })
      continue
    }
    if (previous.valueType !== inputDecl.valueType) {
      add({
        code: 'MODULE_UPGRADE_INPUT_TYPE',
        severity: 'blocking',
        message: `输入「${inputDecl.key}」类型由 ${previous.valueType} 变为 ${inputDecl.valueType}，必须重新绑定`,
        inputKey: inputDecl.key,
      })
    }
  }

  for (const inputDecl of fromContract.inputs) {
    if (!toInputs.has(inputDecl.key) && invocation.inputBindings[inputDecl.key]) {
      add({
        code: 'MODULE_UPGRADE_INPUT_REMOVED',
        severity: 'warning',
        message: `输入「${inputDecl.key}」已删除，现有绑定将被移除`,
        inputKey: inputDecl.key,
      })
    }
  }

  for (const outputDecl of fromContract.outputs) {
    const exposed = invocation.outputBindings[outputDecl.key]
    const next = toOutputs.get(outputDecl.key)
    if (!next) {
      const refs = exposed && nodeIndex >= 0 ? laterReferences(document, nodeIndex, exposed) : []
      if (refs.length > 0) {
        add({
          code: 'MODULE_UPGRADE_OUTPUT_REMOVED',
          severity: 'blocking',
          message: `输出「${outputDecl.key}」已删除或重命名，后续节点仍引用「${exposed}」`,
          outputKey: outputDecl.key,
          affectedNodeIds: refs.map((item) => item.nodeId),
        })
      } else if (exposed) {
        add({
          code: 'MODULE_UPGRADE_OUTPUT_UNUSED_REMOVED',
          severity: 'warning',
          message: `输出「${outputDecl.key}」已删除，暴露名「${exposed}」将被移除`,
          outputKey: outputDecl.key,
        })
      }
      continue
    }
    if (!exposed || nodeIndex < 0) continue
    const refs = laterReferences(document, nodeIndex, exposed).filter((item) => item.field)
    const missing = refs.filter((item) => item.field && outputShapeHasField(next.shape, item.field) === false)
    if (missing.length > 0) {
      add({
        code: 'MODULE_UPGRADE_OUTPUT_FIELD_MISSING',
        severity: 'blocking',
        message: `输出「${outputDecl.key}」形状变化后，后续 fromField 不再存在`,
        outputKey: outputDecl.key,
        affectedNodeIds: missing.map((item) => item.nodeId),
      })
    }
  }

  if (EFFECT_LEVEL[to.effectCeiling] > EFFECT_LEVEL[from.effectCeiling]) {
    add({
      code: 'MODULE_UPGRADE_EFFECT_CEILING_RAISED',
      severity: 'warning',
      message: `副作用上限由 ${from.effectCeiling} 升至 ${to.effectCeiling}，需确认`,
    })
  } else if (to.effectCeiling !== from.effectCeiling) {
    add({
      code: 'MODULE_UPGRADE_EFFECT_CEILING_LOWERED',
      severity: 'info',
      message: `副作用上限由 ${from.effectCeiling} 降至 ${to.effectCeiling}`,
    })
  }

  if (from.executionMode !== to.executionMode) {
    add({
      code: 'MODULE_UPGRADE_EXECUTION_MODE',
      severity: 'warning',
      message: `执行方式由 ${from.executionMode} 变为 ${to.executionMode}，需确认`,
    })
  }

  if (canonicalJson(conditionDigest(fromContract)) !== canonicalJson(conditionDigest(toContract))) {
    add({
      code: 'MODULE_UPGRADE_CONDITIONS',
      severity: 'info',
      message: '前置/后置条件或验证有变化',
    })
  }

  return diffs
}

function conditionDigest(contract: ModuleContract) {
  return {
    preconditions: contract.preconditions,
    postconditions: contract.postconditions,
    entryState: contract.entryState ?? null,
    exitState: contract.exitState ?? null,
  }
}

export function applyModuleUpgrade(input: {
  document: ScenarioAuthoringDocumentV2
  invocationId: string
  toVersionId: string
  toContract: ModuleContract
  bindingsPatch?: Record<string, ModuleInputBinding>
}): ScenarioAuthoringDocumentV2 {
  const document = scenarioAuthoringDocumentV2Schema.parse(input.document)
  const nodes = document.nodes.map((node) => {
    if (node.kind !== 'module' || node.invocationId !== input.invocationId) return node
    const inputBindings: Record<string, ModuleInputBinding> = {}
    for (const decl of input.toContract.inputs) {
      const patched = input.bindingsPatch?.[decl.key]
      const current = node.inputBindings[decl.key]
      if (patched) inputBindings[decl.key] = patched
      else if (current) inputBindings[decl.key] = current
    }
    const outputBindings: Record<string, string> = {}
    for (const decl of input.toContract.outputs) {
      const exposed = node.outputBindings[decl.key]
      if (exposed) outputBindings[decl.key] = exposed
    }
    return {
      ...node,
      moduleVersionId: input.toVersionId,
      moduleDraft: undefined,
      inputBindings,
      outputBindings,
    }
  })
  return scenarioAuthoringDocumentV2Schema.parse({ ...document, nodes })
}

export function unresolvedUpgradeBlockers(
  diffs: readonly UpgradeDiff[],
  invocation: AuthoringModuleInvocation,
  toContract: ModuleContract,
  bindingsPatch: Record<string, ModuleInputBinding> = {},
): UpgradeDiff[] {
  const toInputs = new Map(toContract.inputs.map((item) => [item.key, item]))
  return diffs.filter((diff) => {
    if (diff.severity !== 'blocking') return false
    if (diff.code === 'MODULE_UPGRADE_WITHDRAWN' || diff.code === 'MODULE_UPGRADE_OUTPUT_REMOVED' || diff.code === 'MODULE_UPGRADE_OUTPUT_FIELD_MISSING') {
      return true
    }
    if (diff.code === 'MODULE_UPGRADE_INPUT_REQUIRED' && diff.inputKey) {
      const decl = toInputs.get(diff.inputKey)
      const binding = bindingsPatch[diff.inputKey] ?? invocation.inputBindings[diff.inputKey]
      return !decl || !binding || !bindingTypeOk(binding, decl.valueType)
    }
    if (diff.code === 'MODULE_UPGRADE_INPUT_TYPE' && diff.inputKey) {
      const decl = toInputs.get(diff.inputKey)
      const binding = bindingsPatch[diff.inputKey]
      return !decl || !binding || !bindingTypeOk(binding, decl.valueType)
    }
    return true
  })
}

export function unconfirmedUpgradeWarnings(diffs: readonly UpgradeDiff[], confirmedWarnings: readonly string[]): UpgradeDiff[] {
  const confirmed = new Set(confirmedWarnings)
  return diffs.filter((diff) => diff.severity === 'warning' && !confirmed.has(upgradeWarningKey(diff)))
}

function selectionRange(document: ScenarioAuthoringDocumentV2, selectedStepIds: readonly string[]) {
  const wanted = new Set(selectedStepIds)
  const indexes: number[] = []
  for (const [index, node] of document.nodes.entries()) {
    if (node.kind === 'step' && wanted.has(node.step.id)) indexes.push(index)
    if (node.kind === 'module' && wanted.has(node.invocationId)) {
      return { error: '选择不能包含动作模块调用' }
    }
  }
  if (indexes.length === 0 || indexes.length !== wanted.size) {
    return { error: '必须选择已有的连续步骤' }
  }
  const start = indexes[0]!
  const end = indexes[indexes.length - 1]!
  if (end - start + 1 !== indexes.length) {
    return { error: '必须选择连续的步骤' }
  }
  for (let index = start; index <= end; index++) {
    if (document.nodes[index]?.kind !== 'step') {
      return { error: '选择区间不能包含动作模块调用' }
    }
  }
  return { start, end, nodes: document.nodes.slice(start, end + 1).filter((node): node is Extract<AuthoringNode, { kind: 'step' }> => node.kind === 'step') }
}

function shapeFromStep(step: Step): ModuleOutputDecl['shape'] {
  if (step.type === 'extract') {
    return { kind: 'scalar', type: 'string' }
  }
  if (step.type === 'ai_extract') {
    const schema = step.input.outputSchema
    if (schema?.kind === 'scalar') return { kind: 'scalar', type: schema.type }
    if (schema?.kind === 'object') {
      return {
        kind: 'object',
        fields: schema.fields.map((field) => ({
          name: field.name,
          type: field.type,
          required: field.required ?? false,
        })),
      }
    }
  }
  return { kind: 'unknown' }
}

function valueTypeFromShape(shape: ModuleOutputDecl['shape']): ModuleValueType {
  if (shape.kind === 'scalar') return shape.type === 'json' ? 'json' : shape.type
  return 'json'
}

function suggestParamKey(step: Step, used: Set<string>): string {
  const base = (step.outputKey || step.name.replace(/[^A-Za-z0-9_]/g, '') || 'param').replace(/^[^A-Za-z]+/, '') || 'param'
  const normalized = base.slice(0, 120)
  let key = /^[A-Za-z]/.test(normalized) ? normalized : `p_${normalized}`
  let suffix = 2
  while (used.has(key)) {
    key = `${normalized.slice(0, 120)}${suffix}`
    suffix += 1
  }
  return key
}

export function proposeModuleFromSteps(
  document: ScenarioAuthoringDocumentV2,
  selectedStepIds: readonly string[],
): ModuleExtractProposal {
  const parsed = scenarioAuthoringDocumentV2Schema.safeParse(document)
  if (!parsed.success) {
    return moduleExtractProposalSchema.parse({
      ok: false,
      error: { code: 'MODULE_EXTRACT_SELECTION_INVALID', message: '编写文档无效' },
    })
  }
  const range = selectionRange(parsed.data, selectedStepIds)
  if ('error' in range) {
    return moduleExtractProposalSchema.parse({
      ok: false,
      error: { code: 'MODULE_EXTRACT_SELECTION_INVALID', message: range.error },
    })
  }

  const selectedOutputKeys = new Set(range.nodes.map((node) => node.step.outputKey).filter((key): key is string => Boolean(key)))
  const scenarioInputs = new Map(parsed.data.inputs.map((item) => [item.key, item]))
  const priorOutputs = new Map<string, { label: string; shape: ModuleOutputDecl['shape'] }>()
  for (let index = 0; index < range.start; index++) {
    const node = parsed.data.nodes[index]!
    if (node.kind === 'step' && node.step.outputKey) {
      priorOutputs.set(node.step.outputKey, { label: node.step.name, shape: shapeFromStep(node.step) })
    }
    if (node.kind === 'module') {
      for (const exposed of Object.values(node.outputBindings)) {
        if (exposed) priorOutputs.set(exposed, { label: exposed, shape: { kind: 'unknown' } })
      }
    }
  }

  const inputMap = new Map<string, ModuleExtractProposal['inputs'][number]>()
  for (const node of range.nodes) {
    const from = stepFrom(node.step)
    if (!from) continue
    if (selectedOutputKeys.has(from.key)) continue
    if (inputMap.has(from.key)) continue
    const scenarioInput = scenarioInputs.get(from.key)
    const prior = priorOutputs.get(from.key)
    if (scenarioInput) {
      inputMap.set(from.key, {
        key: from.key,
        label: scenarioInput.label,
        valueType: 'string',
        required: true,
        source: 'scenario_input',
      })
    } else if (prior) {
      inputMap.set(from.key, {
        key: from.key,
        label: prior.label,
        valueType: valueTypeFromShape(prior.shape),
        required: true,
        source: 'prior_output',
      })
    } else {
      inputMap.set(from.key, {
        key: from.key,
        label: from.key,
        valueType: 'string',
        required: true,
        source: 'prior_output',
      })
    }
  }

  const outputs: ModuleExtractProposal['outputs'] = []
  for (const node of range.nodes) {
    const key = node.step.outputKey
    if (!key) continue
    if (laterReferences(parsed.data, range.end, key).length === 0) continue
    outputs.push({
      key,
      label: node.step.name,
      shape: shapeFromStep(node.step),
      internalOutputKey: key,
    })
  }

  const usedKeys = new Set([...inputMap.keys(), ...outputs.map((item) => item.key)])
  const parameterizable: ModuleExtractProposal['parameterizable'] = []
  for (const node of range.nodes) {
    const value = stepLiteralValue(node.step)
    if (value === undefined) continue
    const suggestedKey = suggestParamKey(node.step, usedKeys)
    usedKeys.add(suggestedKey)
    parameterizable.push({
      stepId: node.step.id,
      stepName: node.step.name,
      value,
      suggestedKey,
      suggestedLabel: node.step.name,
    })
  }

  const effectCeiling = range.nodes.reduce<EffectType>((ceiling, node) => {
    return EFFECT_LEVEL[node.step.effectType] > EFFECT_LEVEL[ceiling] ? node.step.effectType : ceiling
  }, 'READ_ONLY')

  const postconditionCandidates = range.nodes
    .filter((node) => node.step.type === 'assert' || node.step.type === 'ai_assert')
    .map((node) => ({
      stepId: node.step.id,
      name: node.step.name,
      meaning: node.step.name,
    }))

  return moduleExtractProposalSchema.parse({
    ok: true,
    stepIds: range.nodes.map((node) => node.step.id),
    inputs: [...inputMap.values()],
    outputs,
    effectCeiling,
    postconditionCandidates,
    parameterizable,
  })
}

function rewriteStepLiteralToFrom(step: Step, key: string): Step {
  if (step.type !== 'echo' && step.type !== 'fill' && step.type !== 'select') return step
  const { value: _value, ...rest } = step.input
  return { ...step, input: { ...rest, from: key } } as Step
}

export function buildExtractedModuleContent(input: {
  document: ScenarioAuthoringDocumentV2
  selectedStepIds: readonly string[]
  parameterized?: readonly ModuleExtractParameter[]
  confirmedPostconditionStepIds?: readonly string[]
  sourceNote?: string
}): { ok: true; content: ModuleContent; proposal: ModuleExtractProposal } | { ok: false; proposal: ModuleExtractProposal } {
  const proposal = proposeModuleFromSteps(input.document, input.selectedStepIds)
  if (!proposal.ok) return { ok: false, proposal }
  const range = selectionRange(input.document, proposal.stepIds)
  if ('error' in range) {
    return {
      ok: false,
      proposal: moduleExtractProposalSchema.parse({
        ok: false,
        error: { code: 'MODULE_EXTRACT_SELECTION_INVALID', message: range.error },
      }),
    }
  }

  const parameterized = new Map((input.parameterized ?? []).map((item) => [item.stepId, item]))
  const inputs: ModuleInputDecl[] = [
    ...proposal.inputs.map((item) => ({
      key: item.key,
      label: item.label,
      valueType: item.valueType,
      required: item.required,
    })),
  ]
  const used = new Set(inputs.map((item) => item.key))
  const steps = range.nodes.map((node) => {
    const param = parameterized.get(node.step.id)
    if (!param) return structuredClone(node.step)
    if (!used.has(param.key)) {
      inputs.push({
        key: param.key,
        label: param.label,
        valueType: typeof stepLiteralValue(node.step) === 'number'
          ? 'number'
          : typeof stepLiteralValue(node.step) === 'boolean'
            ? 'boolean'
            : 'string',
        required: true,
      })
      used.add(param.key)
    }
    return rewriteStepLiteralToFrom(structuredClone(node.step), param.key)
  })

  const confirmed = new Set(input.confirmedPostconditionStepIds ?? [])
  const postconditions = [
    ...proposal.outputs.map((item) => ({
      meaning: `输出「${item.label}」必须存在`,
      verification: { kind: 'output_required' as const, outputKey: item.key },
    })),
    ...proposal.postconditionCandidates
      .filter((item) => confirmed.has(item.stepId))
      .map((item) => ({
        meaning: item.meaning,
        verification: { kind: 'step' as const, stepId: item.stepId },
      })),
  ]

  const content = moduleContentSchema.parse({
    contract: {
      inputs,
      outputs: proposal.outputs.map((item) => ({
        key: item.key,
        label: item.label,
        shape: item.shape,
      })),
      effectCeiling: proposal.effectCeiling,
      preconditions: [],
      postconditions,
    },
    implementations: [
      {
        implementationKey: 'default',
        kind: 'structured_steps',
        steps,
        outputMapping: Object.fromEntries(proposal.outputs.map((item) => [item.key, item.internalOutputKey])),
      },
    ],
  })
  return { ok: true, content, proposal }
}

export function buildReplaceInvocation(input: {
  document: ScenarioAuthoringDocumentV2
  selectedStepIds: readonly string[]
  moduleId: string
  moduleVersionId: string
  invocationId: string
  name: string
  parameterized?: readonly ModuleExtractParameter[]
}): AuthoringModuleInvocation {
  const proposal = proposeModuleFromSteps(input.document, input.selectedStepIds)
  if (!proposal.ok) {
    throw new Error(proposal.error?.message ?? '提炼选择无效')
  }
  const inputBindings: Record<string, ModuleInputBinding> = {}
  for (const item of proposal.inputs) {
    inputBindings[item.key] = { kind: 'from', key: item.key }
  }
  const range = selectionRange(input.document, proposal.stepIds)
  if ('error' in range) throw new Error(range.error)
  for (const param of input.parameterized ?? []) {
    const node = range.nodes.find((item) => item.step.id === param.stepId)
    const value = node ? stepLiteralValue(node.step) : undefined
    if (value !== undefined) inputBindings[param.key] = { kind: 'literal', value }
  }
  const outputBindings: Record<string, string> = {}
  for (const item of proposal.outputs) {
    outputBindings[item.key] = item.key
  }
  return authoringModuleInvocationSchema.parse({
    kind: 'module',
    invocationId: input.invocationId,
    name: input.name,
    moduleId: input.moduleId,
    moduleVersionId: input.moduleVersionId,
    implementationKey: 'default',
    inputBindings,
    outputBindings,
  })
}

export function applyModuleReplace(input: {
  document: ScenarioAuthoringDocumentV2
  selectedStepIds: readonly string[]
  invocation: AuthoringModuleInvocation
}): ScenarioAuthoringDocumentV2 {
  const document = scenarioAuthoringDocumentV2Schema.parse(input.document)
  const range = selectionRange(document, input.selectedStepIds)
  if ('error' in range) {
    throw new Error(range.error)
  }
  const nodes = [
    ...document.nodes.slice(0, range.start),
    authoringModuleInvocationSchema.parse(input.invocation),
    ...document.nodes.slice(range.end + 1),
  ]
  return scenarioAuthoringDocumentV2Schema.parse({ ...document, nodes })
}

function inputSummary(step: Step): string {
  return canonicalJson(step.input)
}

export function compareReplaceSteps(original: readonly Step[], expanded: readonly Step[], exposedKeys: ReadonlySet<string>): ReplaceStepCompare[] {
  const count = Math.max(original.length, expanded.length)
  const rows: ReplaceStepCompare[] = []
  for (let index = 0; index < count; index++) {
    const left = original[index]
    const right = expanded[index]
    const differences: string[] = []
    if (!left) differences.push('原步骤缺失')
    if (!right) differences.push('展开步骤缺失')
    if (left && right) {
      if (left.type !== right.type) differences.push('类型不同')
      if (left.name !== right.name) differences.push('名称不同')
      if (left.effectType !== right.effectType) differences.push('副作用不同')
      if (inputSummary(left) !== inputSummary(right)) differences.push('输入不同')
      if (left.outputKey && exposedKeys.has(left.outputKey) && left.outputKey !== right.outputKey) {
        differences.push('对外输出键不同')
      }
    }
    rows.push(
      replaceStepCompareSchema.parse({
        index,
        original: left
          ? {
              type: left.type,
              name: left.name,
              effectType: left.effectType,
              outputKey: left.outputKey,
              inputSummary: inputSummary(left),
            }
          : { type: '', name: '', effectType: 'READ_ONLY', inputSummary: '' },
        expanded: right
          ? {
              type: right.type,
              name: right.name,
              effectType: right.effectType,
              outputKey: right.outputKey,
              inputSummary: inputSummary(right),
            }
          : undefined,
        equal: differences.length === 0,
        differences,
      }),
    )
  }
  return rows
}
