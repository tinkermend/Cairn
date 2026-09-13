import { FORBIDDEN_CONTEXT_KEYS } from './run.js'
import { EXECUTABLE_STEP_TYPES, isBrowserStepType, type Step } from './step.js'
import {
  assertNoForwardFrom,
  ScenarioValidationError,
  scenarioDocumentSchema,
  type CompileDiagnostic,
  type ScenarioDocument,
  type ScenarioStatus,
} from './scenario.js'

export const COMPILER_VERSION = 1 as const

export const COMPILE_DIAGNOSTIC_CODES = [
  'SCENARIO_EMPTY',
  'SCENARIO_STEP_ID_DUPLICATE',
  'SCENARIO_OUTPUT_KEY_DUPLICATE',
  'SCENARIO_FORWARD_REF',
  'SCENARIO_UNRESOLVED_REF',
  'SCENARIO_INPUT_KEY_DUPLICATE',
  'SCENARIO_INPUT_KEY_FORBIDDEN',
  'SCENARIO_UNKNOWN_STEP_TYPE',
  'SCENARIO_TARGET_MISSING',
  'SCENARIO_TARGET_DISABLED',
  'SCENARIO_WEAK_LOCATOR',
  'SCENARIO_EXTRACT_NO_OUTPUT_KEY',
  'SCENARIO_INPUT_UNUSED',
  'SCENARIO_NO_ASSERT',
] as const
export type CompileDiagnosticCode = (typeof COMPILE_DIAGNOSTIC_CODES)[number]

export type CompileMode = 'save' | 'release'

export type CompileTargetContext = {
  exists: boolean
  status: ScenarioStatus | 'active' | 'disabled'
}

export type CompileContext = {
  mode: CompileMode
  target?: CompileTargetContext | null
  executableTypes?: readonly string[]
}

export type CompileResult = {
  ok: boolean
  compilerVersion: typeof COMPILER_VERSION
  definition: ScenarioDocument
  diagnostics: CompileDiagnostic[]
}

function stepFrom(step: Step): string | undefined {
  if (step.type === 'echo' || step.type === 'fill') return step.input.from
  return undefined
}

function add(
  diagnostics: CompileDiagnostic[],
  code: CompileDiagnosticCode,
  severity: CompileDiagnostic['severity'],
  message: string,
  extra?: Pick<CompileDiagnostic, 'stepId' | 'inputKey'>,
): void {
  diagnostics.push({ code, severity, message, ...extra })
}

function locatorSteps(step: Step): Extract<Step, { input: { target?: unknown } }>[] {
  if (step.type === 'click' || step.type === 'fill' || step.type === 'extract' || step.type === 'assert') {
    return [step]
  }
  return []
}

export function parseScenarioDocument(input: unknown): ScenarioDocument {
  return scenarioDocumentSchema.parse(input)
}

export function compileScenarioDocument(document: ScenarioDocument, ctx: CompileContext): CompileResult {
  const diagnostics: CompileDiagnostic[] = []
  const executable = ctx.executableTypes ?? EXECUTABLE_STEP_TYPES
  const release = ctx.mode === 'release'

  if (document.steps.length === 0) {
    add(diagnostics, 'SCENARIO_EMPTY', 'error', '场景至少需要一步')
  }

  const declared = new Set(document.inputs.map((input) => input.key))
  const usedInputs = new Set<string>()
  const available = new Set(declared)
  const seenInputKeys = new Set<string>()
  const seenStepIds = new Set<string>()
  const seenOutputKeys = new Set<string>()

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
    if (!(executable as readonly string[]).includes(step.type)) {
      add(diagnostics, 'SCENARIO_UNKNOWN_STEP_TYPE', 'error', `步骤「${step.name}」的类型尚未开放`, {
        stepId: step.id,
      })
    }

    const from = stepFrom(step)
    if (from) {
      if (declared.has(from)) usedInputs.add(from)
      if (!available.has(from)) {
        add(
          diagnostics,
          'SCENARIO_UNRESOLVED_REF',
          release ? 'error' : 'warning',
          `步骤「${step.name}」的 from=${from} 不是已声明输入或更早步骤的 outputKey`,
          { stepId: step.id, inputKey: from },
        )
      }
    }
    if (step.outputKey) available.add(step.outputKey)

    if (step.type === 'extract' && !step.outputKey) {
      add(diagnostics, 'SCENARIO_EXTRACT_NO_OUTPUT_KEY', 'warning', `提取步骤「${step.name}」没有 outputKey，后续步骤无法引用`, {
        stepId: step.id,
      })
    }

    for (const located of locatorSteps(step)) {
      const target = 'target' in located.input ? located.input.target : undefined
      if (!target) continue
      const semantic = target.candidates.some((candidate) => candidate.by !== 'css')
      if (!semantic) {
        add(
          diagnostics,
          'SCENARIO_WEAK_LOCATOR',
          'warning',
          `步骤「${located.name}」只用 CSS 定位，缺少 role / label / text 等语义候选`,
          { stepId: located.id },
        )
      }
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

  if (document.steps.some((step) => isBrowserStepType(step.type)) && !document.steps.some((step) => step.type === 'assert')) {
    add(diagnostics, 'SCENARIO_NO_ASSERT', 'warning', '含浏览器步骤的场景没有断言')
  }

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
