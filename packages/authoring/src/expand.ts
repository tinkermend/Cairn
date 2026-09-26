import {
  canonicalJson,
  deriveExecutionMode,
  FACTORY_COMPILE_RESOLUTION,
  findModuleImplementation,
  isAuthoringDocumentV2,
  MAX_COMPILED_SCENARIO_STEPS,
  MAX_SCENARIO_LOOP_BUDGET_STEPS,
  MAX_SCENARIO_STEPS,
  normalizeAuthoringDocument,
  resolveInvocationSelection,
  scenarioDefinitionSchema,
  scenarioDocumentSchema,
  syncSha256,
  walkAuthoringNodes,
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
  CONTROL_FLOW_PROTOCOL,
  CONTROL_FLOW_PROTOCOL_V2,
  OPTIONAL_ALLOWED_STEP_TYPES,
  authoringNodeId,
  authoringHasControlBlocks,
  isNodeOutputPossiblyAbsent,
  validateExpression,
  inferExpressionShape,
  outputShapeForStep,
  type AuthoringBlockNode,
  type ControlFlowBlock,
  type ControlFlowManifest,
  type Expr,
  type OutputShape,
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
  controlFlow?: ControlFlowManifest
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
    for (const item of walkAuthoringNodes(doc)) {
      const node = item.node
      // 停用步骤不执行，它的成功条件不适用；与 expandAuthoringDocument 的清单保持一致。
      if (node.kind === 'step' && !node.step.disabled) {
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
      if (step.disabled) continue
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
  outputVerificationStepIds: string[]
  frozenOutputs: Record<string, string>
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
    if (step.type === 'fill' || step.type === 'echo' || step.type === 'select' ||
      (step.type === 'ai_action' && 'operation' in step.input && step.input.operation === 'input')) {
      const stepInput = step.input as { value?: unknown; from?: string; fromField?: string }
      if (typeof stepInput.value === 'string' && !stepInput.from) {
        const expression = /^\$\{(inputs|steps)\.([A-Za-z][A-Za-z0-9_]*)\}$/.exec(stepInput.value)
        if (expression?.[1] === 'inputs') {
          stepInput.from = expression[2]
          delete stepInput.value
        } else if (expression?.[1] === 'steps') {
          stepInput.from = outputRenames.get(expression[2]!) ?? expression[2]
          delete stepInput.value
        }
      }
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

    const stepBindings = (impl.fieldBindings ?? []).filter((b) => b.stepId === orig.id)
    for (const binding of stepBindings) {
      const invBinding = invocation.inputBindings[binding.inputKey]
      if (!invBinding) continue
      if (invBinding.kind === 'literal') {
        if (binding.field === 'navigate.url') {
          (step.input as any).url = String(invBinding.value)
        } else if (binding.field === 'target.anchor.withinText') {
          if ((step.input as any).target?.anchor) {
            (step.input as any).target.anchor.withinText = String(invBinding.value)
          }
        } else if (binding.field === 'target.candidate.name') {
          if ((step.input as any).target?.candidates?.[0]) {
            (step.input as any).target.candidates[0].name = String(invBinding.value)
          }
        } else if (binding.field === 'target.candidate.value') {
          if ((step.input as any).target?.candidates?.[0]) {
            (step.input as any).target.candidates[0].value = String(invBinding.value)
          }
        } else if (binding.field === 'assert.expect.value') {
          if ((step.input as any).expect) {
            if ((step.input as any).expect.kind === 'number_compare') {
              (step.input as any).expect.value = Number(invBinding.value)
            } else {
              (step.input as any).expect.value = String(invBinding.value)
            }
          }
        }
      } else if (invBinding.kind === 'from') {
        const resolvedKey = outputRenames.get(invBinding.key) ?? invBinding.key
        const fieldRefs: Record<string, { from: string; fromField?: string }> = step.fieldRefs ? { ...step.fieldRefs } : {}
        fieldRefs[binding.field] = {
          from: resolvedKey,
          ...(invBinding.field ? { fromField: invBinding.field } : {}),
        }
        step.fieldRefs = fieldRefs
      }
    }
    expandedSteps.push(step)
  }

  const frozenOutputs: Record<string, string> = {}
  for (const outDecl of contract.outputs) {
    const exposedKey = invocation.outputBindings[outDecl.key]
    const namespaced = namespacedKey(currentOrdinal, outDecl.key, idImplementationKey)
    const finalKey = exposeOutputs ? (exposedKey ?? namespaced) : namespaced
    frozenOutputs[outDecl.key] = finalKey
  }

  const outputVerificationStepIds: string[] = []
  if (contract.outputs.length > 0) {
    const verifyStepId = deterministicStepId(invocation.invocationId, '__verify_context', idImplementationKey)
    const verifyStep: Step = {
      id: verifyStepId,
      name: `验证输出契约 [${impl.implementationKey}]`,
      type: 'verify_context',
      effectType: 'READ_ONLY',
      input: {
        keys: Object.values(frozenOutputs),
      },
    }
    expandedSteps.push(verifyStep)
    moduleExpandedStepIds.push(verifyStepId)
    outputVerificationStepIds.push(verifyStepId)
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
    outputVerificationStepIds,
    frozenOutputs,
    outputRequired,
    outputStaging,
  }
}

function shapeForInput(type: ScenarioInputDecl['type']): OutputShape {
  if (type === 'string' || type === 'url' || type === 'file') return { kind: 'scalar', type: 'string' }
  if (type === 'number') return { kind: 'scalar', type: 'number' }
  if (type === 'boolean') return { kind: 'scalar', type: 'boolean' }
  return { kind: 'unknown' }
}

function shapeForExpandedStep(step: Step, shapes: Record<string, OutputShape>): OutputShape {
  if (step.type === 'compute') return inferExpressionShape(step.input.expression, shapes)
  if (step.type === 'probe') {
    return {
      kind: 'object',
      fields: [{ name: 'matched', type: 'boolean', required: true }],
    }
  }
  return outputShapeForStep(step)
}

function findUnprotectedExprRefs(expr: Expr, isProtected = false): string[] {
  if (expr.kind === 'ref') {
    return isProtected ? [] : [expr.key]
  }
  if (expr.kind === 'call') {
    const protectsArgs = expr.fn === 'exists' || expr.fn === 'coalesce'
    return expr.args.flatMap((arg) => findUnprotectedExprRefs(arg, isProtected || protectsArgs))
  }
  if (expr.kind === 'compare') {
    return [
      ...findUnprotectedExprRefs(expr.left, isProtected),
      ...findUnprotectedExprRefs(expr.right, isProtected),
    ]
  }
  if (expr.kind === 'logic') {
    return expr.args.flatMap((arg) => findUnprotectedExprRefs(arg, isProtected))
  }
  if (expr.kind === 'not') {
    return findUnprotectedExprRefs(expr.arg, isProtected)
  }
  return []
}

function collectAllExprRefs(expr: Expr): Array<{ key: string; field?: string }> {
  const refs: Array<{ key: string; field?: string }> = []
  function walkExpr(e: Expr) {
    if (e.kind === 'ref') {
      refs.push({ key: e.key, field: e.field })
    } else if (e.kind === 'call') {
      e.args.forEach(walkExpr)
    } else if (e.kind === 'compare') {
      walkExpr(e.left)
      walkExpr(e.right)
    } else if (e.kind === 'logic') {
      e.args.forEach(walkExpr)
    } else if (e.kind === 'not') {
      walkExpr(e.arg)
    }
  }
  walkExpr(expr)
  return refs
}

export function deriveControlFlowManifest(
  authoringDocument?: ScenarioAuthoringDocumentV2 | null,
  steps?: Step[] | null,
): ControlFlowManifest | undefined {
  if (authoringDocument && authoringHasControlBlocks(authoringDocument)) {
    const items = walkAuthoringNodes(authoringDocument)
    const blockNodeMap = new Map<
      string,
      {
        node: AuthoringBlockNode
        parentId?: string
        branchKey?: 'then' | 'else' | 'body'
      }
    >()
    const blockBranchStepMap = new Map<string, { then: string[]; else: string[]; body: string[] }>()

    for (const item of items) {
      if (item.node.kind === 'block') {
        blockNodeMap.set(item.node.blockId, {
          node: item.node,
          parentId: item.parentId,
          branchKey: item.branchKey,
        })
        blockBranchStepMap.set(item.node.blockId, { then: [], else: [], body: [] })
        const stepHeaderId = 'then' in item.node
          ? deterministicStepId(item.node.blockId, 'decide')
          : deterministicStepId(item.node.blockId, 'loop')
        for (const ancestor of item.ancestry) {
          blockBranchStepMap.get(ancestor.blockId)?.[ancestor.branchKey]?.push(stepHeaderId)
        }
      } else if (item.node.kind === 'step') {
        const step = item.node.step
        for (const ancestor of item.ancestry) {
          blockBranchStepMap.get(ancestor.blockId)?.[ancestor.branchKey]?.push(step.id)
        }
        if (item.node.outcomes) {
          for (const contract of item.node.outcomes) {
            if (step.type !== 'assert' && step.type !== 'ai_assert') {
              const derivedId = deterministicStepId(step.id, contract.id)
              for (const ancestor of item.ancestry) {
                blockBranchStepMap.get(ancestor.blockId)?.[ancestor.branchKey]?.push(derivedId)
              }
            }
          }
        }
      }
    }

    let hasLoopBlock = false
    const blocks: ControlFlowBlock[] = []
    for (const [blockId, info] of blockNodeMap.entries()) {
      const stepMap = blockBranchStepMap.get(blockId) ?? { then: [], else: [], body: [] }
      if ('then' in info.node) {
        const branches: Array<{ key: 'then' | 'else'; stepIds: string[] }> = [
          { key: 'then', stepIds: stepMap.then },
        ]
        if (info.node.else !== undefined || stepMap.else.length > 0) {
          branches.push({ key: 'else', stepIds: stepMap.else })
        }
        blocks.push({
          blockId,
          kind: 'if',
          decideStepId: deterministicStepId(blockId, 'decide'),
          branches,
          ...(info.parentId ? { parentBlockId: info.parentId } : {}),
          ...(info.branchKey && (info.branchKey === 'then' || info.branchKey === 'else')
            ? { parentBranch: info.branchKey }
            : {}),
        })
      } else {
        hasLoopBlock = true
        blocks.push({
          blockId,
          kind: info.node.control.type,
          headerStepId: deterministicStepId(blockId, 'loop'),
          bodyStepIds: stepMap.body,
          limits: {
            maxItems: info.node.control.type === 'for_each' ? info.node.control.maxItems : undefined,
            maxIterations: info.node.control.type === 'repeat' ? info.node.control.maxIterations : undefined,
            intervalMs: info.node.control.type === 'repeat' ? info.node.control.intervalMs : undefined,
            onLimit: info.node.control.type === 'repeat' ? info.node.control.onLimit : undefined,
          },
          ...(info.node.collect ? { collect: info.node.collect } : {}),
          ...(info.parentId ? { parentBlockId: info.parentId } : {}),
          ...(info.branchKey && (info.branchKey === 'then' || info.branchKey === 'else')
            ? { parentBranch: info.branchKey }
            : {}),
        })
      }
    }

    return {
      protocol: hasLoopBlock ? CONTROL_FLOW_PROTOCOL_V2 : CONTROL_FLOW_PROTOCOL,
      blocks,
    }
  }

  const hasLoopStep = steps?.some((s) => s.type === 'loop')
  const hasFeatures = steps?.some(
    (s) => s.type === 'decide' || s.type === 'probe' || s.type === 'compute' || s.type === 'loop' || Boolean((s as any).optional),
  )
  if (hasFeatures) {
    return {
      protocol: hasLoopStep ? CONTROL_FLOW_PROTOCOL_V2 : CONTROL_FLOW_PROTOCOL,
      blocks: [],
    }
  }

  return undefined
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
              : issue.path.includes('outcomes') || issue.path.includes('scenarioOutcomes')
                ? 'OUTCOME_CONTRACT_INVALID'
                : 'SCENARIO_AUTHORING_DOCUMENT_INVALID',
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
  const blockNodeMap = new Map<
    string,
    {
      node: AuthoringBlockNode
      parentId?: string
      branchKey?: 'then' | 'else' | 'body'
    }
  >()
  const blockBranchStepMap = new Map<string, { then: string[]; else: string[]; body: string[] }>()

  const allVariableNames = new Set<string>(document.inputs.map((i) => i.key))
  const variableScopeMap = new Map<string, string>() // varName -> loopBlockId

  const availableContextKeys = new Set<string>(document.inputs.map((i) => i.key))
  const contextShapes: Record<string, OutputShape> = {}
  for (const input of document.inputs) {
    contextShapes[input.key] = shapeForInput(input.type)
  }
  const sceneOutputKeys = new Set<string>()
  const referencedContentDigests = new Set<string>()

  let invocationOrdinal = 0

  const docItems = walkAuthoringNodes(document)

  // 映射循环块结束位置：当遍历离开循环体时激活 collect.into
  const loopEndCollectMap = new Map<number, Array<{ from: string; fromField?: string; into: string }>>()
  for (let idx = 0; idx < docItems.length; idx++) {
    const item = docItems[idx]!
    if (item.node.kind === 'block' && !('then' in item.node)) {
      const blockId = item.node.blockId
      let lastChildIdx = idx
      for (let k = idx + 1; k < docItems.length; k++) {
        if (docItems[k]!.ancestry.some((anc) => anc.blockId === blockId)) {
          lastChildIdx = k
        }
      }
      if (item.node.collect && item.node.collect.length > 0) {
        const existing = loopEndCollectMap.get(lastChildIdx) ?? []
        loopEndCollectMap.set(lastChildIdx, [...existing, ...item.node.collect])
      }
    }
  }

  const checkOutOfScopeRef = (
    key: string,
    currentAncestry: Array<{ blockId: string; branchKey: 'then' | 'else' | 'body' }> | undefined,
    fieldPath?: string[],
  ) => {
    const scopedBlockId = variableScopeMap.get(key)
    if (!scopedBlockId) return
    const isWithinScope = (currentAncestry ?? []).some((anc) => anc.blockId === scopedBlockId)
    if (!isWithinScope) {
      diagnostics.push({
        code: 'SCENARIO_LOOP_OUTPUT_OUT_OF_SCOPE',
        severity: 'error',
        message: `循环外引用循环体内部局部变量「${key}」，必须改用 collect 汇集到场景上下文`,
        fieldPath,
      })
    }
  }

  const addStep = (step: Step, ancestry?: Array<{ blockId: string; branchKey: 'then' | 'else' | 'body' }>) => {
    expandedSteps.push(step)
    for (const anc of ancestry ?? []) {
      const bMap = blockBranchStepMap.get(anc.blockId)
      if (bMap && anc.branchKey in bMap) {
        bMap[anc.branchKey].push(step.id)
      }
    }
  }

  for (let nodeIndex = 0; nodeIndex < docItems.length; nodeIndex++) {
    const prevCollects = loopEndCollectMap.get(nodeIndex - 1)
    if (prevCollects) {
      for (const c of prevCollects) {
        availableContextKeys.add(c.into)
        contextShapes[c.into] = { kind: 'list', item: { kind: 'scalar', type: 'json' } }
        variableScopeMap.delete(c.into)
      }
    }

    const item = docItems[nodeIndex]!
    const node = item.node

    if (node.kind === 'block') {
      blockNodeMap.set(node.blockId, {
        node,
        parentId: item.parentId,
        branchKey: item.branchKey,
      })
      blockBranchStepMap.set(node.blockId, { then: [], else: [], body: [] })

      if ('then' in node) {
        const condValid = validateExpression(node.control.condition)
        if (!condValid.valid) {
          diagnostics.push({
            code: condValid.code as any,
            severity: 'error',
            message: condValid.message,
            fieldPath: ['nodes', String(nodeIndex), 'control', 'condition'],
          })
        }
        const refs = collectAllExprRefs(node.control.condition)
        for (const ref of refs) {
          if (!availableContextKeys.has(ref.key)) {
            diagnostics.push({
              code: 'SCENARIO_UNRESOLVED_REF',
              severity: 'error',
              message: `条件表达式引用了未知的上下文键「${ref.key}」`,
              fieldPath: ['nodes', String(nodeIndex), 'control', 'condition'],
            })
          }
          checkOutOfScopeRef(ref.key, item.ancestry, ['nodes', String(nodeIndex), 'control', 'condition'])
        }
        const conditionShape = inferExpressionShape(node.control.condition, contextShapes)
        if (!(conditionShape.kind === 'scalar' && conditionShape.type === 'boolean')) {
          diagnostics.push({
            code: 'EXPR_TYPE_MISMATCH',
            severity: 'error',
            message: '条件表达式的结果必须是布尔值',
            fieldPath: ['nodes', String(nodeIndex), 'control', 'condition'],
          })
        }
        const unprotectedRefs = findUnprotectedExprRefs(node.control.condition)
        for (const refKey of unprotectedRefs) {
          if (isNodeOutputPossiblyAbsent(document, refKey, authoringNodeId(node))) {
            diagnostics.push({
              code: 'SCENARIO_CONDITIONAL_OUTPUT_REFERENCED',
              severity: ctx.mode === 'publish' ? 'error' : 'warning',
              message: `条件表达式引用了可能缺失的输出「${refKey}」，必须使用 exists() 或 coalesce() 保护`,
              fieldPath: ['nodes', String(nodeIndex), 'control', 'condition'],
            })
          }
        }

        const decideStepId = deterministicStepId(node.blockId, 'decide')
        const decideStep: Step = {
          id: decideStepId,
          name: node.name ? `分支判定: ${node.name}` : `分支判定: ${node.blockId}`,
          type: 'decide',
          effectType: 'READ_ONLY',
          input: {
            blockId: node.blockId,
            condition: node.control.condition,
          },
        }
        addStep(decideStep, item.ancestry)
        continue
      } else {
        // 循环块（for_each / repeat）
        // 1. 禁止嵌套循环
        const inLoop = (item.ancestry ?? []).some((anc) => {
          const bInfo = blockNodeMap.get(anc.blockId)
          return bInfo && !('then' in bInfo.node)
        })
        if (inLoop) {
          diagnostics.push({
            code: 'SCENARIO_LOOP_NESTING_UNSUPPORTED',
            severity: 'error',
            message: '流程控制块不支持嵌套循环',
            fieldPath: ['nodes', String(nodeIndex)],
          })
        }

        // 收集循环体内部输出供结束条件校验
        const bodyOutputs = new Set<string>()
        for (const bNode of node.body) {
          for (const walkItem of walkAuthoringNodes({ ...document, nodes: [bNode] })) {
            if (walkItem.node.kind === 'step' && walkItem.node.step.outputKey) {
              bodyOutputs.add(walkItem.node.step.outputKey)
            }
          }
        }

        if (node.control.type === 'for_each') {
          if (allVariableNames.has(node.control.as)) {
            diagnostics.push({
              code: 'SCENARIO_VARIABLE_NAME_CONFLICT',
              severity: 'error',
              message: `循环变量「${node.control.as}」与已有变量名冲突`,
              fieldPath: ['nodes', String(nodeIndex), 'control', 'as'],
            })
          }
          allVariableNames.add(node.control.as)
          variableScopeMap.set(node.control.as, node.blockId)
          availableContextKeys.add(node.control.as)
          contextShapes[node.control.as] = { kind: 'unknown' }

          if (node.control.indexAs) {
            if (allVariableNames.has(node.control.indexAs)) {
              diagnostics.push({
                code: 'SCENARIO_VARIABLE_NAME_CONFLICT',
                severity: 'error',
                message: `循环序号变量「${node.control.indexAs}」与已有变量名冲突`,
                fieldPath: ['nodes', String(nodeIndex), 'control', 'indexAs'],
              })
            }
            allVariableNames.add(node.control.indexAs)
            variableScopeMap.set(node.control.indexAs, node.blockId)
            availableContextKeys.add(node.control.indexAs)
            contextShapes[node.control.indexAs] = { kind: 'scalar', type: 'number' }
          }

          if (!availableContextKeys.has(node.control.over.from)) {
            diagnostics.push({
              code: 'SCENARIO_UNRESOLVED_REF',
              severity: 'error',
              message: `逐项循环引用的集合「${node.control.over.from}」未定义`,
              fieldPath: ['nodes', String(nodeIndex), 'control', 'over', 'from'],
            })
          }
          checkOutOfScopeRef(node.control.over.from, item.ancestry, ['nodes', String(nodeIndex), 'control', 'over', 'from'])

          if (node.control.stopWhen) {
            const condValid = validateExpression(node.control.stopWhen)
            if (!condValid.valid) {
              diagnostics.push({
                code: condValid.code as any,
                severity: 'error',
                message: condValid.message,
                fieldPath: ['nodes', String(nodeIndex), 'control', 'stopWhen'],
              })
            }
            const refs = collectAllExprRefs(node.control.stopWhen)
            for (const ref of refs) {
              if (!availableContextKeys.has(ref.key) && !bodyOutputs.has(ref.key)) {
                diagnostics.push({
                  code: 'SCENARIO_UNRESOLVED_REF',
                  severity: 'error',
                  message: `提前结束条件引用了未知的上下文键「${ref.key}」`,
                  fieldPath: ['nodes', String(nodeIndex), 'control', 'stopWhen'],
                })
              }
            }
          }
        } else if (node.control.type === 'repeat') {
          const condValid = validateExpression(node.control.until)
          if (!condValid.valid) {
            diagnostics.push({
              code: condValid.code as any,
              severity: 'error',
              message: condValid.message,
              fieldPath: ['nodes', String(nodeIndex), 'control', 'until'],
            })
          }
          const refs = collectAllExprRefs(node.control.until)
          for (const ref of refs) {
            if (!availableContextKeys.has(ref.key) && !bodyOutputs.has(ref.key)) {
              diagnostics.push({
                code: 'SCENARIO_UNRESOLVED_REF',
                severity: 'error',
                message: `结束条件引用了未知的上下文键「${ref.key}」`,
                fieldPath: ['nodes', String(nodeIndex), 'control', 'until'],
              })
            }
          }
        }

        for (const [cIdx, c] of (node.collect ?? []).entries()) {
          if (allVariableNames.has(c.into)) {
            diagnostics.push({
              code: 'SCENARIO_VARIABLE_NAME_CONFLICT',
              severity: 'error',
              message: `汇集目标键名「${c.into}」与已有变量名冲突`,
              fieldPath: ['nodes', String(nodeIndex), 'collect', String(cIdx), 'into'],
            })
          }
          allVariableNames.add(c.into)

          const validSource =
            bodyOutputs.has(c.from) ||
            availableContextKeys.has(c.from) ||
            (node.control.type === 'for_each' &&
              (c.from === node.control.as || (node.control.indexAs && c.from === node.control.indexAs)))
          if (!validSource) {
            diagnostics.push({
              code: 'SCENARIO_UNRESOLVED_REF',
              severity: 'error',
              message: `汇集规则引用的源「${c.from}」在循环体或上文中未定义`,
              fieldPath: ['nodes', String(nodeIndex), 'collect', String(cIdx), 'from'],
            })
          }
        }

        const loopHeaderId = deterministicStepId(node.blockId, 'loop')
        const loopStep: Step = {
          id: loopHeaderId,
          name: node.name ? `循环头: ${node.name}` : `循环头: ${node.blockId}`,
          type: 'loop',
          effectType: 'READ_ONLY',
          input: {
            blockId: node.blockId,
            control: node.control,
            ...(node.collect ? { collect: node.collect } : {}),
          },
        }
        addStep(loopStep, item.ancestry)
        continue
      }
    }

    if (node.kind === 'step') {
      const step = node.step

      if (step.type === 'loop') {
        diagnostics.push({
          code: 'LOOP_STEP_NOT_AUTHORABLE',
          severity: 'error',
          message: '循环步骤由系统根据循环块自动生成，不能直接编写',
          stepId: step.id,
          fieldPath: ['nodes', String(nodeIndex), 'step', 'type'],
        })
      }

      if (step.type === 'decide') {
        diagnostics.push({
          code: 'DECIDE_STEP_NOT_AUTHORABLE',
          severity: 'error',
          message: '判定步骤由系统根据条件块自动生成，不能直接编写',
          stepId: step.id,
          fieldPath: ['nodes', String(nodeIndex), 'step', 'type'],
        })
      }

      if (step.type === 'compute') {
        const computeInput = step.input as { expression: Expr }
        const compValid = validateExpression(computeInput.expression)
        if (!compValid.valid) {
          diagnostics.push({
            code: compValid.code as any,
            severity: 'error',
            message: compValid.message,
            stepId: step.id,
            fieldPath: ['nodes', String(nodeIndex), 'step', 'input', 'expression'],
          })
        }
        const refs = collectAllExprRefs(computeInput.expression)
        for (const ref of refs) {
          if (!availableContextKeys.has(ref.key)) {
            diagnostics.push({
              code: 'SCENARIO_UNRESOLVED_REF',
              severity: 'error',
              message: `计算值表达式引用了未知的上下文键「${ref.key}」`,
              stepId: step.id,
              fieldPath: ['nodes', String(nodeIndex), 'step', 'input', 'expression'],
            })
          }
          checkOutOfScopeRef(ref.key, item.ancestry, ['nodes', String(nodeIndex), 'step', 'input', 'expression'])
        }
        const unprotectedRefs = findUnprotectedExprRefs(computeInput.expression)
        for (const refKey of unprotectedRefs) {
          if (isNodeOutputPossiblyAbsent(document, refKey, authoringNodeId(node))) {
            diagnostics.push({
              code: 'SCENARIO_CONDITIONAL_OUTPUT_REFERENCED',
              severity: ctx.mode === 'publish' ? 'error' : 'warning',
              message: `计算值步骤引用了可能缺失的输出「${refKey}」，必须使用 exists() 或 coalesce() 保护`,
              stepId: step.id,
              fieldPath: ['nodes', String(nodeIndex), 'step', 'input', 'expression'],
            })
          }
        }
      }

      if (step.type === 'probe') {
        const probeInput = step.input as { waitMs?: number; target?: any }
        const waitMs = probeInput.waitMs ?? 2000
        if (step.policy?.timeoutMs !== undefined && step.policy.timeoutMs <= waitMs) {
          diagnostics.push({
            code: 'PROBE_TIMEOUT_TOO_SHORT',
            severity: 'error',
            message: `页面检查步骤的超时时间 (${step.policy.timeoutMs}ms) 必须大于等待时间 (${waitMs}ms)`,
            stepId: step.id,
            fieldPath: ['nodes', String(nodeIndex), 'step', 'policy', 'timeoutMs'],
          })
        }
        if (!step.policy?.timeoutMs) {
          step.policy = {
            ...step.policy,
            timeoutMs: waitMs + 5000,
          }
        }
        if (probeInput.target?.semantic) {
          diagnostics.push({
            code: 'PROBE_AI_TIER_FORBIDDEN',
            severity: 'error',
            message: '页面检查步骤仅支持确定性定位，不允许使用 AI 档位或语义描述',
            stepId: step.id,
            fieldPath: ['nodes', String(nodeIndex), 'step', 'input', 'target'],
          })
        }
      }

      if (step.optional) {
        const allowed = OPTIONAL_ALLOWED_STEP_TYPES.includes(step.type as any)
        if (!allowed) {
          diagnostics.push({
            code: 'STEP_OPTIONAL_TYPE_UNSUPPORTED',
            severity: 'error',
            message: `步骤类型「${step.type}」不支持声明为可选步骤`,
            stepId: step.id,
            fieldPath: ['nodes', String(nodeIndex), 'step', 'optional'],
          })
        } else if (step.type === 'keyboard' && !(step.input as any).target) {
          diagnostics.push({
            code: 'STEP_OPTIONAL_TYPE_UNSUPPORTED',
            severity: 'error',
            message: '无目标的全局键盘步骤不能声明为可选步骤',
            stepId: step.id,
            fieldPath: ['nodes', String(nodeIndex), 'step', 'optional'],
          })
        }
      }

      if (step.fieldRefs) {
        for (const [field, ref] of Object.entries(step.fieldRefs)) {
          if (ref.from) {
            if (!availableContextKeys.has(ref.from)) {
              diagnostics.push({
                code: 'SCENARIO_UNRESOLVED_REF',
                severity: 'error',
                message: `字段「${field}」引用了未知的上下文键「${ref.from}」`,
                stepId: step.id,
                fieldPath: ['nodes', String(nodeIndex), 'step', 'fieldRefs', field, 'from'],
              })
            }
            checkOutOfScopeRef(ref.from, item.ancestry, ['nodes', String(nodeIndex), 'step', 'fieldRefs', field, 'from'])
            if (isNodeOutputPossiblyAbsent(document, ref.from, authoringNodeId(node))) {
              diagnostics.push({
                code: 'SCENARIO_CONDITIONAL_OUTPUT_REFERENCED',
                severity: ctx.mode === 'publish' ? 'error' : 'warning',
                message: `步骤「${step.name}」的字段「${field}」引用了可能缺失的输出「${ref.from}」`,
                stepId: step.id,
              })
            }
          }
        }
      }
      const rawInput = step.input as Record<string, unknown> | undefined
      if (rawInput && typeof rawInput.from === 'string') {
        if (!availableContextKeys.has(rawInput.from)) {
          diagnostics.push({
            code: 'SCENARIO_UNRESOLVED_REF',
            severity: 'error',
            message: `步骤「${step.name}」引用了未知的上下文键「${rawInput.from}」`,
            stepId: step.id,
            fieldPath: ['nodes', String(nodeIndex), 'step', 'input', 'from'],
          })
        }
        checkOutOfScopeRef(rawInput.from, item.ancestry, ['nodes', String(nodeIndex), 'step', 'input', 'from'])
        if (isNodeOutputPossiblyAbsent(document, rawInput.from, authoringNodeId(node))) {
          diagnostics.push({
            code: 'SCENARIO_CONDITIONAL_OUTPUT_REFERENCED',
            severity: ctx.mode === 'publish' ? 'error' : 'warning',
            message: `步骤「${step.name}」引用了可能缺失的输出「${rawInput.from}」`,
            stepId: step.id,
          })
        }
      }

      if (step.outputKey) {
        if (allVariableNames.has(step.outputKey)) {
          diagnostics.push({
            code: 'SCENARIO_VARIABLE_NAME_CONFLICT',
            severity: 'error',
            message: `步骤输出键「${step.outputKey}」与已有变量名冲突`,
            stepId: step.id,
            fieldPath: ['nodes', String(nodeIndex), 'step', 'outputKey'],
          })
        }
        if (sceneOutputKeys.has(step.outputKey)) {
          diagnostics.push({
            code: 'SCENARIO_OUTPUT_KEY_DUPLICATE',
            severity: 'error',
            message: `场景输出键「${step.outputKey}」已被占用`,
            stepId: step.id,
            fieldPath: ['nodes', String(nodeIndex), 'step', 'outputKey'],
          })
        }
        allVariableNames.add(step.outputKey)
        sceneOutputKeys.add(step.outputKey)
        availableContextKeys.add(step.outputKey)
        contextShapes[step.outputKey] = shapeForExpandedStep(step, contextShapes)

        const loopAncestor = (item.ancestry ?? []).slice().reverse().find((anc) => {
          const bInfo = blockNodeMap.get(anc.blockId)
          return bInfo && !('then' in bInfo.node)
        })
        if (loopAncestor) {
          variableScopeMap.set(step.outputKey, loopAncestor.blockId)
        }
      }
      addStep(step, item.ancestry)

      // 停用步骤的成功条件不适用：不进清单，派生的检查步骤随之停用，否则缺结果会把整次 Run 判成 UNKNOWN。
      const manifestSink = step.disabled ? [] : outcomeManifestEntries

      if (node.outcomes && node.outcomes.length > 0) {
        for (const contract of node.outcomes) {
          if (step.type === 'assert' || step.type === 'ai_assert') {
            manifestSink.push({
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
            if (step.disabled) derivedStep.disabled = true
            addStep(derivedStep, item.ancestry)
            manifestSink.push({
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
        manifestSink.push({
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

    // 规则：循环体内不支持放置动作模块
    const inLoop = (item.ancestry ?? []).some((anc) => {
      const bInfo = blockNodeMap.get(anc.blockId)
      return bInfo && !('then' in bInfo.node)
    })
    if (inLoop) {
      diagnostics.push({
        code: 'SCENARIO_LOOP_MODULE_UNSUPPORTED',
        severity: 'error',
        message: '循环体内暂不支持放置动作模块',
        fieldPath: ['nodes', String(nodeIndex)],
      })
      continue
    }

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
        checkOutOfScopeRef(binding.key, item.ancestry, ['nodes', String(nodeIndex), 'inputBindings', inputDecl.key, 'key'])
        if (isNodeOutputPossiblyAbsent(document, binding.key, authoringNodeId(node))) {
          diagnostics.push({
            code: 'SCENARIO_CONDITIONAL_OUTPUT_REFERENCED',
            severity: ctx.mode === 'publish' ? 'error' : 'warning',
            message: `模块输入绑定「${inputDecl.key}」引用了可能缺失的输出「${binding.key}」`,
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
      if (orig.type === 'decide' || orig.type === 'probe' || orig.type === 'compute') {
        diagnostics.push({
          code: 'MODULE_STEP_TYPE_UNSUPPORTED',
          severity: 'error',
          message: `动作模块实现中不支持步骤类型「${orig.type}」`,
          fieldPath: ['nodes', String(nodeIndex), 'implementation', 'steps', String(stepIndex), 'type'],
        })
      }
      const usages: Array<{ key: string; path: Array<string | number> }> = []
      collectFromUsages(orig.input, ['input'], usages)
      for (const usage of usages) {
        if (!declaredInputKeys.has(usage.key)) continue
        if (impl.fieldBindings?.some((fb) => fb.inputKey === usage.key && fb.stepId === orig.id)) continue
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
    for (const selectedItem of selectedImpls) {
      const current = selectedItem.impl!
      const expanded = expandImplementation({
        impl: current,
        invocation,
        contract,
        nodeIndex,
        currentOrdinal,
        idImplementationKey: fallback ? selectedItem.key : undefined,
        exposeOutputs: !fallback,
        sceneOutputKeys,
        availableContextKeys,
        diagnostics,
      })
      if (invocation.disabled) {
        for (const s of expanded.steps) {
          s.disabled = true
        }
      }
      expandedAlts.push({ key: selectedItem.key, impl: current, expanded })
      for (const s of expanded.steps) {
        addStep(s, item.ancestry)
      }
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
          outputVerificationStepIds: item.expanded.outputVerificationStepIds,
          frozenOutputs: item.expanded.frozenOutputs,
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
      outputVerificationStepIds: first.expanded.outputVerificationStepIds,
      frozenOutputs: first.expanded.frozenOutputs,
      outputRequired: first.expanded.outputRequired,
      inputBindingsDigest,
    })
  }

  // 确保所有循环收集的变量都释放到上下文（针对循环位于文档末尾的情况）
  for (const collects of loopEndCollectMap.values()) {
    for (const c of collects) {
      availableContextKeys.add(c.into)
      contextShapes[c.into] = { kind: 'list', item: { kind: 'scalar', type: 'json' } }
      variableScopeMap.delete(c.into)
    }
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
  if (expandedSteps.length > MAX_COMPILED_SCENARIO_STEPS) {
    const details = manifestEntries
      .map((e) => `「${e.name}」(${e.expandedStepIds.length}步)`)
      .join('、')
    diagnostics.push({
      code: 'SCENARIO_EXPANDED_STEP_LIMIT',
      severity: 'error',
      message: `场景展开后总步数达到 ${expandedSteps.length} 步，超过上限 ${MAX_COMPILED_SCENARIO_STEPS} 步（调用包含：${details}）`,
    })
  }

  const manifest: ModuleManifest = {
    entries: manifestEntries,
    ...(candidateGroups.length > 0 ? { candidateGroups } : {}),
  }

  const allLoopHeaderIds = new Set<string>()
  const allLoopBodyStepIds = new Set<string>()
  let loopEstimatedSteps = 0

  const controlFlowBlocks: ControlFlowBlock[] = []
  for (const [blockId, info] of blockNodeMap.entries()) {
    const stepMap = blockBranchStepMap.get(blockId) ?? { then: [], else: [], body: [] }
    if ('then' in info.node) {
      const branches: Array<{ key: 'then' | 'else'; stepIds: string[] }> = [
        { key: 'then', stepIds: stepMap.then },
      ]
      if (info.node.else !== undefined || stepMap.else.length > 0) {
        branches.push({ key: 'else', stepIds: stepMap.else })
      }
      controlFlowBlocks.push({
        blockId,
        kind: 'if',
        decideStepId: deterministicStepId(blockId, 'decide'),
        branches,
        ...(info.parentId ? { parentBlockId: info.parentId } : {}),
        ...(info.branchKey && (info.branchKey === 'then' || info.branchKey === 'else')
          ? { parentBranch: info.branchKey }
          : {}),
      })
    } else {
      const headerStepId = deterministicStepId(blockId, 'loop')
      allLoopHeaderIds.add(headerStepId)
      for (const sId of stepMap.body) {
        allLoopBodyStepIds.add(sId)
      }
      const limit =
        info.node.control.type === 'for_each'
          ? info.node.control.maxItems
          : info.node.control.maxIterations
      loopEstimatedSteps += 1 + stepMap.body.length * limit

      controlFlowBlocks.push({
        blockId,
        kind: info.node.control.type,
        headerStepId,
        bodyStepIds: stepMap.body,
        limits: {
          maxItems: info.node.control.type === 'for_each' ? info.node.control.maxItems : undefined,
          maxIterations: info.node.control.type === 'repeat' ? info.node.control.maxIterations : undefined,
          intervalMs: info.node.control.type === 'repeat' ? info.node.control.intervalMs : undefined,
          onLimit: info.node.control.type === 'repeat' ? info.node.control.onLimit : undefined,
        },
        ...(info.node.collect ? { collect: info.node.collect } : {}),
        ...(info.parentId ? { parentBlockId: info.parentId } : {}),
        ...(info.branchKey && (info.branchKey === 'then' || info.branchKey === 'else')
          ? { parentBranch: info.branchKey }
          : {}),
      })
    }
  }

  const hasLoopBlock = controlFlowBlocks.some((b) => b.kind === 'for_each' || b.kind === 'repeat')
  const hasLoopStep = expandedSteps.some((s) => s.type === 'loop')

  if (hasLoopBlock) {
    const rootStepCount = expandedSteps.filter(
      (s) => !allLoopBodyStepIds.has(s.id) && !allLoopHeaderIds.has(s.id),
    ).length
    const worstCaseSteps = rootStepCount + loopEstimatedSteps
    if (worstCaseSteps > MAX_SCENARIO_LOOP_BUDGET_STEPS) {
      diagnostics.push({
        code: 'SCENARIO_LOOP_BUDGET_EXCEEDED',
        severity: 'error',
        message: `循环最坏展开步数估算 (${worstCaseSteps}) 超过平台上限 (${MAX_SCENARIO_LOOP_BUDGET_STEPS} 步)`,
      })
    }
  }

  const hasControlFlowFeatures = expandedSteps.some(
    (s) => s.type === 'decide' || s.type === 'probe' || s.type === 'compute' || s.type === 'loop' || Boolean((s as any).optional),
  )
  const controlFlow: ControlFlowManifest | undefined =
    controlFlowBlocks.length > 0 || hasControlFlowFeatures
      ? {
          protocol: hasLoopBlock || hasLoopStep ? CONTROL_FLOW_PROTOCOL_V2 : CONTROL_FLOW_PROTOCOL,
          blocks: controlFlowBlocks,
        }
      : undefined

  let hasMustOutcome = false
  let hasMustOutcomeOutsideBranches = false

  for (const item of docItems) {
    if (item.node.kind === 'step') {
      const outcomes = item.node.outcomes ?? []
      for (const oc of outcomes) {
        if ((oc.severity ?? 'MUST') === 'MUST') {
          hasMustOutcome = true
          if (item.ancestry.length === 0) {
            hasMustOutcomeOutsideBranches = true
          }
        }
      }
      if (item.node.step.type === 'assert' || item.node.step.type === 'ai_assert') {
        hasMustOutcome = true
        if (item.ancestry.length === 0) {
          hasMustOutcomeOutsideBranches = true
        }
      }
    }
  }
  if (document.scenarioOutcomes && document.scenarioOutcomes.length > 0) {
    for (const oc of document.scenarioOutcomes) {
      if ((oc.severity ?? 'MUST') === 'MUST') {
        hasMustOutcome = true
        hasMustOutcomeOutsideBranches = true
      }
    }
  }

  if (hasMustOutcome && !hasMustOutcomeOutsideBranches) {
    diagnostics.push({
      code: 'SCENARIO_OUTCOME_ONLY_IN_BRANCHES',
      severity: 'warning',
      message: '场景中所有 MUST 成功条件都位于条件分支内，某些执行路径下可能没有任何必须成立的检查',
    })
  }

  // 组装扁平的 ScenarioDefinition
  let definition: ScenarioDefinition | undefined = undefined
  if (expandedSteps.length > 0 && expandedSteps.length <= MAX_COMPILED_SCENARIO_STEPS) {
    const defCandidate = {
      schemaVersion: document.schemaVersion,
      inputs: document.inputs,
      steps: expandedSteps,
      ...(document.outputs ? { outputs: document.outputs } : {}),
      ...(document.resolution ? { resolution: document.resolution } : {}),
      ...(document.locatorPlan ? { locatorPlan: document.locatorPlan } : {}),
      ...(document.locatorProtocol === 2 ? { locatorProtocol: 2 as const } : {}),
    }
    const parsedDef = scenarioDefinitionSchema.safeParse(defCandidate)
    if (parsedDef.success) {
      definition = parsedDef.data
      // 运行现有的扁平场景编译校验（能力闸门、AI 配置等）
      const compileMode = ctx.mode === 'publish' ? 'release' : 'save'
      const compileRes = compileScenarioDocument(definition, {
        mode: compileMode,
        ...ctx.compilerCtx,
        resolution: {
          ...FACTORY_COMPILE_RESOLUTION,
          ...ctx.compilerCtx?.resolution,
          documentResolution: document.resolution ?? ctx.compilerCtx?.resolution?.documentResolution,
        },
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
    ...(controlFlow ? { controlFlow } : {}),
    diagnostics: diagnostics.map(clampDiagnostic),
    sourceDigest,
  }
}
