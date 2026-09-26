import { type OutcomeManifest } from './outcome.js'
import { type OutputShape, type ListItemOutputShape } from './output-schema.js'
import { type CompileResolutionContext } from './resolution.js'
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
  'SCENARIO_TARGET_EMPTY',
  'SCENARIO_TARGET_SEMANTIC_ONLY',
  'SCENARIO_RESOLUTION_EXCEEDS_CEILING',
  'SCENARIO_RESOLUTION_DEGRADED',
  'SCENARIO_LOCATOR_UNAVAILABLE',
  'SCENARIO_AI_UNAVAILABLE',
  'SCENARIO_LOCATOR_SKIPPED',
  'SCENARIO_MODEL_DESCRIPTION_REQUIRED',
  'SCENARIO_MODEL_WRITE_IDENTITY_REQUIRED',
  'SCENARIO_SIDE_EFFECT_SEMANTIC_ONLY',
  'SCENARIO_WAIT_KIND_UNAVAILABLE',
  'SCENARIO_ASSERT_TEMPLATE_INVALID',
  'SCENARIO_EXTRACT_NO_OUTPUT_KEY',
  'SCENARIO_INPUT_UNUSED',
  'SCENARIO_NO_ASSERT',
  'SCENARIO_NO_OUTCOME',
  'SCENARIO_OUTCOME_INFO_ONLY',
  'SCENARIO_SIDE_EFFECT_WITHOUT_OUTCOME',
  'OUTCOME_RULE_TARGET_MISSING',
  'OUTCOME_CONTRACT_INVALID',
  'RUNTIME_INVARIANT_INVALID',
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
  'OUTPUT_VARIABLE_UNRESOLVED',
  'SCENARIO_AI_CONTEXT_BINDING_INVALID',
  'SCENARIO_AI_CONTEXT_BINDING_UNRESOLVED',
  'SCENARIO_DISABLED_STEP_OUTPUT_REFERENCED',
  'SCENARIO_FROM_LIST_NOT_TEXT',
  'SCENARIO_ALL_STEPS_DISABLED',
  'SCENARIO_COMPILE_ERROR',
  'EXPR_TYPE_MISMATCH',
  'SCENARIO_LOOP_MODULE_UNSUPPORTED',
  'SCENARIO_LOOP_NESTING_UNSUPPORTED',
  'SCENARIO_VARIABLE_NAME_CONFLICT',
  'SCENARIO_LOOP_OUTPUT_OUT_OF_SCOPE',
  'SCENARIO_LOOP_BUDGET_EXCEEDED',
  'LOOP_STEP_NOT_AUTHORABLE',
  'LOOP_INPUT_INVALID',
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
  /** 传入后按成功条件语义诊断；缺省时从扁平 assert / ai_assert 步合成 */
  outcomeManifest?: OutcomeManifest | null
  /** 平台上限、目标系统优先顺序与场景/步骤档位；缺省按出厂 deterministic_only 上限解释 */
  resolution?: CompileResolutionContext
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
    if (schema.kind === 'list') {
      const item: ListItemOutputShape =
        schema.item.kind === 'scalar'
          ? { kind: 'scalar', type: schema.item.type }
          : {
              kind: 'object',
              fields: schema.item.fields.map((field) => ({
                name: field.name,
                type: field.type,
                required: field.required !== false,
              })),
            }
      return {
        kind: 'list',
        item,
        maxItems: schema.maxItems,
      }
    }
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
  if (step.type === 'upload') {
    return {
      kind: 'object',
      fields: [
        { name: 'files', type: 'json', required: true },
        { name: 'method', type: 'string', required: true },
        { name: 'uploadedAt', type: 'string', required: true },
      ],
    }
  }
  if (step.type === 'extract') {
    if (step.input.many) {
      return {
        kind: 'list',
        item: { kind: 'scalar', type: 'string' },
        maxItems: step.input.many.maxItems,
      }
    }
    return { kind: 'scalar', type: 'json' }
  }
  if (step.type === 'download' || step.type === 'echo') {
    return { kind: 'scalar', type: 'json' }
  }
  return { kind: 'unknown' }
}

export function parseScenarioDocument(input: unknown): ScenarioDocument {
  return scenarioDocumentSchema.parse(input)
}
