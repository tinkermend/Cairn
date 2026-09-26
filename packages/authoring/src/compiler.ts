import {
  COMPILER_VERSION,
  EXECUTABLE_STEP_TYPES,
  FACTORY_COMPILE_RESOLUTION,
  FORBIDDEN_CONTEXT_KEYS,
  LOCATOR_ROUTE_LABELS,
  LOCATOR_SKIP_LABELS,
  ScenarioValidationError,
  WAIT_KINDS_AVAILABLE_NOW,
  assertNoForwardFrom,
  mergeEffectiveResolution,
  locatorReadiness,
  resolveLocatorPlansForSteps,
  outputShapeForStep,
  policyAllowsAiRung,
  stepUsesBrowser,
  type CompileContext,
  type CompileDiagnostic,
  type CompileDiagnosticCode,
  type CompileResult,
  type OutcomeManifest,
  type OutcomeManifestEntry,
  type ScenarioDocument,
  type Step,
  type TargetDescriptor,
} from '@cairn/shared'
import { parse as parseYaml } from 'yaml'

export function validateAriaSnapshotTemplate(template: string): { valid: boolean; error?: string } {
  if (!template || template.trim().length === 0) {
    return { valid: false, error: '模板内容不能为空' }
  }
  try {
    const parsed = parseYaml(template)
    if (!Array.isArray(parsed)) {
      return { valid: false, error: 'aria_snapshot 模板根节点必须是列表（以 - 开头）' }
    }
    return { valid: true }
  } catch (err) {
    return {
      valid: false,
      error: `YAML 语法错误：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

type StepFromRef = {
  from: string
  fromField?: string
  fieldPath: string[]
}

function stepFromRefs(step: Step): StepFromRef[] {
  const refs: StepFromRef[] = []
  if (step.type === 'ai_action' && 'operation' in step.input && step.input.operation === 'input') {
    if (step.input.from) refs.push({ from: step.input.from, fromField: step.input.fromField, fieldPath: ['input', 'from'] })
  } else if (step.type === 'echo' || step.type === 'fill' || step.type === 'select') {
    if (step.input.from) refs.push({ from: step.input.from, fromField: step.input.fromField, fieldPath: ['input', 'from'] })
  } else if (step.type === 'upload') {
    for (const [idx, f] of step.input.files.entries()) {
      if (f.source === 'context') {
        const from = (f as any).from ?? (f as any).contextKey
        if (from) refs.push({ from, fromField: f.fromField, fieldPath: ['input', 'files', String(idx), 'from'] })
      }
    }
  }
  if (step.fieldRefs) {
    for (const [targetField, ref] of Object.entries(step.fieldRefs)) {
      refs.push({ from: ref.from, fromField: ref.fromField, fieldPath: ['fieldRefs', targetField] })
    }
  }
  return refs
}

function add(
  diagnostics: CompileDiagnostic[],
  code: CompileDiagnosticCode,
  severity: CompileDiagnostic['severity'],
  message: string,
  extra?: Pick<CompileDiagnostic, 'stepId' | 'inputKey' | 'fieldPath'>,
): void {
  diagnostics.push({ code, severity, message, ...extra })
}

function locatorSteps(step: Step): Extract<Step, { input: { target?: unknown } }>[] {
  if (step.disabled) return []
  if (
    step.type === 'click' ||
    step.type === 'fill' ||
    step.type === 'extract' ||
    step.type === 'assert' ||
    step.type === 'select' ||
    step.type === 'keyboard' ||
    step.type === 'wait' ||
    step.type === 'upload'
  ) {
    return [step]
  }
  if (step.type === 'download' && step.input.target) {
    return [step as Extract<Step, { input: { target?: unknown } }>]
  }
  return []
}

export function compileScenarioDocument(document: ScenarioDocument, ctx: CompileContext): CompileResult {
  const diagnostics: CompileDiagnostic[] = []
  const executable = ctx.executableTypes ?? EXECUTABLE_STEP_TYPES
  const release = ctx.mode === 'release'
  const resolution = {
    ...FACTORY_COMPILE_RESOLUTION,
    ...ctx.resolution,
    documentResolution: ctx.resolution?.documentResolution ?? document.resolution,
    documentLocatorPlan: ctx.resolution?.documentLocatorPlan ?? document.locatorPlan,
    locatorProtocol: ctx.resolution?.locatorProtocol ?? document.locatorProtocol,
    waitKindsAvailable: ctx.resolution?.waitKindsAvailable ?? WAIT_KINDS_AVAILABLE_NOW,
  }

  if (document.steps.length === 0) {
    add(diagnostics, 'SCENARIO_EMPTY', 'error', '场景至少需要一步')
  } else if (document.steps.every((step) => step.disabled)) {
    // 没有一步会执行，也就没有一步能成功：放行只会建出一条永远收不了尾的 Run。
    add(diagnostics, 'SCENARIO_ALL_STEPS_DISABLED', 'error', '所有步骤都已停用，至少启用一步才能试跑或发布')
  }

  const declared = new Set(document.inputs.map((input) => input.key))
  const usedInputs = new Set<string>()
  const available = new Set(declared)
  const outputShapes = new Map<string, ReturnType<typeof outputShapeForStep>>()
  const seenInputKeys = new Set<string>()
  const seenStepIds = new Set<string>()
  const seenOutputKeys = new Set<string>()
  const disabledOutputKeys = new Set<string>()

  for (const input of document.inputs) {
    if (seenInputKeys.has(input.key)) {
      add(diagnostics, 'SCENARIO_INPUT_KEY_DUPLICATE', 'error', `输入键「${input.key}」重复`, {
        inputKey: input.key,
      })
    }
    seenInputKeys.add(input.key)
    if ((FORBIDDEN_CONTEXT_KEYS as readonly string[]).includes(input.key)) {
      add(diagnostics, 'SCENARIO_INPUT_KEY_FORBIDDEN', 'error', `输入键「${input.key}」不得使用对象保留名`, {
        inputKey: input.key,
      })
    }
  }

  for (const step of document.steps) {
    if (step.disabled && step.outputKey) {
      disabledOutputKeys.add(step.outputKey)
    }
    if (seenStepIds.has(step.id)) {
      add(diagnostics, 'SCENARIO_STEP_ID_DUPLICATE', 'error', `步骤「${step.name}」的 id 与另一步重复`, {
        stepId: step.id,
      })
    }
    seenStepIds.add(step.id)
    if (step.outputKey) {
      if (seenOutputKeys.has(step.outputKey)) {
        add(diagnostics, 'SCENARIO_OUTPUT_KEY_DUPLICATE', 'error', `输出名称「${step.outputKey}」重复`, {
          stepId: step.id,
        })
      }
      seenOutputKeys.add(step.outputKey)
    }
    const requiresVisualModel = step.type === 'ai_action' || step.type === 'ai_extract' || step.type === 'ai_assert'
    if (requiresVisualModel && resolution.locatorDocument && !locatorReadiness(resolution.locatorDocument).visionReady) {
      add(diagnostics, 'SCENARIO_AI_UNAVAILABLE', 'error',
        `步骤「${step.name}」${step.type === 'ai_action' ? '是视觉操作' : '可能回退到视觉模型'}，请先在平台配置中启用并完善浏览器 AI 视觉模型及绑定密钥`,
        { stepId: step.id, fieldPath: ['type'] })
    } else if (!(executable as readonly string[]).includes(step.type)) {
      add(diagnostics, 'SCENARIO_UNKNOWN_STEP_TYPE', 'error', `步骤「${step.name}」的类型尚未开放`, {
        stepId: step.id,
      })
    }

    const refs = stepFromRefs(step)
    for (const { from, fromField, fieldPath } of refs) {
      if (declared.has(from)) usedInputs.add(from)
      if (!step.disabled && disabledOutputKeys.has(from)) {
        add(
          diagnostics,
          'SCENARIO_DISABLED_STEP_OUTPUT_REFERENCED',
          'warning',
          `步骤「${step.name}」引用的输出变量「${from}」来自已被禁用的步骤`,
          { stepId: step.id, inputKey: from, fieldPath },
        )
      }
      if (!available.has(from)) {
        add(
          diagnostics,
          'SCENARIO_UNRESOLVED_REF',
          release ? 'error' : 'warning',
          `步骤「${step.name}」的 from=${from} 不是已声明输入或更早步骤的 outputKey`,
          { stepId: step.id, inputKey: from, fieldPath },
        )
      } else {
        const shape = outputShapes.get(from)
        if (shape?.kind === 'list') {
          add(
            diagnostics,
            'SCENARIO_FROM_LIST_NOT_TEXT',
            'error',
            `步骤「${step.name}」引用的输出「${from}」是列表，不能直接作为文本使用`,
            { stepId: step.id, inputKey: from, fieldPath },
          )
        }
        if (shape?.kind === 'object' && !fromField) {
          add(
            diagnostics,
            'SCENARIO_FROM_FIELD_MISSING',
            'error',
            `步骤「${step.name}」的 from=${from} 是对象输出，必须指定 fromField`,
            { stepId: step.id, inputKey: from, fieldPath: [...fieldPath.slice(0, -1), 'fromField'] },
          )
        }
        if (fromField) {
          if (shape?.kind === 'object') {
            if (!shape.fields.some((field) => field.name === fromField)) {
              add(
                diagnostics,
                'SCENARIO_FROM_FIELD_UNKNOWN',
                'error',
                `步骤「${step.name}」的 fromField=${fromField} 不在 ${from} 的输出字段中`,
                { stepId: step.id, inputKey: from, fieldPath: [...fieldPath.slice(0, -1), 'fromField'] },
              )
            }
          } else if (shape && shape.kind !== 'unknown') {
            add(
              diagnostics,
              'SCENARIO_FROM_FIELD_UNKNOWN',
              'error',
              `步骤「${step.name}」的 from=${from} 不是对象，不能使用 fromField`,
              { stepId: step.id, inputKey: from, fieldPath: [...fieldPath.slice(0, -1), 'fromField'] },
            )
          }
        }
      }
    }
    if (step.outputKey) {
      available.add(step.outputKey)
      outputShapes.set(step.outputKey, outputShapeForStep(step))
    }
    if (step.type === 'loop') {
      const loopInput = step.input as any
      if (loopInput?.control?.type === 'for_each') {
        if (loopInput.control.as) {
          available.add(loopInput.control.as)
          outputShapes.set(loopInput.control.as, { kind: 'unknown' })
        }
        if (loopInput.control.indexAs) {
          available.add(loopInput.control.indexAs)
          outputShapes.set(loopInput.control.indexAs, { kind: 'scalar', type: 'number' })
        }
      }
      for (const rule of loopInput?.collect ?? []) {
        if (rule.into) {
          available.add(rule.into)
          outputShapes.set(rule.into, { kind: 'list', item: { kind: 'scalar', type: 'json' } })
        }
      }
    }

    if ((step.type === 'extract' || step.type === 'ai_extract') && !step.outputKey) {
      add(diagnostics, 'SCENARIO_EXTRACT_NO_OUTPUT_KEY', 'warning', `提取步骤「${step.name}」没有 outputKey，后续步骤无法引用`, {
        stepId: step.id,
      })
    }
    if (step.type === 'ai_action' && (step.policy?.retryLimit ?? 0) > 0) {
      add(diagnostics, 'SCENARIO_AI_RETRY_FORBIDDEN', 'error', `步骤「${step.name}」是视觉操作，不允许自动重试`, {
        stepId: step.id,
        fieldPath: ['policy', 'retryLimit'],
      })
    }

    if (
      (step.type === 'ai_action' || step.type === 'ai_extract' || step.type === 'ai_assert') &&
      'contextBindings' in step &&
      Array.isArray((step as any).contextBindings)
    ) {
      const bindings = (step as any).contextBindings
      const seenBindingNames = new Set<string>()
      const RESERVED_NAMES = new Set([
        '__proto__',
        'constructor',
        'prototype',
        'context',
        'steps',
        'input',
        'scenario',
        'document',
        'window',
        'env',
      ])

      for (const binding of bindings) {
        if (!binding.name || typeof binding.name !== 'string') {
          add(diagnostics, 'SCENARIO_AI_CONTEXT_BINDING_INVALID', 'error', `步骤「${step.name}」的 contextBindings 缺少有效绑定名`, {
            stepId: step.id,
          })
          continue
        }
        if (seenBindingNames.has(binding.name)) {
          add(
            diagnostics,
            'SCENARIO_AI_CONTEXT_BINDING_INVALID',
            'error',
            `步骤「${step.name}」的 contextBindings 包含重复的绑定名「${binding.name}」`,
            { stepId: step.id },
          )
        }
        seenBindingNames.add(binding.name)

        if (RESERVED_NAMES.has(binding.name)) {
          add(
            diagnostics,
            'SCENARIO_AI_CONTEXT_BINDING_INVALID',
            'error',
            `步骤「${step.name}」的绑定名「${binding.name}」与系统保留字段冲突`,
            { stepId: step.id },
          )
        }

        if (
          binding.path &&
          (binding.path.includes('__proto__') ||
            binding.path.includes('constructor') ||
            binding.path.includes('prototype'))
        ) {
          add(
            diagnostics,
            'SCENARIO_AI_CONTEXT_BINDING_INVALID',
            'error',
            `步骤「${step.name}」的绑定「${binding.name}」path 包含非法的原型属性`,
            { stepId: step.id },
          )
        }

        const source = binding.source
        if (typeof source !== 'string') {
          add(diagnostics, 'SCENARIO_AI_CONTEXT_BINDING_INVALID', 'error', `步骤「${step.name}」的绑定「${binding.name}」缺少有效 source`, {
            stepId: step.id,
          })
          continue
        }

        if (source.startsWith('input.')) {
          const inputKey = source.slice('input.'.length).split('.')[0]
          if (!inputKey || (declared.size > 0 && !declared.has(inputKey))) {
            add(
              diagnostics,
              'SCENARIO_AI_CONTEXT_BINDING_UNRESOLVED',
              release ? 'error' : 'warning',
              `步骤「${step.name}」的 contextBindings 引用了未定义的场景输入「${inputKey ?? ''}」`,
              { stepId: step.id },
            )
          } else {
            usedInputs.add(inputKey)
          }
        } else if (source.startsWith('steps.')) {
          const parts = source.slice('steps.'.length).split('.')
          const targetStepId = parts[0]
          // seenStepIds contains previous steps up to and including current step, so check targetStepId !== step.id
          if (!targetStepId || !seenStepIds.has(targetStepId) || targetStepId === step.id) {
            add(
              diagnostics,
              'SCENARIO_AI_CONTEXT_BINDING_UNRESOLVED',
              release ? 'error' : 'warning',
              `步骤「${step.name}」的 contextBindings 引用了不存在或后置的步骤「${targetStepId ?? ''}」`,
              { stepId: step.id },
            )
          }
        } else {
          add(
            diagnostics,
            'SCENARIO_AI_CONTEXT_BINDING_INVALID',
            'error',
            `步骤「${step.name}」的绑定「${binding.name}」source 格式非法，须以 input. 或 steps. 开头`,
            { stepId: step.id },
          )
        }
      }
    }

    if (step.type === 'wait' && step.input.kind === 'semantic') {
      const available = resolution.waitKindsAvailable ?? WAIT_KINDS_AVAILABLE_NOW
      if (!available.includes('semantic')) {
        add(
          diagnostics,
          'SCENARIO_WAIT_KIND_UNAVAILABLE',
          release ? 'error' : 'warning',
          `步骤「${step.name}」的语义等待尚未开放运行时`,
          { stepId: step.id, fieldPath: ['input', 'kind'] },
        )
      }
    }

    if (step.type === 'assert' && step.input.expect.kind === 'aria_snapshot') {
      const res = validateAriaSnapshotTemplate(step.input.expect.template)
      if (!res.valid) {
        add(
          diagnostics,
          'SCENARIO_ASSERT_TEMPLATE_INVALID',
          'error',
          `步骤「${step.name}」的 ${res.error}`,
          { stepId: step.id, fieldPath: ['input', 'expect', 'template'] },
        )
      }
    }

    for (const located of locatorSteps(step)) {
      const target = 'target' in located.input ? located.input.target : undefined
      addTargetResolutionDiagnostics(diagnostics, located, target, resolution, release)
    }
  }

  try {
    assertNoForwardFrom(document.steps)
  } catch (error) {
    if (error instanceof ScenarioValidationError) {
      const step = document.steps.find((item) => error.message.includes(`「${item.name}」`))
      add(diagnostics, 'SCENARIO_FORWARD_REF', 'error', error.message, step ? { stepId: step.id } : undefined)
    } else {
      throw error
    }
  }

  const unusedReported = new Set<string>()
  for (const input of document.inputs) {
    if (!usedInputs.has(input.key) && !unusedReported.has(input.key)) {
      unusedReported.add(input.key)
      add(diagnostics, 'SCENARIO_INPUT_UNUSED', 'warning', `声明的输入「${input.label}」没有被任何步骤引用`, {
        inputKey: input.key,
      })
    }
  }

  if (document.outputs) {
    if (document.outputs.metrics) {
      for (const m of document.outputs.metrics) {
        if (!available.has(m.fromContextKey)) {
          add(
            diagnostics,
            'OUTPUT_VARIABLE_UNRESOLVED',
            'warning',
            `业务输出指标「${m.name}」引用的变量「${m.fromContextKey}」未在输入或任何步骤的 outputKey 中定义`,
            { fieldPath: ['outputs', 'metrics', m.key, 'fromContextKey'] },
          )
        }
      }
    }
    if (document.outputs.dataRowFields) {
      for (const f of document.outputs.dataRowFields) {
        if (!available.has(f.fromContextKey)) {
          add(
            diagnostics,
            'OUTPUT_VARIABLE_UNRESOLVED',
            'warning',
            `业务输出数据列「${f.columnHeader}」引用的变量「${f.fromContextKey}」未在输入或任何步骤的 outputKey 中定义`,
            { fieldPath: ['outputs', 'dataRowFields', f.columnKey, 'fromContextKey'] },
          )
        }
      }
    }
    if (document.outputs.summaryFromContextKey && !available.has(document.outputs.summaryFromContextKey)) {
      add(
        diagnostics,
        'OUTPUT_VARIABLE_UNRESOLVED',
        'warning',
        `业务输出结论引用的变量「${document.outputs.summaryFromContextKey}」未在输入或任何步骤的 outputKey 中定义`,
        { fieldPath: ['outputs', 'summaryFromContextKey'] },
      )
    }
    if (document.outputs.summaryTemplate) {
      const matches = document.outputs.summaryTemplate.matchAll(/\$\{([^}]+)\}/g)
      for (const match of matches) {
        const token = match[1]
        if (!token || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(token)) {
          add(
            diagnostics,
            'OUTPUT_VARIABLE_UNRESOLVED',
            release ? 'error' : 'warning',
            `业务输出结论模板包含非法的变量插值「\${${token}}」`,
            { fieldPath: ['outputs', 'summaryTemplate'] },
          )
        } else if (!available.has(token)) {
          add(
            diagnostics,
            'OUTPUT_VARIABLE_UNRESOLVED',
            release ? 'error' : 'warning',
            `业务输出结论模板引用的变量「${token}」未在输入或任何步骤的 outputKey 中定义`,
            { fieldPath: ['outputs', 'summaryTemplate'] },
          )
        }
      }
    }
  }

  addOutcomeCoverageDiagnostics(diagnostics, document, ctx.outcomeManifest, release)

  if (ctx.target) {
    if (!ctx.target.exists) {
      add(diagnostics, 'SCENARIO_TARGET_MISSING', 'error', '绑定的目标系统不存在')
    } else if (ctx.target.status === 'disabled') {
      add(diagnostics, 'SCENARIO_TARGET_DISABLED', release ? 'error' : 'warning', '绑定的目标系统已停用')
    }
  }

  return {
    ok: diagnostics.every((item) => item.severity !== 'error'),
    compilerVersion: COMPILER_VERSION,
    definition: document,
    diagnostics,
  }
}

function synthesizedOutcomeEntries(document: ScenarioDocument): OutcomeManifestEntry[] {
  return document.steps
    .filter((step) => !step.disabled)
    .filter((step) => step.type === 'assert' || step.type === 'ai_assert')
    .map((step) => ({
      contractId: step.id,
      scope: 'step' as const,
      meaning: step.name,
      severity: 'MUST' as const,
      onViolation: 'halt' as const,
      provenance: 'legacy_assert' as const,
      stepId: step.id,
      rule:
        step.type === 'assert'
          ? {
              kind: 'deterministic' as const,
              ...(step.input.target ? { target: step.input.target } : {}),
              expect: step.input.expect,
            }
          : { kind: 'ai' as const, instruction: step.input.instruction },
    }))
}

function addOutcomeTargetMissingDiagnostics(
  diagnostics: CompileDiagnostic[],
  entries: OutcomeManifestEntry[],
  release: boolean,
): void {
  for (const entry of entries) {
    if (entry.rule.kind !== 'deterministic') continue
    if (entry.rule.expect.kind === 'aria_snapshot') continue
    if (entry.rule.target) continue
    add(
      diagnostics,
      'OUTCOME_RULE_TARGET_MISSING',
      release ? 'error' : 'warning',
      `成功条件「${entry.meaning}」还没有从页面选择要检查的对象`,
      { stepId: entry.sourceStepId ?? entry.stepId },
    )
  }
}

function addOutcomeCoverageDiagnostics(
  diagnostics: CompileDiagnostic[],
  document: ScenarioDocument,
  manifest: OutcomeManifest | null | undefined,
  release: boolean,
): void {
  const hasBrowser = document.steps.some((step) => stepUsesBrowser(step.type))
  if (!hasBrowser) return

  if (manifest?.entries) {
    addOutcomeTargetMissingDiagnostics(diagnostics, manifest.entries, release)
  }
  const entries = manifest?.entries ?? synthesizedOutcomeEntries(document)
  if (entries.length === 0) {
    add(diagnostics, 'SCENARIO_NO_OUTCOME', 'warning', '含浏览器步骤的场景没有成功条件')
    return
  }

  const active = entries.filter((entry) => entry.severity !== 'INFO')
  if (active.length === 0) {
    add(diagnostics, 'SCENARIO_OUTCOME_INFO_ONLY', 'warning', '场景只有提示级成功条件，没有必须或应当成立的条件')
  }

  if (active.some((entry) => entry.scope === 'scenario')) return

  const indexByStepId = new Map(document.steps.map((step, index) => [step.id, index]))
  const coveringIndexes = active
    .map((entry) => {
      const source = entry.sourceStepId ? indexByStepId.get(entry.sourceStepId) : undefined
      const bound = indexByStepId.get(entry.stepId)
      if (source !== undefined && bound !== undefined) return Math.min(source, bound)
      return source ?? bound
    })
    .filter((index): index is number => index !== undefined)
  const lastCover = coveringIndexes.length > 0 ? Math.max(...coveringIndexes) : -1

  for (const [index, step] of document.steps.entries()) {
    if (step.disabled || !stepUsesBrowser(step.type) || step.effectType !== 'SIDE_EFFECT') continue
    if (lastCover < index) {
      add(
        diagnostics,
        'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME',
        'warning',
        `步骤「${step.name}」会改动页面，其后没有成功条件`,
        { stepId: step.id },
      )
    }
  }
}

function addTargetResolutionDiagnostics(
  diagnostics: CompileDiagnostic[],
  step: Step,
  target: TargetDescriptor | undefined,
  resolution: NonNullable<CompileContext['resolution']> & {
    ceiling: string
    default: string
    waitKindsAvailable?: readonly string[]
  },
  release: boolean,
): void {
  if (!target) return
  if (step.type === 'assert' && (resolution.locatorProtocol === 2 || resolution.documentLocatorPlan || step.policy?.locatorPlan)) {
    if (target && target.candidates.length === 0) add(diagnostics, 'SCENARIO_TARGET_EMPTY', release ? 'error' : 'warning',
      `步骤「${step.name}」的成功条件只使用规则判定，请提供规则候选`,
      { stepId: step.id, fieldPath: ['input', 'target', 'candidates'] })
    return
  }
  if ((resolution.locatorProtocol === 2 || resolution.documentLocatorPlan || step.policy?.locatorPlan) && resolution.locatorDocument) {
    let plan
    try {
      plan = resolveLocatorPlansForSteps({
        steps: [step],
        document: resolution.locatorDocument,
        target: resolution.locatorTarget,
        scenarioPlan: resolution.documentLocatorPlan,
        scenarioPolicy: resolution.documentResolution,
      })[step.id]!
    } catch (error) {
      add(diagnostics, 'SCENARIO_LOCATOR_UNAVAILABLE', release ? 'error' : 'warning',
        `步骤「${step.name}」定位方式不可用：${error instanceof Error ? error.message : '请检查模型配置'}`,
        { stepId: step.id, fieldPath: ['policy', 'locatorPlan'] })
      return
    }
    for (const skipped of plan.skipped) {
      add(diagnostics, 'SCENARIO_LOCATOR_SKIPPED', 'warning',
        `步骤「${step.name}」继承的${LOCATOR_ROUTE_LABELS[skipped.route]}定位路线已跳过：${LOCATOR_SKIP_LABELS[skipped.reason]}`,
        { stepId: step.id, fieldPath: ['policy', 'locatorPlan'] })
    }
    if (!target) return
    const usesModel = plan.actual.some((route) => route !== 'rule')
    const hasRules = target.candidates.length > 0
    if (plan.actual.includes('rule') && !hasRules) {
      add(diagnostics, 'SCENARIO_TARGET_EMPTY', release ? 'error' : 'warning',
        `步骤「${step.name}」的定位顺序包含规则，但没有规则定位候选`,
        { stepId: step.id, fieldPath: ['input', 'target', 'candidates'] })
    }
    if (usesModel && !target.semantic?.trim() && (!hasRules || target.candidates.every((candidate) => candidate.by === 'css'))) {
      add(diagnostics, 'SCENARIO_MODEL_DESCRIPTION_REQUIRED', 'error',
        `步骤「${step.name}」请填写「要找的页面元素」；仅有 CSS 无法作为模型目标描述`,
        { stepId: step.id, fieldPath: ['input', 'target', 'semantic'] })
    }
    if (usesModel && (step.effectType === 'SIDE_EFFECT' || step.effectType === 'IDEMPOTENT')) {
      const identity = target.candidates.some((candidate) =>
        candidate.by === 'role' ? Boolean(candidate.name?.trim())
          : candidate.by === 'label' || candidate.by === 'text' || candidate.by === 'title' ? Boolean(candidate.value.trim()) : false)
      const pureModel = Boolean(step.policy?.locatorPlan && step.policy.locatorPlan.order.every((route) => route !== 'rule'))
      if (!identity) add(diagnostics, 'SCENARIO_MODEL_WRITE_IDENTITY_REQUIRED', pureModel ? 'warning' : release ? 'error' : 'warning',
        pureModel
          ? `步骤「${step.name}」显式选择纯模型写操作，缺少独立身份核对；请填写明确目标描述并检查运行证据`
          : `步骤「${step.name}」缺少可核对的角色名称或可见文字，模型定位后会阻止写操作`,
        { stepId: step.id, fieldPath: ['input', 'target', 'candidates'] })
    }
    return
  }
  const explicit = step.policy?.resolution ?? resolution.documentResolution
  const effective = mergeEffectiveResolution({
    ceiling: resolution.ceiling,
    defaultResolution: resolution.default,
    targetCeiling: resolution.targetCeiling,
    targetPreference: resolution.targetPreference,
    document: resolution.documentResolution,
    step: step.policy?.resolution,
  })

  if (explicit === 'ai_only' && effective !== 'ai_only') {
    add(
      diagnostics,
      'SCENARIO_RESOLUTION_EXCEEDS_CEILING',
      release ? 'error' : 'warning',
      `步骤「${step.name}」要求仅用 AI 解析，但当前平台或目标系统上限不允许`,
      { stepId: step.id, fieldPath: ['policy', 'resolution'] },
    )
  } else if (
    (explicit === 'prefer_deterministic' || explicit === 'prefer_ai') &&
    effective === 'deterministic_only'
  ) {
    add(
      diagnostics,
      'SCENARIO_RESOLUTION_DEGRADED',
      'warning',
      `步骤「${step.name}」的解析策略已被平台或目标系统上限降为仅规则`,
      { stepId: step.id, fieldPath: ['policy', 'resolution'] },
    )
  }

  if (!target) return
  const candidateCount = target.candidates?.length ?? 0
  if (candidateCount === 0 && !target.semantic) {
    add(
      diagnostics,
      'SCENARIO_TARGET_EMPTY',
      'error',
      `步骤「${step.name}」缺少定位候选和语义描述`,
      { stepId: step.id, fieldPath: ['input', 'target'] },
    )
    return
  }
  if (candidateCount === 0 && target.semantic) {
    const allowAi = policyAllowsAiRung(effective)
    add(
      diagnostics,
      'SCENARIO_TARGET_SEMANTIC_ONLY',
      release && !allowAi ? 'error' : 'warning',
      allowAi
        ? `步骤「${step.name}」只有语义描述，没有确定性候选`
        : `步骤「${step.name}」只有语义描述，当前部署无法解析该目标`,
      { stepId: step.id, fieldPath: ['input', 'target', 'semantic'] },
    )
    if (step.effectType === 'SIDE_EFFECT' || step.effectType === 'IDEMPOTENT') {
      if (effective === 'prefer_deterministic') {
        add(
          diagnostics,
          'SCENARIO_SIDE_EFFECT_SEMANTIC_ONLY',
          release ? 'error' : 'warning',
          `步骤「${step.name}」是写步骤且只有语义描述，规则优先下 AI 定位会被交叉确认拒绝`,
          { stepId: step.id, fieldPath: ['input', 'target', 'semantic'] },
        )
      } else if (effective === 'prefer_ai' || effective === 'ai_only') {
        add(
          diagnostics,
          'SCENARIO_SIDE_EFFECT_SEMANTIC_ONLY',
          'warning',
          `步骤「${step.name}」是写步骤且仅有语义描述，AI 定位没有交叉确认`,
          { stepId: step.id, fieldPath: ['input', 'target', 'semantic'] },
        )
      }
    }
  }
  const candidates = target.candidates ?? []
  const hasSemanticLocator = candidates.some((candidate) => candidate.by !== 'css')
  if (candidates.length > 0 && !hasSemanticLocator) {
    add(
      diagnostics,
      'SCENARIO_WEAK_LOCATOR',
      'warning',
      `步骤「${step.name}」只用 CSS 定位，缺少 role / label / text 等语义候选`,
      { stepId: step.id },
    )
  }
}
