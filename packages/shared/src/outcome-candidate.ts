import { z } from 'zod'
import { assertExpectSchema, type AssertExpect } from './browser-command.js'
import {
  outcomeOnViolationSchema,
  outcomeScopeSchema,
  outcomeSeveritySchema,
  type OutcomeContract,
  type OutcomeDeterministicRule,
} from './outcome.js'
import { targetDescriptorSchema, type TargetDescriptor } from './target-descriptor.js'
import { entityIdSchema } from './wire.js'

/** 与 worker observe 预览截断对齐，贴近该上限的文本不能冻成 text_equals。 */
export const OUTCOME_TEXT_TRUNCATE_LIMIT = 80

export const OUTCOME_CANDIDATE_PROVENANCES = ['manual', 'recorded'] as const
export type OutcomeCandidateProvenance = (typeof OUTCOME_CANDIDATE_PROVENANCES)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RELATIVE_TIME_RE = /^\d+\s*(秒|分钟|小时|天|周|个月|年)前$/
const DATE_RE =
  /^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/
const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/
const AMOUNT_RE = /^(?:¥|￥|\$|€)?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:元|万元|万|件|个|次)?$/
const ORDER_LIKE_RE = /^(?:订单|流水|单号|编号|NO\.?|ID)[-_#:\s]*[A-Za-z0-9]{4,}$/i
const ALNUM_ID_RE = /^(?=.*\d)[A-Z0-9][A-Z0-9\-_]{5,}$/i

export type OutcomeTextStability = {
  stableForEquals: boolean
  reasons: string[]
  suggestedKind: 'text_equals' | 'text_contains' | 'exists'
}

export function classifyOutcomeText(
  value: string,
  options?: { truncateLimit?: number },
): OutcomeTextStability {
  const text = value.trim()
  const reasons: string[] = []
  const limit = options?.truncateLimit ?? OUTCOME_TEXT_TRUNCATE_LIMIT

  if (!text) {
    return { stableForEquals: false, reasons: ['空文本不能作为相等期望'], suggestedKind: 'exists' }
  }
  if (text.length >= limit || /(?:…|\.{3}|…)$/.test(text)) {
    reasons.push('疑似被截断的文本，不能冻成完全相等')
  }
  if (UUID_RE.test(text)) {
    reasons.push('形似 UUID，会随业务数据变化')
  }
  if (/^\d{6,}$/.test(text)) {
    reasons.push('形似纯数字编号，会随业务数据变化')
  }
  if (ORDER_LIKE_RE.test(text) || ALNUM_ID_RE.test(text)) {
    reasons.push('形似订单号、流水号或业务 ID')
  }
  if (DATE_RE.test(text) || TIME_RE.test(text) || RELATIVE_TIME_RE.test(text)) {
    reasons.push('形似时间、日期或相对时间')
  }
  if (AMOUNT_RE.test(text) && /\d/.test(text)) {
    reasons.push('形似金额或数量，比较方式需用户显式选择')
  }

  if (reasons.length > 0) {
    const suggestedKind = reasons.some((item) => item.includes('截断')) ? 'text_contains' : 'exists'
    return { stableForEquals: false, reasons, suggestedKind }
  }
  return { stableForEquals: true, reasons: [], suggestedKind: 'text_equals' }
}

export const outcomeCandidateSchema = z.strictObject({
  meaning: z.string().trim().min(1).max(512),
  scope: outcomeScopeSchema,
  severity: outcomeSeveritySchema.default('MUST'),
  onViolation: outcomeOnViolationSchema.default('halt'),
  provenance: z.enum(OUTCOME_CANDIDATE_PROVENANCES),
  target: targetDescriptorSchema.optional(),
  expect: assertExpectSchema,
  reasons: z.array(z.string().min(1).max(256)).default([]),
  sourceStepId: entityIdSchema.optional(),
  sourceIndexes: z.array(z.number().int().nonnegative()).optional(),
})
export type OutcomeCandidate = z.infer<typeof outcomeCandidateSchema>

export function stabilizeAssertExpect(expect: AssertExpect): {
  expect: AssertExpect
  reasons: string[]
} {
  if (expect.kind !== 'text_equals') {
    return { expect, reasons: [] }
  }
  const classified = classifyOutcomeText(expect.value)
  if (classified.stableForEquals) {
    return { expect, reasons: [] }
  }
  if (classified.suggestedKind === 'text_contains') {
    return {
      expect: { kind: 'text_contains', value: expect.value },
      reasons: classified.reasons,
    }
  }
  return {
    expect: { kind: 'exists' },
    reasons: classified.reasons,
  }
}

export function proposeOutcomeCandidate(input: {
  meaning: string
  scope: OutcomeCandidate['scope']
  provenance: OutcomeCandidateProvenance
  target?: TargetDescriptor
  expect: AssertExpect
  sourceStepId?: string
  sourceIndexes?: number[]
}): OutcomeCandidate {
  const stabilized = stabilizeAssertExpect(input.expect)
  return outcomeCandidateSchema.parse({
    meaning: input.meaning,
    scope: input.scope,
    provenance: input.provenance,
    ...(input.target ? { target: input.target } : {}),
    expect: stabilized.expect,
    reasons: stabilized.reasons,
    ...(input.sourceStepId ? { sourceStepId: input.sourceStepId } : {}),
    ...(input.sourceIndexes ? { sourceIndexes: input.sourceIndexes } : {}),
  })
}

export function outcomeContractFromCandidate(
  candidate: OutcomeCandidate,
  id: string,
): OutcomeContract {
  const rule: OutcomeDeterministicRule = {
    kind: 'deterministic',
    ...(candidate.target ? { target: candidate.target } : {}),
    expect: candidate.expect,
  }
  return {
    id,
    scope: candidate.scope,
    meaning: candidate.meaning,
    severity: candidate.severity,
    onViolation: candidate.severity === 'MUST' ? candidate.onViolation : 'continue',
    provenance: candidate.provenance,
    rule,
  }
}

export function expectKindLabel(kind: AssertExpect['kind']): string {
  switch (kind) {
    case 'exists':
      return '对象存在'
    case 'visible':
      return '对象可见'
    case 'text_equals':
      return '文本相符'
    case 'text_contains':
      return '文本包含'
    case 'number_compare':
      return '数值比较'
  }
}

function firstLocatorLabel(target?: TargetDescriptor): string | undefined {
  const locator = target?.candidates[0]
  const label = locator?.name?.trim() || locator?.value?.trim()
  return label ? label.slice(0, 80) : undefined
}

/** 录制/点选候选的业务含义：优先用期望文本或对象文案，不用算子名顶替。 */
export function outcomeCandidateMeaning(input: {
  expect: AssertExpect
  target?: TargetDescriptor
}): string {
  switch (input.expect.kind) {
    case 'text_equals':
    case 'text_contains': {
      const text = input.expect.value.trim()
      return text.slice(0, 80) || expectKindLabel(input.expect.kind)
    }
    case 'number_compare': {
      const text = `${input.expect.op} ${input.expect.value}`.trim()
      return text ? `数值 ${text}` : expectKindLabel(input.expect.kind)
    }
    default: {
      const locator = firstLocatorLabel(input.target)
      return locator
        ? `${expectKindLabel(input.expect.kind)}：${locator}`
        : expectKindLabel(input.expect.kind)
    }
  }
}
