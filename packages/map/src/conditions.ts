import type { MapConditionSnapshot, MapConditionTri, MapConditionUnknownField } from '@cairn/shared'

type FieldValue =
  | { known: true; value: string }
  | { known: false }

function permissionValue(condition: MapConditionSnapshot): FieldValue {
  if (!condition.permissionProfile) return { known: false }
  return {
    known: true,
    value: `${condition.permissionProfile.source}@${condition.permissionProfile.version}`,
  }
}

function fieldValue(condition: MapConditionSnapshot, field: MapConditionUnknownField): FieldValue {
  if (condition.unknownFields.includes(field)) return { known: false }
  switch (field) {
    case 'targetAccount':
      if (condition.accountBinding.presence === 'unknown') return { known: false }
      if (condition.accountBinding.presence === 'anonymous') return { known: true, value: 'anonymous' }
      return { known: true, value: condition.accountBinding.targetAccountId }
    case 'permissionProfile':
      return permissionValue(condition)
    case 'workspace':
      return condition.workspace ? { known: true, value: condition.workspace } : { known: false }
    case 'locale':
      return condition.locale ? { known: true, value: condition.locale } : { known: false }
    case 'viewport':
      return condition.viewport ? { known: true, value: condition.viewport.category } : { known: false }
    case 'featureVersion':
      return condition.featureVersion ? { known: true, value: condition.featureVersion } : { known: false }
  }
}

const FIELDS: MapConditionUnknownField[] = [
  'targetAccount',
  'permissionProfile',
  'workspace',
  'locale',
  'viewport',
  'featureVersion',
]

/** 账号只作 provenance，不参与条件匹配。permissionProfile 来源仍待定，本轮不发明。 */
const MATCH_FIELDS = FIELDS.filter((field) => field !== 'targetAccount')

export function evaluateCondition(
  required: MapConditionSnapshot,
  observed: MapConditionSnapshot,
): MapConditionTri {
  if (required.targetId !== observed.targetId) return 'unsatisfied'
  let unknown = false
  for (const field of MATCH_FIELDS) {
    const expected = fieldValue(required, field)
    const actual = fieldValue(observed, field)
    if (!expected.known) continue
    if (!actual.known) {
      unknown = true
      continue
    }
    if (expected.value !== actual.value) return 'unsatisfied'
  }
  return unknown ? 'unknown' : 'satisfied'
}

export function knownConditionFields(condition: MapConditionSnapshot): MapConditionUnknownField[] {
  return MATCH_FIELDS.filter((field) => fieldValue(condition, field).known)
}

export function isMoreSpecific(left: MapConditionSnapshot, right: MapConditionSnapshot): boolean {
  const leftKnown = new Set(knownConditionFields(left))
  const rightKnown = new Set(knownConditionFields(right))
  if (leftKnown.size <= rightKnown.size) return false
  for (const field of rightKnown) {
    if (!leftKnown.has(field)) return false
    const a = fieldValue(left, field)
    const b = fieldValue(right, field)
    if (a.known && b.known && a.value !== b.value) return false
  }
  return true
}

export function chooseImplementation<T extends { condition: MapConditionSnapshot }>(
  observed: MapConditionSnapshot,
  implementations: T[],
): { match: MapConditionTri; selected?: T; reasons: string[] } {
  const evaluated = implementations.map((item) => ({
    item,
    tri: evaluateCondition(item.condition, observed),
  }))
  const satisfied = evaluated.filter((item) => item.tri === 'satisfied')
  if (satisfied.length === 1) {
    return { match: 'satisfied', selected: satisfied[0]!.item, reasons: ['unique-satisfied'] }
  }
  if (satisfied.length > 1) {
    const specific = satisfied.filter((item) =>
      satisfied.every((other) => other === item || isMoreSpecific(item.item.condition, other.item.condition)),
    )
    if (specific.length === 1) {
      return { match: 'satisfied', selected: specific[0]!.item, reasons: ['more-specific'] }
    }
    return { match: 'unknown', reasons: ['overlapping-implementations'] }
  }
  if (evaluated.some((item) => item.tri === 'unknown')) {
    return { match: 'unknown', reasons: ['required-field-unknown'] }
  }
  return { match: 'unsatisfied', reasons: ['no-implementation'] }
}
