import { type OutputShape } from './output-schema.js'
import { type Step } from './step.js'
import {
  scenarioDocumentSchema,
  type CompileDiagnostic,
  type ScenarioDocument,
  type ScenarioStatus,
} from './scenario.js'

export const COMPILER_VERSION = 3 as const

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
  'SCENARIO_FROM_FIELD_MISSING',
  'SCENARIO_FROM_FIELD_UNKNOWN',
  'SCENARIO_AI_RETRY_FORBIDDEN',
  'MODULE_VERSION_UNAVAILABLE',
  'MODULE_TARGET_MISMATCH',
  'MODULE_DIGEST_MISMATCH',
  'MODULE_VERSION_DEPRECATED',
  'MODULE_VERSION_WITHDRAWN',
  'MODULE_DRAFT_REFERENCE_NOT_PUBLISHABLE',
  'MODULE_NESTING_FORBIDDEN',
  'MODULE_INPUT_UNBOUND',
  'MODULE_INPUT_TYPE_MISMATCH',
  'MODULE_BINDING_UNSUPPORTED',
  'SCENARIO_EXPANDED_STEP_LIMIT',
  'SCENARIO_COMPILE_ERROR',
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

export function outputShapeForStep(step: Step): OutputShape {
  if (step.type === 'ai_extract') {
    const schema = step.input.outputSchema
    if (schema.kind === 'scalar') return { kind: 'scalar', type: schema.type }
    return {
      kind: 'object',
      fields: schema.fields.map((field) => ({
        name: field.name,
        type: field.type,
        required: field.required !== false,
      })),
    }
  }
  if (step.type === 'ai_assert') {
    return {
      kind: 'object',
      fields: [
        { name: 'passed', type: 'boolean', required: true },
        { name: 'reason', type: 'string', required: true },
      ],
    }
  }
  if (step.type === 'extract' || step.type === 'echo') return { kind: 'scalar', type: 'json' }
  return { kind: 'unknown' }
}

export function parseScenarioDocument(input: unknown): ScenarioDocument {
  return scenarioDocumentSchema.parse(input)
}
