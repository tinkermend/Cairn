/**
 * AM-C：模块升级差异、预览、提炼与替换。
 * 唯一所有者：AM-C。消费方不得另建近似 DTO。
 */
import { z } from 'zod'
import {
  moduleContentSchema,
  moduleKeySchema,
  modulePublicationStatusSchema,
  moduleValueTypeSchema,
  type ModuleContent,
  type ModuleContract,
  type ModuleInputDecl,
  type ModuleOutputDecl,
  type ModulePublicationStatus,
  type ModuleValueType,
} from './action-module.js'
import { moduleExecutionModeSchema, type ModuleExecutionMode } from './action-module-vocabulary.js'
import {
  authoringModuleInvocationSchema,
  moduleInputBindingSchema,
  scenarioAuthoringDocumentV2Schema,
  type AuthoringModuleInvocation,
  type AuthoringNode,
  type ModuleInputBinding,
  type ScenarioAuthoringDocumentV2,
} from './authoring-document.js'
import { canonicalJson } from './canonical.js'
import type { OutputShape } from './output-schema.js'
import { compileDiagnosticSchema, type CompileDiagnostic } from './scenario.js'
import {
  contextKeySchema,
  effectTypeSchema,
  type EffectType,
  type Step,
} from './step.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema, type EntityId, type JsonValue } from './wire.js'

export const UPGRADE_DIFF_SEVERITIES = ['info', 'warning', 'blocking'] as const
export type UpgradeDiffSeverity = (typeof UPGRADE_DIFF_SEVERITIES)[number]
export const upgradeDiffSeveritySchema = z.enum(UPGRADE_DIFF_SEVERITIES)

export const UPGRADE_DIFF_CODES = [
  'MODULE_UPGRADE_IMPLEMENTATION_ONLY',
  'MODULE_UPGRADE_INPUT_REQUIRED',
  'MODULE_UPGRADE_INPUT_OPTIONAL',
  'MODULE_UPGRADE_INPUT_REMOVED',
  'MODULE_UPGRADE_INPUT_TYPE',
  'MODULE_UPGRADE_OUTPUT_REMOVED',
  'MODULE_UPGRADE_OUTPUT_FIELD_MISSING',
  'MODULE_UPGRADE_OUTPUT_UNUSED_REMOVED',
  'MODULE_UPGRADE_EFFECT_CEILING_RAISED',
  'MODULE_UPGRADE_EFFECT_CEILING_LOWERED',
  'MODULE_UPGRADE_EXECUTION_MODE',
  'MODULE_UPGRADE_CONDITIONS',
  'MODULE_UPGRADE_DEPRECATED',
  'MODULE_UPGRADE_WITHDRAWN',
] as const
export type UpgradeDiffCode = (typeof UPGRADE_DIFF_CODES)[number]
export const upgradeDiffCodeSchema = z.enum(UPGRADE_DIFF_CODES)

export const upgradeModuleVersionSchema = z.strictObject({
  versionId: entityIdSchema,
  moduleId: entityIdSchema,
  versionNo: z.number().int().min(1),
  publicationStatus: modulePublicationStatusSchema,
  contractDigest: z.string().min(1),
  implementationDigest: z.string().min(1),
  contentDigest: z.string().min(1),
  executionMode: moduleExecutionModeSchema,
  effectCeiling: effectTypeSchema,
  content: moduleContentSchema,
})
export type UpgradeModuleVersion = z.infer<typeof upgradeModuleVersionSchema>

export const upgradeImplementationChangeSchema = z.strictObject({
  added: z.array(z.string().min(1).max(128)).max(32),
  removed: z.array(z.string().min(1).max(128)).max(32),
  changed: z.array(z.string().min(1).max(128)).max(32),
})
export type UpgradeImplementationChange = z.infer<typeof upgradeImplementationChangeSchema>

export const upgradeDiffSchema = z.strictObject({
  code: upgradeDiffCodeSchema,
  severity: upgradeDiffSeveritySchema,
  message: z.string().min(1).max(512),
  inputKey: contextKeySchema.optional(),
  outputKey: contextKeySchema.optional(),
  affectedNodeIds: z.array(z.string().min(1).max(128)).max(64).optional(),
  implementationSummary: upgradeImplementationChangeSchema.optional(),
})
export type UpgradeDiff = z.infer<typeof upgradeDiffSchema>

const EFFECT_LEVEL: Record<EffectType, number> = {
  READ_ONLY: 0,
  IDEMPOTENT: 1,
  SIDE_EFFECT: 2,
}

export function upgradeWarningKey(diff: Pick<UpgradeDiff, 'code' | 'inputKey' | 'outputKey' | 'affectedNodeIds' | 'message'>): string {
  return JSON.stringify([
    diff.code,
    diff.inputKey ?? '',
    diff.outputKey ?? '',
    diff.affectedNodeIds ?? [],
    diff.message,
  ])
}

export function worstUpgradeSeverity(diffs: readonly UpgradeDiff[]): UpgradeDiffSeverity {
  if (diffs.some((item) => item.severity === 'blocking')) return 'blocking'
  if (diffs.some((item) => item.severity === 'warning')) return 'warning'
  return 'info'
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
  if (step.type !== 'echo' && step.type !== 'fill' && step.type !== 'select') return undefined
  if (!step.input.from) return undefined
  return { key: step.input.from, field: step.input.fromField }
}

function stepLiteralValue(step: Step): JsonValue | undefined {
  if (step.type !== 'echo' && step.type !== 'fill' && step.type !== 'select') return undefined
  if (step.input.from !== undefined) return undefined
  return step.input.value
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

export const moduleExtractParameterSchema = z.strictObject({
  stepId: entityIdSchema,
  key: contextKeySchema,
  label: z.string().trim().min(1).max(128),
})
export type ModuleExtractParameter = z.infer<typeof moduleExtractParameterSchema>

export const moduleExtractProposalSchema = z.strictObject({
  ok: z.boolean(),
  error: z
    .strictObject({
      code: z.literal('MODULE_EXTRACT_SELECTION_INVALID'),
      message: z.string().min(1).max(512),
    })
    .optional(),
  stepIds: z.array(entityIdSchema).max(32).default([]),
  inputs: z
    .array(
      z.strictObject({
        key: contextKeySchema,
        label: z.string().min(1).max(128),
        valueType: moduleValueTypeSchema,
        required: z.boolean(),
        source: z.enum(['scenario_input', 'prior_output']),
      }),
    )
    .max(32)
    .default([]),
  outputs: z
    .array(
      z.strictObject({
        key: contextKeySchema,
        label: z.string().min(1).max(128),
        shape: z.discriminatedUnion('kind', [
          z.strictObject({ kind: z.literal('unknown') }),
          z.strictObject({ kind: z.literal('scalar'), type: z.enum(['string', 'number', 'boolean', 'json']) }),
          z.strictObject({
            kind: z.literal('object'),
            fields: z.array(
              z.strictObject({
                name: z.string().min(1).max(64),
                type: z.enum(['string', 'number', 'boolean']),
                required: z.boolean(),
              }),
            ),
          }),
        ]),
        internalOutputKey: contextKeySchema,
      }),
    )
    .max(32)
    .default([]),
  effectCeiling: effectTypeSchema.default('READ_ONLY'),
  postconditionCandidates: z
    .array(
      z.strictObject({
        stepId: entityIdSchema,
        name: z.string().min(1).max(128),
        meaning: z.string().min(1).max(512),
      }),
    )
    .max(16)
    .default([]),
  parameterizable: z
    .array(
      z.strictObject({
        stepId: entityIdSchema,
        stepName: z.string().min(1).max(128),
        value: jsonValueSchema,
        suggestedKey: contextKeySchema,
        suggestedLabel: z.string().min(1).max(128),
      }),
    )
    .max(32)
    .default([]),
})
export type ModuleExtractProposal = z.infer<typeof moduleExtractProposalSchema>

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

export const replaceStepCompareSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  original: z.strictObject({
    type: z.string(),
    name: z.string(),
    effectType: effectTypeSchema,
    outputKey: z.string().optional(),
    inputSummary: z.string(),
  }),
  expanded: z
    .strictObject({
      type: z.string(),
      name: z.string(),
      effectType: effectTypeSchema,
      outputKey: z.string().optional(),
      inputSummary: z.string(),
    })
    .optional(),
  equal: z.boolean(),
  differences: z.array(z.string().min(1).max(256)).max(16),
})
export type ReplaceStepCompare = z.infer<typeof replaceStepCompareSchema>

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

export function latestSelectableVersion<T extends { versionNo: number; publicationStatus: ModulePublicationStatus }>(
  versions: readonly T[],
): T | undefined {
  return [...versions]
    .filter((item) => item.publicationStatus === 'published' || item.publicationStatus === 'deprecated')
    .sort((a, b) => b.versionNo - a.versionNo)[0]
}

export const moduleReferenceUseSchema = z.strictObject({
  invocationId: entityIdSchema,
  moduleVersionId: entityIdSchema.optional(),
  versionNo: z.number().int().min(1).optional(),
  moduleDraftRevision: z.number().int().nonnegative().optional(),
})
export type ModuleReferenceUse = z.infer<typeof moduleReferenceUseSchema>

export const moduleReferenceItemSchema = z.strictObject({
  scenarioId: entityIdSchema,
  name: z.string().min(1).max(128),
  status: z.enum(['active', 'disabled']),
  purpose: z.enum(['user', 'module_verification', 'map_job']),
  draftUses: z.array(moduleReferenceUseSchema).max(64),
  publishedUses: z.array(moduleReferenceUseSchema).max(64),
  lastRun: z
    .strictObject({
      id: entityIdSchema,
      status: z.string().min(1).max(64),
      createdAt: utcInstantSchema,
    })
    .nullable(),
  upgradeAvailable: z.boolean(),
})
export type ModuleReferenceItem = z.infer<typeof moduleReferenceItemSchema>

export const moduleReferenceListQuerySchema = z.object({
  versionId: entityIdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export type ModuleReferenceListQuery = z.infer<typeof moduleReferenceListQuerySchema>

export const moduleReferenceListResponseSchema = z.strictObject({
  items: z.array(moduleReferenceItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
})
export type ModuleReferenceListResponse = z.infer<typeof moduleReferenceListResponseSchema>

export const moduleUpgradePreviewBodySchema = z.strictObject({
  invocationId: entityIdSchema,
  toVersionId: entityIdSchema,
})
export type ModuleUpgradePreviewBody = z.infer<typeof moduleUpgradePreviewBodySchema>

export const moduleUpgradePreviewResponseSchema = z.strictObject({
  invocationId: entityIdSchema,
  fromVersionId: entityIdSchema.optional(),
  toVersionId: entityIdSchema,
  severity: upgradeDiffSeveritySchema,
  diffs: z.array(upgradeDiffSchema).max(256),
  document: scenarioAuthoringDocumentV2Schema,
  diagnostics: z.array(compileDiagnosticSchema).max(256),
})
export type ModuleUpgradePreviewResponse = z.infer<typeof moduleUpgradePreviewResponseSchema>

export const moduleUpgradeBodySchema = z.strictObject({
  invocationId: entityIdSchema,
  toVersionId: entityIdSchema,
  baseRevision: z.number().int().min(0),
  bindingsPatch: z.record(contextKeySchema, moduleInputBindingSchema).default({}),
  confirmedWarnings: z.array(z.string().min(1).max(2048)).max(256).default([]),
  idempotencyKey: z.string().min(1).max(128),
})
export type ModuleUpgradeBody = z.infer<typeof moduleUpgradeBodySchema>

export const moduleBatchUpgradeBodySchema = z.strictObject({
  toVersionId: entityIdSchema,
  scenarioIds: z.array(entityIdSchema).min(1).max(100),
  idempotencyKey: z.string().min(1).max(128),
})
export type ModuleBatchUpgradeBody = z.infer<typeof moduleBatchUpgradeBodySchema>

export const moduleBatchUpgradeRowSchema = z.strictObject({
  scenarioId: entityIdSchema,
  status: z.enum(['upgraded', 'skipped', 'conflict']),
  reason: z.string().min(1).max(512).optional(),
  code: z.string().min(1).max(64).optional(),
})
export type ModuleBatchUpgradeRow = z.infer<typeof moduleBatchUpgradeRowSchema>

export const moduleBatchUpgradeResponseSchema = z.strictObject({
  toVersionId: entityIdSchema,
  results: z.array(moduleBatchUpgradeRowSchema).max(100),
})
export type ModuleBatchUpgradeResponse = z.infer<typeof moduleBatchUpgradeResponseSchema>

export const modulePublicationBodySchema = z.strictObject({
  status: z.enum(['published', 'deprecated', 'withdrawn']),
  reason: z.string().trim().min(1).max(512),
})
export type ModulePublicationBody = z.infer<typeof modulePublicationBodySchema>

export const disableAffectedScenariosBodySchema = z.strictObject({
  versionId: entityIdSchema,
  scenarioIds: z.array(entityIdSchema).min(1).max(100),
  confirm: z.literal(true),
  reason: z.string().trim().min(1).max(512),
  idempotencyKey: z.string().min(1).max(128),
})
export type DisableAffectedScenariosBody = z.infer<typeof disableAffectedScenariosBodySchema>

export const disableAffectedScenariosResponseSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      scenarioId: entityIdSchema,
      status: z.enum(['disabled', 'skipped']),
      reason: z.string().min(1).max(512).optional(),
    }),
  ),
})
export type DisableAffectedScenariosResponse = z.infer<typeof disableAffectedScenariosResponseSchema>

export const moduleDeletePreviewResponseSchema = z.strictObject({
  draftReferences: z.array(moduleReferenceItemSchema).max(100),
  publishedReferences: z.array(moduleReferenceItemSchema).max(100),
  verificationScenarioId: entityIdSchema.nullable(),
  blockers: z.array(z.strictObject({ code: z.string(), id: z.string(), message: z.string() })).max(32),
})
export type ModuleDeletePreviewResponse = z.infer<typeof moduleDeletePreviewResponseSchema>

export const moduleExtractPreviewBodySchema = z.strictObject({
  stepIds: z.array(entityIdSchema).min(1).max(32),
})
export type ModuleExtractPreviewBody = z.infer<typeof moduleExtractPreviewBodySchema>

export const moduleExtractBodySchema = z.strictObject({
  stepIds: z.array(entityIdSchema).min(1).max(32),
  name: z.string().trim().min(1).max(128),
  key: moduleKeySchema,
  parameterized: z.array(moduleExtractParameterSchema).max(32).default([]),
  confirmedPostconditionStepIds: z.array(entityIdSchema).max(16).default([]),
  description: z.string().trim().max(2048).optional(),
  idempotencyKey: z.string().min(1).max(128),
})
export type ModuleExtractBody = z.infer<typeof moduleExtractBodySchema>

export const moduleReplacePreviewBodySchema = z.strictObject({
  stepIds: z.array(entityIdSchema).min(1).max(32),
  moduleVersionId: entityIdSchema,
})
export type ModuleReplacePreviewBody = z.infer<typeof moduleReplacePreviewBodySchema>

export const moduleReplacePreviewResponseSchema = z.strictObject({
  equal: z.boolean(),
  steps: z.array(replaceStepCompareSchema).max(32),
  invocation: authoringModuleInvocationSchema,
})
export type ModuleReplacePreviewResponse = z.infer<typeof moduleReplacePreviewResponseSchema>

export const moduleReplaceBodySchema = z.strictObject({
  stepIds: z.array(entityIdSchema).min(1).max(32),
  moduleVersionId: entityIdSchema,
  baseRevision: z.number().int().min(0),
  parameterized: z.array(moduleExtractParameterSchema).max(32).default([]),
  idempotencyKey: z.string().min(1).max(128),
})
export type ModuleReplaceBody = z.infer<typeof moduleReplaceBodySchema>

export function isSelectablePublication(status: ModulePublicationStatus): boolean {
  return status === 'published' || status === 'deprecated'
}

export function describeUpgradeSkip(code: string, message: string) {
  return { code, message }
}

export function sourceDescription(input: {
  scenarioName: string
  scenarioId: string
  draftRevision: number
  stepIds: readonly string[]
  extra?: string
}): string {
  const base = `提炼自场景「${input.scenarioName}」(${input.scenarioId}) 草稿 r${input.draftRevision}，步骤 ${input.stepIds.join(', ')}`
  return input.extra ? `${input.extra}\n${base}` : base
}

export type { CompileDiagnostic, EntityId, ModuleExecutionMode }
