import {
  deriveExecutionMode,
  moduleContentSchema,
  scenarioDefinitionFromSteps,
  type CompileDiagnostic,
  type ConditionVerification,
  type EffectType,
  type ModuleCompileContext,
  type ModuleCompileResult,
  type ModuleCondition,
  type ModuleContent,
  type Step,
} from '@cairn/shared'
import { compileScenarioDocument } from './compiler.js'

const EFFECT_LEVEL: Record<EffectType, number> = {
  READ_ONLY: 0,
  IDEMPOTENT: 1,
  SIDE_EFFECT: 2,
}

/** 交互性步骤类型：这些步骤可能产生页面变化，需要更强的后置验证。 */
const INTERACTIVE_STEP_TYPES = new Set([
  'fill', 'click', 'select', 'keyboard', 'ai_action',
])

function addDiag(
  diagnostics: CompileDiagnostic[],
  code: string,
  severity: 'error' | 'warning',
  message: string,
  extra?: Partial<Pick<CompileDiagnostic, 'stepId' | 'fieldPath'>>,
): void {
  diagnostics.push({ code, severity, message, ...extra })
}

function compileDiagnosticCode(issue: { path: PropertyKey[]; message: string }): string {
  if (issue.path.length === 1 && issue.path[0] === 'implementations') return 'MODULE_IMPLEMENTATION_COUNT'
  if (issue.path.includes('implementationKey') && issue.message.includes('重复')) return 'MODULE_IMPLEMENTATION_KEY_DUPLICATE'
  if (issue.message.includes('ai_action 不允许自动重试')) return 'SCENARIO_AI_RETRY_FORBIDDEN'
  return 'MODULE_SCHEMA_INVALID'
}

export function compileModuleContent(
  content: ModuleContent,
  ctx: ModuleCompileContext,
): ModuleCompileResult {
  const parsed = moduleContentSchema.safeParse(content)
  if (!parsed.success) {
    return {
      ok: false, executionMode: 'DETERMINISTIC',
      diagnostics: parsed.error.issues.map((issue) => ({
        code: compileDiagnosticCode(issue),
        severity: 'error', message: issue.message.slice(0, 512),
        fieldPath: issue.path.map((part) => String(part).slice(0, 64)).slice(0, 8),
      })),
    }
  }
  const { contract, implementations } = parsed.data
  const diagnostics: CompileDiagnostic[] = []
  const release = ctx.mode === 'release'
  const add = (code: string, severity: 'error' | 'warning', message: string, fieldPath: string[], stepId?: string) =>
    addDiag(diagnostics, code, severity, message.slice(0, 512), { fieldPath: fieldPath.map((part) => part.slice(0, 64)).slice(0, 8), ...(stepId ? { stepId } : {}) })
  const unusedInputs = new Set(contract.inputs.map((input) => input.key))

  for (const [implIndex, impl] of implementations.entries()) {
    const steps = impl.steps
    const implPath = ['implementations', String(implIndex)]
    const stepPath = (index: number, field: string) => [...implPath, 'steps', String(index), field]
    if (!steps.length && release) {
      add('MODULE_IMPLEMENTATION_EMPTY', 'error', `发布时实现「${impl.implementationKey}」不能没有步骤`, [...implPath, 'steps'])
    }
    if (steps.length) {
      const document = scenarioDefinitionFromSteps(steps, contract.inputs.map(({ key, label }) => ({ key, label })))
      const result = compileScenarioDocument(document, ctx)
      diagnostics.push(...result.diagnostics.filter((d) => d.code !== 'SCENARIO_INPUT_UNUSED').map((d) => ({
        ...d,
        fieldPath: d.stepId
          ? [...stepPath(steps.findIndex((s) => s.id === d.stepId), 'input'), ...(d.fieldPath ?? [])].slice(0, 8)
          : d.fieldPath ?? ['contract', 'inputs'],
      })))
    }
    const declaredInputs = new Set(contract.inputs.map((i) => i.key))
    const available = new Set(declaredInputs)
    steps.forEach((step, index) => {
      if (EFFECT_LEVEL[step.effectType] > EFFECT_LEVEL[contract.effectCeiling]) {
        add('MODULE_EFFECT_EXCEEDS_CEILING', 'error', `实现「${impl.implementationKey}」步骤「${step.name}」副作用超过模块上限`, stepPath(index, 'effectType'), step.id)
      }
      const from = stepFrom(step)
      if (from) {
        if (declaredInputs.has(from)) unusedInputs.delete(from)
        if (!available.has(from)) add('MODULE_INPUT_UNDECLARED', 'error', `引用「${from}」不是模块输入或更早步骤的输出`, [...stepPath(index, 'input'), 'from'], step.id)
      }
      if (step.outputKey) available.add(step.outputKey)
    })
    const outputStep = (key: string) => {
      const mapping = impl.outputMapping
      return Object.hasOwn(mapping, key) ? steps.find((s) => s.outputKey === mapping[key]) : undefined
    }
    contract.outputs.forEach((output, index) => {
      if (!outputStep(output.key)) {
        add('MODULE_OUTPUT_UNMAPPED', 'error', `实现「${impl.implementationKey}」未映射输出「${output.key}」`, ['contract', 'outputs', String(index)])
      }
    })
    for (const key of Object.keys(impl.outputMapping)) {
      if (!contract.outputs.some((o) => o.key === key)) {
        add('MODULE_OUTPUT_UNMAPPED', 'error', `映射「${key}」不是已声明的模块输出`, [...implPath, 'outputMapping', key])
      }
    }
    if (impl.preconditionBindings && impl.preconditionBindings.length !== contract.preconditions.length) {
      add('MODULE_CONDITION_STEP_INVALID', 'error', `实现「${impl.implementationKey}」前置条件绑定数量必须与契约一致`, [...implPath, 'preconditionBindings'])
    }
    if (impl.postconditionBindings && impl.postconditionBindings.length !== contract.postconditions.length) {
      add('MODULE_CONDITION_STEP_INVALID', 'error', `实现「${impl.implementationKey}」后置条件绑定数量必须与契约一致`, [...implPath, 'postconditionBindings'])
    }
    const verificationAt = (condition: ModuleCondition, index: number, bindings?: ConditionVerification[]) =>
      bindings?.[index] ?? condition.verification
    const conditionIndex = (condition: ModuleCondition, verification: ConditionVerification): number => {
      if (verification.kind === 'step') return steps.findIndex((s) => s.id === verification.stepId && (s.type === 'assert' || s.type === 'ai_assert'))
      if (verification.kind === 'output_required') {
        if (!contract.outputs.some((o) => o.key === verification.outputKey)) return -1
        const step = outputStep(verification.outputKey)
        return step ? steps.indexOf(step) : -1
      }
      return -1
    }
    const conditions: { condition: ModuleCondition; verification: ConditionVerification; path: string[] }[] = [
      ...contract.preconditions.map((condition, i) => ({
        condition,
        verification: verificationAt(condition, i, impl.preconditionBindings),
        path: impl.preconditionBindings ? [...implPath, 'preconditionBindings', String(i)] : ['contract', 'preconditions', String(i)],
      })),
      ...contract.postconditions.map((condition, i) => ({
        condition,
        verification: verificationAt(condition, i, impl.postconditionBindings),
        path: impl.postconditionBindings ? [...implPath, 'postconditionBindings', String(i)] : ['contract', 'postconditions', String(i)],
      })),
      ...(contract.entryState ? [{ condition: contract.entryState, verification: contract.entryState.verification, path: ['contract', 'entryState'] }] : []),
      ...(contract.exitState ? [{ condition: contract.exitState, verification: contract.exitState.verification, path: ['contract', 'exitState'] }] : []),
    ]
    for (const { condition, verification, path } of conditions) {
      if (verification.kind === 'manual_requirement') continue
      if (conditionIndex(condition, verification) < 0) add(
        verification.kind === 'step' ? 'MODULE_CONDITION_STEP_INVALID' : 'MODULE_CONDITION_OUTPUT_INVALID',
        'error', `实现「${impl.implementationKey}」条件「${condition.meaning}」必须引用有效断言或已映射的声明输出`, [...path, 'verification'],
      )
    }
    const postconditionOk = contract.postconditions.some((condition, index) =>
      conditionIndex(condition, verificationAt(condition, index, impl.postconditionBindings)) >= 0,
    )
    if (!postconditionOk) {
      add('MODULE_VERIFICATION_MISSING', release ? 'error' : 'warning', `实现「${impl.implementationKey}」后置条件缺少有效的可执行验证`, ['contract', 'postconditions'])
    }
    const firstWrite = steps.findIndex((s) => s.effectType !== 'READ_ONLY')
    if (contract.effectCeiling !== 'READ_ONLY' && !contract.preconditions.some((condition, index) => {
      const verification = verificationAt(condition, index, impl.preconditionBindings)
      const i = conditionIndex(condition, verification)
      return verification.kind === 'step' && i >= 0 && (firstWrite < 0 || i < firstWrite)
    })) {
      add('MODULE_PRECONDITION_MISSING', release ? 'error' : 'warning', `实现「${impl.implementationKey}」的非只读模块必须声明在副作用步骤之前执行的断言前置条件`, ['contract', 'preconditions'])
    }
    const lastInteractive = steps.reduce((last, step, i) => INTERACTIVE_STEP_TYPES.has(step.type) ? i : last, -1)
    if (lastInteractive >= 0 && !contract.postconditions.some((condition, conditionIndexValue) => {
      const verification = verificationAt(condition, conditionIndexValue, impl.postconditionBindings)
      const index = conditionIndex(condition, verification)
      if (index <= lastInteractive) return false
      if (verification.kind === 'output_required') return true
      return steps.slice(lastInteractive + 1, index).some((step) => step.type === 'wait' && step.input.kind === 'hidden')
    })) {
      add('MODULE_VERIFICATION_TOO_WEAK', release ? 'error' : 'warning', `实现「${impl.implementationKey}」交互后须提取必需输出，或等待加载指示消失后再执行后置断言`, ['contract', 'postconditions'])
    }
  }

  contract.inputs.forEach((input, index) => {
    if (unusedInputs.has(input.key)) add('MODULE_INPUT_UNUSED', 'warning', `输入「${input.label}」(${input.key}) 未被引用`, ['contract', 'inputs', String(index)])
  })
  return {
    ok: !diagnostics.some((d) => d.severity === 'error'),
    diagnostics,
    executionMode: deriveExecutionMode(implementations.flatMap((item) => item.steps)),
  }
}

/** 从步骤中提取 from 引用。 */
function stepFrom(step: Step): string | undefined {
  if (step.type === 'echo' || step.type === 'fill' || step.type === 'select') {
    return step.input.from
  }
  return undefined
}
