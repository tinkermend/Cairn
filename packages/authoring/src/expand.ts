import {
  canonicalJson,
  deriveExecutionMode,
  findModuleImplementation,
  isAuthoringDocumentV2,
  MAX_SCENARIO_STEPS,
  normalizeAuthoringDocument,
  resolveInvocationSelection,
  scenarioDocumentSchema,
  syncSha256,
  type AuthoringModuleInvocation,
  type AuthoringNode,
  type CandidateGroup,
  type CompileContext,
  type CompileDiagnostic,
  type EffectType,
  type ModuleContent,
  type ModuleImplementation,
  type ModuleInputBinding,
  type ModuleManifest,
  type ModuleManifestEntry,
  type ModulePublicationStatus,
  type ModuleValueType,
  type OutcomeManifest,
  type OutcomeManifestEntry,
  type OutcomeRule,
  runtimeInvariantSchema,
  type RuntimeInvariantManifest,
  type ScenarioAuthoringDocument,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDefinition,
  type ScenarioInputDecl,
  type Step,
} from '@cairn/shared'
import { compileScenarioDocument } from './compiler.js'

// ---------------------------------------------------------------------------
// Context & Loaded Module interfaces
// ---------------------------------------------------------------------------

export type LoadedModuleVersion = {
  moduleId: string
  targetId: string
  moduleKey: string
  name: string
  versionId?: string
  versionNo?: number
  draftRevision?: number
  publicationStatus?: ModulePublicationStatus
  contentDigest: string
  contractDigest: string
  implementationDigest: string
  content: ModuleContent
}

export type ExpansionContext = {
  targetId: string
  mode: 'publish' | 'trial' | 'preview'
  loadedModules: Map<string, LoadedModuleVersion>
  compilerCtx?: Partial<CompileContext>
  fallbackEnabled?: boolean
}

export type ExpansionResult = {
  ok: boolean
  definition?: ScenarioDefinition
  manifest: ModuleManifest
  outcomeManifest?: OutcomeManifest
  runtimeInvariantManifest?: RuntimeInvariantManifest
  diagnostics: CompileDiagnostic[]
  sourceDigest: string
}

// ---------------------------------------------------------------------------
// Deterministic Step ID derivation
// ---------------------------------------------------------------------------

/**
 * 基于固定命名空间与 (invocationId, internalStepId) 计算确定性的 36 位 UUIDv4 格式字符串。
 * 跨环境、跨进程重复编译结果严格幂等。
 */
export function deterministicStepId(
  invocationId: string,
  internalStepId: string,
  implementationKey?: string,
): string {
  const hash = syncSha256(
    implementationKey
      ? `cairn:expand:${invocationId}:${implementationKey}:${internalStepId}`
      : `cairn:expand:${invocationId}:${internalStepId}`,
  )
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-')
}

/**
 * 从 Authoring Document 或 ScenarioDefinition 中提取/重构 OutcomeManifest。
 * 若提供 authoringDocument，则从其契约定义与存量断言中生成；
 * 若未提供 authoringDocument 但有 definition，则从 definition.steps 中按 legacy_assert 收编存量断言。
 */
export function deriveRuntimeInvariantManifest(
  authoringDocument?: ScenarioAuthoringDocumentV2 | null,
): RuntimeInvariantManifest | undefined {
  const entries = authoringDocument?.runtimeInvariants ?? []
  return entries.length > 0 ? { entries } : undefined
}

export function deriveOutcomeManifest(input: {
  definition?: ScenarioDefinition | null
  authoringDocument?: ScenarioAuthoringDocumentV2 | null
}): OutcomeManifest | undefined {
  const entries: OutcomeManifestEntry[] = []

  if (input.authoringDocument) {
    const doc = input.authoringDocument
    for (const node of doc.nodes) {
      if (node.kind === 'step') {
        const step = node.step
        if (node.outcomes && node.outcomes.length > 0) {
          for (const contract of node.outcomes) {
            if (step.type === 'assert' || step.type === 'ai_assert') {
              entries.push({
                contractId: contract.id,
                scope: contract.scope,
                meaning: contract.meaning,
                severity: contract.severity,
                onViolation: contract.onViolation,
                provenance: contract.provenance,
                stepId: step.id,
                rule: contract.rule,
              })
            } else {
              const derivedId = deterministicStepId(step.id, contract.id)
              entries.push({
                contractId: contract.id,
                scope: contract.scope,
                meaning: contract.meaning,
                severity: contract.severity,
                onViolation: contract.onViolation,
                provenance: contract.provenance,
                stepId: derivedId,
                sourceStepId: step.id,
                rule: contract.rule,
              })
            }
          }
        } else if (step.type === 'assert' || step.type === 'ai_assert') {
          const rule: OutcomeRule =
            step.type === 'assert'
              ? {
                  kind: 'deterministic',
                  ...((step.input as { target?: any; expect: any }).target
                    ? { target: (step.input as { target?: any; expect: any }).target }
                    : {}),
                  expect: (step.input as { target?: any; expect: any }).expect,
                }
              : {
                  kind: 'ai',
                  instruction: (step.input as { instruction: string }).instruction,
                }
          entries.push({
            contractId: step.id,
            scope: 'step',
            meaning: step.name,
            severity: 'MUST',
            onViolation: 'halt',
            provenance: 'legacy_assert',
            stepId: step.id,
            rule,
          })
        }
      }
    }

    if (doc.scenarioOutcomes && doc.scenarioOutcomes.length > 0) {
      for (const contract of doc.scenarioOutcomes) {
        const derivedId = deterministicStepId('scenario', contract.id)
        entries.push({
          contractId: contract.id,
          scope: contract.scope,
          meaning: contract.meaning,
          severity: contract.severity,
          onViolation: contract.onViolation,
          provenance: contract.provenance,
          stepId: derivedId,
          rule: contract.rule,
        })
      }
    }
  }

  if (input.definition) {
    const existingStepIds = new Set(entries.map((e) => e.stepId))
    for (const step of input.definition.steps) {
      if ((step.type === 'assert' || step.type === 'ai_assert') && !existingStepIds.has(step.id)) {
        const rule: OutcomeRule =
          step.type === 'assert'
            ? {
                kind: 'deterministic',
                ...((step.input as { target?: any; expect: any }).target
                  ? { target: (step.input as { target?: any; expect: any }).target }
                  : {}),
                expect: (step.input as { target?: any; expect: any }).expect,
              }
            : {
                kind: 'ai',
                instruction: (step.input as { instruction: string }).instruction,
              }
        entries.push({
          contractId: step.id,
          scope: 'step',
          meaning: step.name,
          severity: 'MUST',
          onViolation: 'halt',
          provenance: 'legacy_assert',
          stepId: step.id,
          rule,
        })
      }
    }
  }

  return entries.length > 0 ? { entries } : undefined
}

export function resolveOutcomeWriteback(
  manifest: OutcomeManifest | undefined,
  derivedStepId: string | undefined,
): { contractId: string; sourceStepId?: string; scope: OutcomeManifestEntry['scope'] } | undefined {
  if (!manifest || !derivedStepId) return undefined
  const entry = manifest.entries.find((item) => item.stepId === derivedStepId)
  if (!entry) return undefined
  return {
    contractId: entry.contractId,
    ...(entry.sourceStepId ? { sourceStepId: entry.sourceStepId } : {}),
    scope: entry.scope,
  }
}

// ---------------------------------------------------------------------------
// Type-check helper for literal values
// ---------------------------------------------------------------------------

function checkLiteralType(val: unknown, expectedType: ModuleValueType): boolean {
  if (expectedType === 'string') return typeof val === 'string'
  if (expectedType === 'number') return typeof val === 'number' && Number.isFinite(val)
  if (expectedType === 'boolean') return typeof val === 'boolean'
  if (expectedType === 'json') return val !== undefined
  return false
}

export function moduleContentDigest(content: ModuleContent): string {
  return syncSha256(canonicalJson(content))
}

function implementationHasNestedInvocation(content: ModuleContent): boolean {
  for (const impl of content.implementations) {
    const extra = impl as unknown as { nodes?: unknown[] }
    if (
      Array.isArray(extra.nodes) &&
      extra.nodes.some((node) => node && typeof node === 'object' && (node as { kind?: string }).kind === 'module')
    ) {
      return true
    }
    for (const step of impl.steps) {
      const raw = step as unknown as { kind?: string; type?: string }
      if (raw.kind === 'module' || raw.type === 'module' || raw.type === 'module_invocation') {
        return true
      }
    }
  }
  return false
}

function collectFromUsages(value: unknown, path: Array<string | number>, acc: Array<{ key: string; path: Array<string | number> }>) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFromUsages(item, [...path, index], acc))
    return
  }
  const record = value as Record<string, unknown>
  if (typeof record.from === 'string') {
    acc.push({ key: record.from, path: [...path, 'from'] })
  }
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'from') continue
    collectFromUsages(nested, [...path, key], acc)
  }
}

const BINDABLE_STEP_TYPES = new Set(['fill', 'echo', 'select'])

/** 未暴露的模块输出改写为调用命名空间形式，截断到 contextKey 上限并保持确定性。 */
function namespacedKey(ordinal: number, key: string, implementationKey?: string): string {
  return (implementationKey ? `m${ordinal}_${implementationKey}_${key}` : `m${ordinal}_${key}`).slice(0, 128)
}

export function singleImplementationDigest(implementation: ModuleImplementation): string {
  return syncSha256(canonicalJson(implementation))
}

/**
 * 诊断要回到 compileDiagnosticSchema 的边界内（message ≤ 512、fieldPath ≤ 8 段且每段 ≤ 64），
 * 否则 DTO 解析会在展示诊断之前先抛错，把可读的编译失败变成 500。
 */
function clampDiagnostic(diagnostic: CompileDiagnostic): CompileDiagnostic {
  const message =
    diagnostic.message.length > 512 ? `${diagnostic.message.slice(0, 509)}...` : diagnostic.message
  const fieldPath = diagnostic.fieldPath?.slice(0, 8).map((part) => part.slice(0, 64))
  return { ...diagnostic, message, ...(fieldPath ? { fieldPath } : {}) }
}

type ExpandedImplementation = {
  steps: Step[]
  internalToExpanded: Record<string, string>
  expandedStepIds: string[]
  preconditionStepIds: string[]
  postconditionStepIds: string[]
  outputRequired: string[]
  outputStaging: Record<string, string>
}

function expandImplementation(input: {
  impl: ModuleImplementation
  invocation: AuthoringModuleInvocation
  contract: LoadedModuleVersion['content']['contract']
  nodeIndex: number
  currentOrdinal: number
  idImplementationKey?: string
  exposeOutputs: boolean
  sceneOutputKeys: Set<string>
  availableContextKeys: Set<string>
  diagnostics: CompileDiagnostic[]
}): ExpandedImplementation {
  const { impl, invocation, contract, nodeIndex, currentOrdinal, idImplementationKey, exposeOutputs } = input
  const internalToExpanded: Record<string, string> = {}
  const outputRenames = new Map<string, string>()
  const outputStaging: Record<string, string> = {}

  for (const outDecl of contract.outputs) {
    const internalKey = impl.outputMapping[outDecl.key]
    const exposedKey = invocation.outputBindings[outDecl.key]
    const namespaced = namespacedKey(currentOrdinal, outDecl.key, idImplementationKey)
    const finalKey = exposeOutputs ? (exposedKey ?? namespaced) : namespaced
    if (exposedKey) {
      if (input.sceneOutputKeys.has(exposedKey) && exposeOutputs) {
        input.diagnostics.push({
          code: 'SCENARIO_OUTPUT_KEY_DUPLICATE',
          severity: 'error',
          message: `模块输出暴露名「${exposedKey}」与场景已有输出键冲突`,
          fieldPath: ['nodes', String(nodeIndex), 'outputBindings', outDecl.key],
        })
      }
      input.sceneOutputKeys.add(exposedKey)
    }
    input.availableContextKeys.add(finalKey)
    if (exposedKey) input.availableContextKeys.add(exposedKey)
    if (internalKey !== undefined && !outputRenames.has(internalKey)) {
      outputRenames.set(internalKey, finalKey)
    }
    outputStaging[exposedKey ?? namespacedKey(currentOrdinal, outDecl.key)] = namespaced
    if (exposeOutputs && internalKey !== undefined && !outputRenames.has(internalKey)) {
      outputRenames.set(internalKey, finalKey)
    }
  }

  for (const internalStep of impl.steps) {
    const derivedId = deterministicStepId(invocation.invocationId, internalStep.id, idImplementationKey)
    const mapKey = idImplementationKey ? `${idImplementationKey}:${internalStep.id}` : internalStep.id
    internalToExpanded[mapKey] = derivedId
    if (!idImplementationKey) internalToExpanded[internalStep.id] = derivedId
    if (internalStep.outputKey && !outputRenames.has(internalStep.outputKey)) {
      const privateKey = namespacedKey(currentOrdinal, internalStep.outputKey, idImplementationKey)
      outputRenames.set(internalStep.outputKey, privateKey)
      input.availableContextKeys.add(privateKey)
    }
  }

  const expandedSteps: Step[] = []
  const moduleExpandedStepIds: string[] = []
  for (let stepIndex = 0; stepIndex < impl.steps.length; stepIndex++) {
    const orig = impl.steps[stepIndex]!
    const derivedId = deterministicStepId(invocation.invocationId, orig.id, idImplementationKey)
    moduleExpandedStepIds.push(derivedId)
    const step: Step = JSON.parse(JSON.stringify(orig))
    step.id = derivedId
    if (step.outputKey && outputRenames.has(step.outputKey)) {
      step.outputKey = outputRenames.get(step.outputKey)
    }
    if (step.type === 'fill' || step.type === 'echo' || step.type === 'select') {
      const stepInput = step.input as { value?: unknown; from?: string; fromField?: string }
      if (stepInput.from) {
        const binding = invocation.inputBindings[stepInput.from]
        if (binding) {
          if (binding.kind === 'literal') {
            if (stepInput.fromField) {
              input.diagnostics.push({
                code: 'MODULE_BINDING_UNSUPPORTED',
                severity: 'error',
                message: `步骤「${step.name}」包含 fromField，不支持绑定字面量`,
                fieldPath: ['nodes', String(nodeIndex), 'inputBindings', stepInput.from],
              })
            }
            delete stepInput.from
            delete stepInput.fromField
            stepInput.value = binding.value
          } else if (binding.kind === 'from') {
            if (stepInput.fromField && binding.field) {
              input.diagnostics.push({
                code: 'MODULE_BINDING_UNSUPPORTED',
                severity: 'error',
                message: `内部步骤已有 fromField 且输入绑定也指定了 field，产生冲突`,
                fieldPath: ['nodes', String(nodeIndex), 'inputBindings', stepInput.from],
              })
            }
            stepInput.from = binding.key
            if (binding.field) stepInput.fromField = binding.field
          }
        } else if (outputRenames.has(stepInput.from)) {
          stepInput.from = outputRenames.get(stepInput.from)
        }
      }
    }
    expandedSteps.push(step)
  }

  const lookupExpanded = (internalStepId: string) =>
    internalToExpanded[idImplementationKey ? `${idImplementationKey}:${internalStepId}` : internalStepId]

  const preconditionStepIds: string[] = []
  const postconditionStepIds: string[] = []
  const outputRequired: string[] = []
  const preconditions = contract.preconditions ?? []
  const postconditions = contract.postconditions ?? []
  for (const [index, cond] of preconditions.entries()) {
    const verification = impl.preconditionBindings?.[index] ?? cond.verification
    if (verification.kind === 'step' && lookupExpanded(verification.stepId)) {
      preconditionStepIds.push(lookupExpanded(verification.stepId)!)
    }
  }
  for (const [index, cond] of postconditions.entries()) {
    const verification = impl.postconditionBindings?.[index] ?? cond.verification
    if (verification.kind === 'step' && lookupExpanded(verification.stepId)) {
      postconditionStepIds.push(lookupExpanded(verification.stepId)!)
    } else if (verification.kind === 'output_required') {
      outputRequired.push(verification.outputKey)
    }
  }

  return {
    steps: expandedSteps,
    internalToExpanded,
    expandedStepIds: moduleExpandedStepIds,
    preconditionStepIds,
    postconditionStepIds,
    outputRequired,
    outputStaging,
  }
}

// ---------------------------------------------------------------------------
// expandAuthoringDocument Pure Function
// ---------------------------------------------------------------------------

export function expandAuthoringDocument(
  rawDocument: unknown,
  ctx: ExpansionContext,
): ExpansionResult {
  let document: ScenarioAuthoringDocumentV2
  try {
    document = normalizeAuthoringDocument(rawDocument)
  } catch (err) {
    if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
      const issues = (err as { issues: Array<{ message: string; path: Array<string | number> }> }).issues
      return {
        ok: false,
        manifest: { entries: [] },
        diagnostics: issues.map((issue) =>
          clampDiagnostic({
            code: issue.path.includes('runtimeInvariants')
              ? 'RUNTIME_INVARIANT_INVALID'
              : 'OUTCOME_CONTRACT_INVALID',
            severity: 'error',
            message: issue.message,
            fieldPath: issue.path.map(String),
          }),
        ),
        sourceDigest: '',
      }
    }
    return {
      ok: false,
      manifest: { entries: [] },
      diagnostics: [
        clampDiagnostic({
          code: 'SCENARIO_AUTHORING_DOCUMENT_INVALID',
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
        }),
      ],
      sourceDigest: '',
    }
  }

  const diagnostics: CompileDiagnostic[] = []
  const manifestEntries: ModuleManifestEntry[] = []
  const outcomeManifestEntries: OutcomeManifestEntry[] = []
  const candidateGroups: CandidateGroup[] = []
  const expandedSteps: Step[] = []

  const availableContextKeys = new Set<string>(document.inputs.map((i) => i.key))
  const sceneOutputKeys = new Set<string>()
  const referencedContentDigests = new Set<string>()

  let invocationOrdinal = 0

  for (let nodeIndex = 0; nodeIndex < document.nodes.length; nodeIndex++) {
    const node = document.nodes[nodeIndex]!

    if (node.kind === 'step') {
      const step = node.step
      if (sceneOutputKeys.has(step.outputKey ?? '')) {
        diagnostics.push({
          code: 'SCENARIO_OUTPUT_KEY_DUPLICATE',
          severity: 'error',
          message: `场景输出键「${step.outputKey}」已被占用`,
          stepId: step.id,
          fieldPath: ['nodes', String(nodeIndex), 'step', 'outputKey'],
        })
      }
      if (step.outputKey) {
        sceneOutputKeys.add(step.outputKey)
        availableContextKeys.add(step.outputKey)
      }
      expandedSteps.push(step)

      if (node.outcomes && node.outcomes.length > 0) {
        for (const contract of node.outcomes) {
          if (step.type === 'assert' || step.type === 'ai_assert') {
            outcomeManifestEntries.push({
              contractId: contract.id,
              scope: contract.scope,
              meaning: contract.meaning,
              severity: contract.severity,
              onViolation: contract.onViolation,
              provenance: contract.provenance,
              stepId: step.id,
              rule: contract.rule,
            })
          } else {
            const derivedId = deterministicStepId(step.id, contract.id)
            const derivedStep: Step =
              contract.rule.kind === 'deterministic'
                ? {
                    id: derivedId,
                    name: contract.meaning.slice(0, 128),
                    type: 'assert',
                    effectType: 'READ_ONLY',
                    input: {
                      ...(contract.rule.target ? { target: contract.rule.target } : {}),
                      expect: contract.rule.expect,
                    },
                  }
                : {
                    id: derivedId,
                    name: contract.meaning.slice(0, 128),
                    type: 'ai_assert',
                    effectType: 'READ_ONLY',
                    input: {
                      instruction: contract.rule.instruction,
                    },
                  }
            expandedSteps.push(derivedStep)
            outcomeManifestEntries.push({
              contractId: contract.id,
              scope: contract.scope,
              meaning: contract.meaning,
              severity: contract.severity,
              onViolation: contract.onViolation,
              provenance: contract.provenance,
              stepId: derivedId,
              sourceStepId: step.id,
              rule: contract.rule,
            })
          }
        }
      } else if (step.type === 'assert' || step.type === 'ai_assert') {
        const rule: OutcomeRule =
          step.type === 'assert'
            ? {
                kind: 'deterministic',
                ...((step.input as { target?: any; expect: any }).target
                  ? { target: (step.input as { target?: any; expect: any }).target }
                  : {}),
                expect: (step.input as { target?: any; expect: any }).expect,
              }
            : {
                kind: 'ai',
                instruction: (step.input as { instruction: string }).instruction,
              }
        outcomeManifestEntries.push({
          contractId: step.id,
          scope: 'step',
          meaning: step.name,
          severity: 'MUST',
          onViolation: 'halt',
          provenance: 'legacy_assert',
          stepId: step.id,
          rule,
        })
      }
      continue
    }

    // 处理 module 调用节点
    const invocation = node as AuthoringModuleInvocation
    const currentOrdinal = invocationOrdinal++

    // 查找已加载的模块数据
    const lookupKey = invocation.moduleVersionId ?? invocation.moduleDraft?.moduleId ?? invocation.moduleId
    const loaded = ctx.loadedModules.get(lookupKey)

    if (invocation.moduleDraft && ctx.mode === 'publish') {
      diagnostics.push({
        code: 'MODULE_DRAFT_REFERENCE_NOT_PUBLISHABLE',
        severity: 'error',
        message: `场景正式发布时不允许引用模块草稿，必须引用已发布的模块版本`,
        fieldPath: ['nodes', String(nodeIndex), 'moduleDraft'],
      })
      continue
    }

    if (!loaded) {
      diagnostics.push({
        code: 'MODULE_VERSION_UNAVAILABLE',
        severity: 'error',
        message: `动作模块版本「${lookupKey}」不可用或未加载`,
        fieldPath: ['nodes', String(nodeIndex), invocation.moduleVersionId ? 'moduleVersionId' : 'moduleId'],
      })
      continue
    }

    // 规则 1：Target 匹配与摘要校验
    if (loaded.targetId !== ctx.targetId) {
      diagnostics.push({
        code: 'MODULE_TARGET_MISMATCH',
        severity: 'error',
        message: `模块「${loaded.moduleKey}」属于 Target(${loaded.targetId})，与当前场景 Target(${ctx.targetId}) 不一致`,
        fieldPath: ['nodes', String(nodeIndex)],
      })
    }

    referencedContentDigests.add(loaded.contentDigest)

    const recomputedDigest = moduleContentDigest(loaded.content)
    if (loaded.contentDigest !== recomputedDigest) {
      diagnostics.push({
        code: 'MODULE_DIGEST_MISMATCH',
        severity: 'error',
        message: `模块内容摘要不匹配（记录 ${loaded.contentDigest}，实际 ${recomputedDigest}）`,
        fieldPath: ['nodes', String(nodeIndex), invocation.moduleDraft ? 'moduleDraft' : 'moduleVersionId'],
      })
    } else if (invocation.moduleDraft && invocation.moduleDraft.contentDigest !== loaded.contentDigest) {
      diagnostics.push({
        code: 'MODULE_DIGEST_MISMATCH',
        severity: 'error',
        message: `模块草稿内容摘要不匹配（期望 ${invocation.moduleDraft.contentDigest}，实际 ${loaded.contentDigest}）`,
        fieldPath: ['nodes', String(nodeIndex), 'moduleDraft', 'contentDigest'],
      })
    }

    if (loaded.publicationStatus === 'deprecated') {
      diagnostics.push({
        code: 'MODULE_VERSION_DEPRECATED',
        severity: 'warning',
        message: `所引用的动作模块版本「${loaded.moduleKey}@v${loaded.versionNo ?? 1}」已被标记为弃用`,
        fieldPath: ['nodes', String(nodeIndex), 'moduleVersionId'],
      })
    }

    if (loaded.publicationStatus === 'withdrawn' && ctx.mode === 'publish') {
      diagnostics.push({
        code: 'MODULE_VERSION_WITHDRAWN',
        severity: 'error',
        message: `所引用的动作模块版本「${loaded.moduleKey}@v${loaded.versionNo ?? 1}」已被撤回，发布被阻断`,
        fieldPath: ['nodes', String(nodeIndex), 'moduleVersionId'],
      })
    }

    // 检查输入绑定
    const contract = loaded.content.contract
    const selection = resolveInvocationSelection(invocation)

    for (const inputDecl of contract.inputs) {
      const binding = invocation.inputBindings[inputDecl.key]
      if (!binding) {
        if (inputDecl.required) {
          diagnostics.push({
            code: 'MODULE_INPUT_UNBOUND',
            severity: 'error',
            message: `模块必填输入「${inputDecl.label}」(${inputDecl.key}) 未绑定`,
            fieldPath: ['nodes', String(nodeIndex), 'inputBindings', inputDecl.key],
          })
        }
        continue
      }

      if (binding.kind === 'literal') {
        if (!checkLiteralType(binding.value, inputDecl.valueType)) {
          diagnostics.push({
            code: 'MODULE_INPUT_TYPE_MISMATCH',
            severity: 'error',
            message: `输入「${inputDecl.key}」绑定的字面量类型与声明类型 ${inputDecl.valueType} 不符`,
            fieldPath: ['nodes', String(nodeIndex), 'inputBindings', inputDecl.key, 'value'],
          })
        }
      } else if (binding.kind === 'from') {
        if (!availableContextKeys.has(binding.key)) {
          diagnostics.push({
            code: 'SCENARIO_FORWARD_REF',
            severity: 'error',
            message: `输入绑定引用了尚未产生的上下文键「${binding.key}」`,
            fieldPath: ['nodes', String(nodeIndex), 'inputBindings', inputDecl.key, 'key'],
          })
        }
      }
    }

    const selectedImpls = selection.keys.map((key) => ({ key, impl: findModuleImplementation(loaded.content, key) }))
    const missing = selectedImpls.filter((item) => !item.impl)
    if (missing.length > 0) {
      diagnostics.push({
        code: 'MODULE_IMPLEMENTATION_UNKNOWN',
        severity: 'error',
        message: `模块「${loaded.moduleKey}」没有实现「${missing.map((item) => item.key).join('、')}」`,
        fieldPath: ['nodes', String(nodeIndex), selection.mode === 'frozen_fallback' ? 'selection' : 'implementationKey'],
      })
      continue
    }
    if (selection.mode === 'frozen_fallback') {
      if (!ctx.fallbackEnabled) {
        diagnostics.push({
          code: 'MODULE_FALLBACK_DISABLED',
          severity: 'error',
          message: '平台尚未开放冻结候选回退',
          fieldPath: ['nodes', String(nodeIndex), 'selection'],
        })
      }
      const notReadOnly =
        contract.effectCeiling !== 'READ_ONLY' ||
        selectedImpls.some((item) => item.impl!.steps.some((step) => step.effectType !== 'READ_ONLY'))
      if (notReadOnly) {
        diagnostics.push({
          code: 'MODULE_FALLBACK_NOT_READ_ONLY',
          severity: 'error',
          message: '只有全部步骤都是只读的模块才能声明冻结回退',
          fieldPath: ['nodes', String(nodeIndex), 'selection'],
        })
      }
      if (selection.keys.length < 2) {
        diagnostics.push({
          code: 'MODULE_FALLBACK_CANDIDATES_INVALID',
          severity: 'error',
          message: '冻结回退至少需要两个不同的实现候选',
          fieldPath: ['nodes', String(nodeIndex), 'selection', 'candidates'],
        })
      }
    }

    const impl = selectedImpls[0]?.impl
    if (!impl) continue

    if (implementationHasNestedInvocation(loaded.content)) {
      diagnostics.push({
        code: 'MODULE_NESTING_FORBIDDEN',
        severity: 'error',
        message: `模块「${loaded.moduleKey}」的实现含有嵌套调用，首轮不允许嵌套`,
        fieldPath: ['nodes', String(nodeIndex)],
      })
      continue
    }

    const declaredInputKeys = new Set(contract.inputs.map((item) => item.key))
    for (let stepIndex = 0; stepIndex < impl.steps.length; stepIndex++) {
      const orig = impl.steps[stepIndex]!
      const usages: Array<{ key: string; path: Array<string | number> }> = []
      collectFromUsages(orig.input, ['input'], usages)
      for (const usage of usages) {
        if (!declaredInputKeys.has(usage.key)) continue
        const supportedValueFrom =
          BINDABLE_STEP_TYPES.has(orig.type) &&
          usage.path.length === 2 &&
          usage.path[0] === 'input' &&
          usage.path[1] === 'from'
        if (!supportedValueFrom) {
          diagnostics.push({
            code: 'MODULE_BINDING_UNSUPPORTED',
            severity: 'error',
            message: `当前仅支持 fill/select/echo 的值绑定，不能把输入绑定到定位、断言期望或锚点文本`,
            fieldPath: ['nodes', String(nodeIndex), 'inputBindings', usage.key],
          })
        }
      }
    }

    const fallback = selection.mode === 'frozen_fallback'
    const expandedAlts: Array<{ key: string; impl: ModuleImplementation; expanded: ExpandedImplementation }> = []
    for (const item of selectedImpls) {
      const current = item.impl!
      const expanded = expandImplementation({
        impl: current,
        invocation,
        contract,
        nodeIndex,
        currentOrdinal,
        idImplementationKey: fallback ? item.key : undefined,
        exposeOutputs: !fallback,
        sceneOutputKeys,
        availableContextKeys,
        diagnostics,
      })
      expandedAlts.push({ key: item.key, impl: current, expanded })
      expandedSteps.push(...expanded.steps)
    }

    const first = expandedAlts[0]!
    const inputBindingsDigest = syncSha256(canonicalJson(invocation.inputBindings))
    const allExpandedIds = expandedAlts.flatMap((item) => item.expanded.expandedStepIds)
    const mergedInternalToExpanded = Object.fromEntries(
      expandedAlts.flatMap((item) => Object.entries(item.expanded.internalToExpanded)),
    )

    if (fallback && expandedAlts.length >= 2) {
      candidateGroups.push({
        groupId: invocation.invocationId,
        invocationId: invocation.invocationId,
        alternatives: expandedAlts.map((item) => ({
          implementationKey: item.key,
          implementationDigest: singleImplementationDigest(item.impl),
          stepIds: item.expanded.expandedStepIds,
          postconditionStepIds: item.expanded.postconditionStepIds,
          outputStaging: item.expanded.outputStaging,
        })),
      })
    }

    manifestEntries.push({
      invocationId: invocation.invocationId,
      ordinal: currentOrdinal,
      name: invocation.name ?? loaded.name,
      moduleId: loaded.moduleId,
      moduleKey: loaded.moduleKey,
      moduleVersionId: invocation.moduleVersionId,
      versionNo: loaded.versionNo && loaded.versionNo > 0 ? loaded.versionNo : undefined,
      moduleDraftRevision: invocation.moduleDraft?.revision,
      contentDigest: loaded.contentDigest,
      contractDigest: loaded.contractDigest,
      implementationDigest: loaded.implementationDigest,
      implementationKey: selection.keys[0] ?? invocation.implementationKey,
      selectedImplementationDigest: singleImplementationDigest(first.impl),
      selectionMode: selection.mode,
      executionMode: deriveExecutionMode(loaded.content.implementations.flatMap((item) => item.steps)),
      effectCeiling: contract.effectCeiling,
      expandedStepIds: allExpandedIds,
      internalToExpanded: mergedInternalToExpanded,
      preconditionStepIds: first.expanded.preconditionStepIds,
      postconditionStepIds: first.expanded.postconditionStepIds,
      outputRequired: first.expanded.outputRequired,
      inputBindingsDigest,
    })
  }

  // 处理场景级契约 scenarioOutcomes
  if (document.scenarioOutcomes && document.scenarioOutcomes.length > 0) {
    for (const contract of document.scenarioOutcomes) {
      const derivedId = deterministicStepId('scenario', contract.id)
      const derivedStep: Step =
        contract.rule.kind === 'deterministic'
          ? {
              id: derivedId,
              name: contract.meaning.slice(0, 128),
              type: 'assert',
              effectType: 'READ_ONLY',
              input: {
                ...(contract.rule.target ? { target: contract.rule.target } : {}),
                expect: contract.rule.expect,
              },
            }
          : {
              id: derivedId,
              name: contract.meaning.slice(0, 128),
              type: 'ai_assert',
              effectType: 'READ_ONLY',
              input: {
                instruction: contract.rule.instruction,
              },
            }
      expandedSteps.push(derivedStep)
      outcomeManifestEntries.push({
        contractId: contract.id,
        scope: contract.scope,
        meaning: contract.meaning,
        severity: contract.severity,
        onViolation: contract.onViolation,
        provenance: contract.provenance,
        stepId: derivedId,
        rule: contract.rule,
      })
    }
  }

  const outcomeManifest: OutcomeManifest | undefined =
    outcomeManifestEntries.length > 0 ? { entries: outcomeManifestEntries } : undefined

  const runtimeInvariantEntries = document.runtimeInvariants ?? []
  for (const [index, invariant] of runtimeInvariantEntries.entries()) {
    const parsed = runtimeInvariantSchema.safeParse(invariant)
    if (!parsed.success) {
      diagnostics.push({
        code: 'RUNTIME_INVARIANT_INVALID',
        severity: 'error',
        message: parsed.error.issues[0]?.message ?? '运行期约束不合法',
        fieldPath: ['runtimeInvariants', String(index)],
      })
    }
  }
  const runtimeInvariantManifest: RuntimeInvariantManifest | undefined =
    runtimeInvariantEntries.length > 0 ? { entries: runtimeInvariantEntries } : undefined

  // 规则 10：步数上限限制
  if (expandedSteps.length > MAX_SCENARIO_STEPS) {
    const details = manifestEntries
      .map((e) => `「${e.name}」(${e.expandedStepIds.length}步)`)
      .join('、')
    diagnostics.push({
      code: 'SCENARIO_EXPANDED_STEP_LIMIT',
      severity: 'error',
      message: `场景展开后总步数达到 ${expandedSteps.length} 步，超过上限 ${MAX_SCENARIO_STEPS} 步（调用包含：${details}）`,
    })
  }

  const manifest: ModuleManifest = {
    entries: manifestEntries,
    ...(candidateGroups.length > 0 ? { candidateGroups } : {}),
  }

  // 组装扁平的 ScenarioDefinition
  let definition: ScenarioDefinition | undefined = undefined
  if (expandedSteps.length > 0 && expandedSteps.length <= MAX_SCENARIO_STEPS) {
    const defCandidate = {
      schemaVersion: document.schemaVersion,
      inputs: document.inputs,
      steps: expandedSteps,
    }
    const parsedDef = scenarioDocumentSchema.safeParse(defCandidate)
    if (parsedDef.success) {
      definition = parsedDef.data
      // 运行现有的扁平场景编译校验（能力闸门、AI 配置等）
      const compileMode = ctx.mode === 'publish' ? 'release' : 'save'
      const compileRes = compileScenarioDocument(definition, {
        mode: compileMode,
        ...ctx.compilerCtx,
        outcomeManifest: outcomeManifest ?? { entries: [] },
      })
      diagnostics.push(...compileRes.diagnostics)
    } else {
      diagnostics.push(
        ...parsedDef.error.issues.map((issue) => ({
          code: 'SCENARIO_COMPILE_ERROR',
          severity: 'error' as const,
          message: issue.message,
          fieldPath: issue.path.map(String),
        })),
      )
    }
  }

  // 只覆盖本文档真正引用到的版本，避免调用方多加载模块就改变摘要
  const moduleContentDigests = [...referencedContentDigests].sort()
  const sourceDigest = syncSha256(
    canonicalJson({
      document,
      moduleContentDigests,
    }),
  )

  return {
    ok: !diagnostics.some((d) => d.severity === 'error'),
    definition,
    manifest,
    ...(outcomeManifest ? { outcomeManifest } : {}),
    ...(runtimeInvariantManifest ? { runtimeInvariantManifest } : {}),
    diagnostics: diagnostics.map(clampDiagnostic),
    sourceDigest,
  }
}
