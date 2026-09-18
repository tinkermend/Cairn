import { z } from 'zod'
import {
  foldOutcomeVerdicts,
  outcomeOnViolationSchema,
  outcomeSeveritySchema,
  type OutcomeOnViolation,
  type OutcomeResultDto,
  type OutcomeSeverity,
  type OutcomeStatus,
  type OutcomeVerdict,
} from './outcome.js'
import { effectTypeSchema, type EffectType } from './step.js'
import { entityIdSchema, type JsonValue } from './wire.js'

export const RUNTIME_INVARIANT_MANIFEST_PROTOCOL = 'snapshot.runtimeInvariantManifest@1'

export const RUNTIME_INVARIANT_KINDS = [
  'navigation_boundary',
  'auth_validity',
  'effect_ceiling',
  'readonly_guarantee',
  'error_surface',
] as const
export type RuntimeInvariantKind = (typeof RUNTIME_INVARIANT_KINDS)[number]
export const runtimeInvariantKindSchema = z.enum(RUNTIME_INVARIANT_KINDS)

export const RUNTIME_INVARIANT_EVALUATE_ATS = [
  'step_boundary',
  'before_side_effect',
  'each_step',
] as const
export type RuntimeInvariantEvaluateAt = (typeof RUNTIME_INVARIANT_EVALUATE_ATS)[number]
export const runtimeInvariantEvaluateAtSchema = z.enum(RUNTIME_INVARIANT_EVALUATE_ATS)

export const NAVIGATION_BOUNDARY_ERROR_CODES = [
  'NAVIGATE_OUT_OF_SCOPE',
  'PAGE_HANDOFF_OUT_OF_SCOPE',
] as const

export const EFFECT_TYPE_LEVEL: Record<EffectType, number> = {
  READ_ONLY: 0,
  IDEMPOTENT: 1,
  SIDE_EFFECT: 2,
}

export function effectTypeExceedsCeiling(actual: EffectType, ceiling: EffectType): boolean {
  return EFFECT_TYPE_LEVEL[actual] > EFFECT_TYPE_LEVEL[ceiling]
}

export function defaultEvaluateAt(kind: RuntimeInvariantKind): RuntimeInvariantEvaluateAt {
  if (kind === 'error_surface') return 'each_step'
  if (kind === 'effect_ceiling' || kind === 'readonly_guarantee') {
    return 'before_side_effect'
  }
  return 'step_boundary'
}

export function defaultInvariantSeverity(kind: RuntimeInvariantKind): OutcomeSeverity {
  return kind === 'auth_validity' ? 'SHOULD' : 'MUST'
}

export function defaultInvariantOnViolation(kind: RuntimeInvariantKind): OutcomeOnViolation {
  if (kind === 'navigation_boundary' || kind === 'error_surface') return 'halt'
  return 'continue'
}

export function defaultInvariantMeaning(kind: RuntimeInvariantKind): string {
  switch (kind) {
    case 'navigation_boundary':
      return '不得离开允许的访问范围'
    case 'auth_validity':
      return '运行期间登录保持有效'
    case 'effect_ceiling':
      return '副作用不得超过声明上限'
    case 'readonly_guarantee':
      return '本次巡检不得改写业务数据'
    case 'error_surface':
      return '不得出现系统错误弹窗'
  }
}

export const runtimeInvariantSchema = z
  .strictObject({
    id: entityIdSchema,
    meaning: z.string().trim().min(1).max(512),
    kind: runtimeInvariantKindSchema,
    severity: outcomeSeveritySchema,
    onViolation: outcomeOnViolationSchema,
    evaluateAt: runtimeInvariantEvaluateAtSchema,
  })
  .superRefine((invariant, ctx) => {
    if ((invariant.severity === 'SHOULD' || invariant.severity === 'INFO') && invariant.onViolation === 'halt') {
      ctx.addIssue({
        code: 'custom',
        path: ['onViolation'],
        message: `${invariant.severity} 运行期约束不允许配置 halt，只能配置 continue`,
      })
    }
    if (invariant.kind === 'error_surface' && invariant.evaluateAt === 'step_boundary') {
      ctx.addIssue({
        code: 'custom',
        path: ['evaluateAt'],
        message: '错误弹窗约束必须在步骤后或副作用前看页面，不能只配步骤边界',
      })
    }
  })
export type RuntimeInvariant = z.infer<typeof runtimeInvariantSchema>

export const runtimeInvariantManifestSchema = z.strictObject({
  entries: z.array(runtimeInvariantSchema),
})
export type RuntimeInvariantManifest = z.infer<typeof runtimeInvariantManifestSchema>

export function createRuntimeInvariant(kind: RuntimeInvariantKind, id: string): RuntimeInvariant {
  return runtimeInvariantSchema.parse({
    id,
    meaning: defaultInvariantMeaning(kind),
    kind,
    severity: defaultInvariantSeverity(kind),
    onViolation: defaultInvariantOnViolation(kind),
    evaluateAt: defaultEvaluateAt(kind),
  })
}

export type RuntimeInvariantWindow = {
  stepId: string
  stepRunId: string
  attemptId: string
  stepType: string
  effectType: EffectType
  status: string
  errorCode?: string | null
  moduleId?: string | null
  moduleEffectCeiling?: EffectType | null
}

export type RuntimeInvariantAuthFact = {
  status: string
  autoRecoveriesUsed: number
  manualRecoveriesUsed: number
  nextStepId?: string | null
  unrecoverableCode?: string | null
} | null

export type ErrorSurfaceNode = {
  role: string
  text: string
}

export type RuntimeInvariantErrorSurfaceFact = {
  attemptId: string
  stepRunId: string
  stepId: string
  probed: boolean
  matches: ErrorSurfaceNode[]
}

export type DerivedRuntimeInvariantResult = {
  contractId: string
  scope: 'scenario'
  meaning: string
  severity: OutcomeSeverity
  onViolation: OutcomeOnViolation
  provenance: 'runtime_invariant'
  verdict: OutcomeVerdict
  expected: JsonValue
  actual: JsonValue
  details: Record<string, JsonValue>
  stepRunId: string
  attemptId: string
}

const AUTH_VIOLATION_STATUSES = new Set(['recovering', 'recovered', 'unrecoverable'])

export function authValidityViolated(checkpoint: RuntimeInvariantAuthFact): boolean {
  if (!checkpoint) return false
  if (AUTH_VIOLATION_STATUSES.has(checkpoint.status)) return true
  return checkpoint.autoRecoveriesUsed > 0 || checkpoint.manualRecoveriesUsed > 0
}

export function isNavigationBoundaryError(code?: string | null): boolean {
  return (
    code === 'NAVIGATE_OUT_OF_SCOPE' || code === 'PAGE_HANDOFF_OUT_OF_SCOPE'
  )
}

const SECRETISH = /(password|passwd|token|secret|authorization)\s*[=:]\s*\S+/gi
const EMAILISH = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g

export function redactErrorSurfaceText(text: string): string {
  return text
    .replace(SECRETISH, '$1=***')
    .replace(EMAILISH, '[redacted-email]')
    .slice(0, 500)
}

const ERROR_SURFACE_TEXT = /错误|失败|系统异常|error|failed|exception/i

export function classifyErrorSurface(nodes: readonly ErrorSurfaceNode[]): {
  violated: boolean
  matches: ErrorSurfaceNode[]
} {
  const matches = nodes
    .map((node) => ({
      role: node.role.slice(0, 64),
      text: redactErrorSurfaceText(node.text.trim()),
    }))
    .filter((node) => {
      if (!node.text) return false
      if (node.role === 'alertdialog' || node.role === 'data-cairn-error-surface') return true
      return ERROR_SURFACE_TEXT.test(node.text)
    })
  return { violated: matches.length > 0, matches }
}

function lastWindow(windows: readonly RuntimeInvariantWindow[]): RuntimeInvariantWindow | undefined {
  return windows[windows.length - 1]
}

function windowForStep(
  windows: readonly RuntimeInvariantWindow[],
  stepId?: string | null,
): RuntimeInvariantWindow | undefined {
  if (!stepId) return lastWindow(windows)
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    if (windows[index]?.stepId === stepId) return windows[index]
  }
  return lastWindow(windows)
}

function resultOf(
  invariant: RuntimeInvariant,
  window: RuntimeInvariantWindow,
  verdict: OutcomeVerdict,
  expected: JsonValue,
  actual: JsonValue,
  details: Record<string, JsonValue>,
): DerivedRuntimeInvariantResult {
  return {
    contractId: invariant.id,
    scope: 'scenario',
    meaning: invariant.meaning,
    severity: invariant.severity,
    onViolation: invariant.onViolation,
    provenance: 'runtime_invariant',
    verdict,
    expected,
    actual,
    details,
    stepRunId: window.stepRunId,
    attemptId: window.attemptId,
  }
}

function completedWindows(windows: readonly RuntimeInvariantWindow[]): RuntimeInvariantWindow[] {
  return windows.filter((item) => item.status === 'SUCCEEDED' || item.status === 'FAILED' || item.status === 'CANCELLED')
}

export function deriveRuntimeInvariantResults(input: {
  invariants: readonly RuntimeInvariant[]
  windows: readonly RuntimeInvariantWindow[]
  authCheckpoint?: RuntimeInvariantAuthFact
  errorSurfaces?: readonly RuntimeInvariantErrorSurfaceFact[]
  runFinished: boolean
  runStatus?: string | null
}): DerivedRuntimeInvariantResult[] {
  const results: DerivedRuntimeInvariantResult[] = []
  const windows = completedWindows(input.windows)

  for (const invariant of input.invariants) {
    if (invariant.kind === 'navigation_boundary') {
      const failed = windows.filter((item) => isNavigationBoundaryError(item.errorCode))
      if (failed.length > 0) {
        for (const window of failed) {
          results.push(
            resultOf(
              invariant,
              window,
              'FAIL',
              { kind: invariant.kind, allowed: 'access_policy' },
              { errorCode: window.errorCode ?? null, stepId: window.stepId },
              { evaluateAt: invariant.evaluateAt, stepType: window.stepType },
            ),
          )
        }
        continue
      }
      const observed = lastWindow(windows)
      if (input.runFinished && observed) {
        results.push(
          resultOf(
            invariant,
            observed,
            'PASS',
            { kind: invariant.kind, allowed: 'access_policy' },
            { errorCode: null },
            { evaluateAt: invariant.evaluateAt, observedAttempts: windows.length },
          ),
        )
      }
      continue
    }

    if (invariant.kind === 'auth_validity') {
      const waiting = input.runStatus === 'WAITING_FOR_AUTH'
      if (authValidityViolated(input.authCheckpoint ?? null) || waiting) {
        const checkpoint = input.authCheckpoint
        const window = windowForStep(windows, checkpoint?.nextStepId)
        if (!window) continue
        results.push(
          resultOf(
            invariant,
            window,
            'FAIL',
            { kind: invariant.kind, status: 'authenticated' },
            {
              status: checkpoint?.status ?? 'waiting_for_auth',
              autoRecoveriesUsed: checkpoint?.autoRecoveriesUsed ?? 0,
              manualRecoveriesUsed: checkpoint?.manualRecoveriesUsed ?? 0,
              unrecoverableCode: checkpoint?.unrecoverableCode ?? null,
            },
            {
              evaluateAt: invariant.evaluateAt,
              ...(waiting ? { waitingForAuth: true } : {}),
            },
          ),
        )
        continue
      }
      const observed = lastWindow(windows)
      if (input.runFinished && observed) {
        results.push(
          resultOf(
            invariant,
            observed,
            'PASS',
            { kind: invariant.kind, status: 'authenticated' },
            { status: 'held' },
            { evaluateAt: invariant.evaluateAt },
          ),
        )
      }
      continue
    }

    if (invariant.kind === 'effect_ceiling') {
      const relevant = windows.filter((item) => item.moduleEffectCeiling)
      const exceeded = relevant.filter(
        (item) => item.moduleEffectCeiling && effectTypeExceedsCeiling(item.effectType, item.moduleEffectCeiling),
      )
      if (exceeded.length > 0) {
        for (const window of exceeded) {
          results.push(
            resultOf(
              invariant,
              window,
              'FAIL',
              { kind: invariant.kind, ceiling: window.moduleEffectCeiling ?? null },
              { effectType: window.effectType, stepId: window.stepId, moduleId: window.moduleId ?? null },
              { evaluateAt: invariant.evaluateAt },
            ),
          )
        }
        continue
      }
      const observed = lastWindow(relevant)
      if (input.runFinished && observed) {
        results.push(
          resultOf(
            invariant,
            observed,
            'PASS',
            { kind: invariant.kind, ceiling: observed.moduleEffectCeiling ?? null },
            { effectType: observed.effectType },
            { evaluateAt: invariant.evaluateAt, observedModuleSteps: relevant.length },
          ),
        )
      }
      continue
    }

    if (invariant.kind === 'readonly_guarantee') {
      const writes = windows.filter((item) => item.effectType === 'SIDE_EFFECT')
      if (writes.length > 0) {
        const window = writes[0]!
        results.push(
          resultOf(
            invariant,
            window,
            'FAIL',
            { kind: invariant.kind, allowed: ['READ_ONLY', 'IDEMPOTENT'] },
            { effectType: window.effectType, stepId: window.stepId, stepType: window.stepType },
            { evaluateAt: invariant.evaluateAt },
          ),
        )
        continue
      }
      const observed = lastWindow(windows)
      if (input.runFinished && observed) {
        results.push(
          resultOf(
            invariant,
            observed,
            'PASS',
            { kind: invariant.kind, allowed: ['READ_ONLY', 'IDEMPOTENT'] },
            { effectType: observed.effectType },
            { evaluateAt: invariant.evaluateAt, observedSteps: windows.length },
          ),
        )
      }
      continue
    }

    const probes = (input.errorSurfaces ?? []).filter((item) => item.probed)
    const hits = probes.filter((item) => classifyErrorSurface(item.matches).violated)
    if (hits.length > 0) {
      for (const hit of hits) {
        const classified = classifyErrorSurface(hit.matches)
        const window =
          windows.find((item) => item.attemptId === hit.attemptId) ??
          windowForStep(windows, hit.stepId)
        if (!window) continue
        results.push(
          resultOf(
            invariant,
            window,
            'FAIL',
            { kind: invariant.kind, surface: 'none' },
            { matches: classified.matches },
            { evaluateAt: invariant.evaluateAt },
          ),
        )
      }
      continue
    }
    if (input.runFinished && probes.length > 0) {
      const lastProbe = probes[probes.length - 1]!
      const window =
        windows.find((item) => item.attemptId === lastProbe.attemptId) ?? lastWindow(windows)
      if (!window) continue
      results.push(
        resultOf(
          invariant,
          window,
          'PASS',
          { kind: invariant.kind, surface: 'none' },
          { matches: [] },
          { evaluateAt: invariant.evaluateAt, probed: probes.length },
        ),
      )
    }
  }

  return results
}

export type JoinedRuntimeInvariantEvaluation = {
  entry: RuntimeInvariant
  result?: OutcomeResultDto
  displayVerdict: OutcomeStatus
}

export function joinRuntimeInvariantEvaluations(
  manifest?: RuntimeInvariantManifest | null,
  results?: readonly OutcomeResultDto[] | null,
): JoinedRuntimeInvariantEvaluation[] {
  const grouped = new Map<string, OutcomeResultDto[]>()
  for (const item of results ?? []) {
    const list = grouped.get(item.contractId) ?? []
    list.push(item)
    grouped.set(item.contractId, list)
  }
  return (manifest?.entries ?? []).map((entry) => {
    const rows = grouped.get(entry.id) ?? []
    if (rows.length === 0) {
      return { entry, displayVerdict: 'NOT_EVALUATED' as const }
    }
    const folded = foldOutcomeVerdicts(rows.map((row) => row.verdict)) ?? 'UNKNOWN'
    const result =
      rows.find((row) => row.verdict === folded) ??
      rows[rows.length - 1]
    return { entry, result, displayVerdict: folded }
  })
}

export const FACTORY_RUNTIME_INVARIANT_DEFAULTS = {
  allowEachStepProbe: false,
} as const

export const platformRuntimeInvariantDefaultsSchema = z.strictObject({
  allowEachStepProbe: z.boolean(),
})
export type PlatformRuntimeInvariantDefaults = z.infer<typeof platformRuntimeInvariantDefaultsSchema>
