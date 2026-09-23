import { canonicalJson, syncSha256 } from '@cairn/shared'

/**
 * Recursively serializes a value into a canonical JSON string:
 * - Object keys are sorted in lexicographical order.
 * - `undefined` properties are omitted.
 * - Arrays maintain their element order, with each element canonicalized.
 * - Primitives are JSON-serialized deterministically.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalJson(value)
}

/**
 * Strips non-semantic visual and metadata fields (UI layout, descriptions, timestamps, revisions).
 */
export function stripNonSemanticFields(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(stripNonSemanticFields)
  }

  const NON_SEMANTIC_KEYS = new Set([
    'description',
    'uiPosition',
    'position',
    'x',
    'y',
    'collapsed',
    'expanded',
    'color',
    'draftRevision',
    'revision',
    'createdAt',
    'updatedAt',
    'lastModified',
  ])

  const obj = value as Record<string, unknown>
  const result: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(obj)) {
    if (!NON_SEMANTIC_KEYS.has(key)) {
      result[key] = stripNonSemanticFields(val)
    }
  }

  return result
}

/**
 * Computes originalContractDigest:
 * Extracts business input/output contracts, record identity, action effects,
 * and MUST outcome success criteria with their descriptors.
 */
export function computeContractDigest(definition: Record<string, unknown>): string {
  const contractCore = {
    inputs: definition.inputs ?? definition.parameters ?? null,
    outputs: definition.outputs ?? definition.outputSchema ?? null,
    contextBindings: definition.contextBindings ?? null,
    targetId: definition.targetId ?? null,
    outcomes: definition.outcomes ?? definition.successConditions ?? null,
    runtimeInvariants: definition.runtimeInvariants ?? null,
    effects: definition.effects ?? null,
  }

  const cleaned = stripNonSemanticFields(contractCore)
  const canonical = canonicalizeJson(cleaned)
  return syncSha256(canonical)
}

/**
 * Computes postPatchExecutionDigest:
 * Normalizes all executable step actions, locators, descriptors, arguments,
 * module bindings and timeouts, combined with the business contract.
 */
export function computeExecutionDigest(definition: Record<string, unknown>): string {
  const steps = Array.isArray(definition.steps)
    ? definition.steps.map((step: Record<string, unknown>) => ({
        id: step.id ?? step.stepId ?? null,
        type: step.type ?? null,
        action: step.action ?? null,
        locator: step.locator ?? step.descriptor ?? step.target ?? null,
        args: step.args ?? step.params ?? step.input ?? null,
        timeout: step.timeout ?? null,
        retries: step.retries ?? null,
        moduleRef: step.moduleRef ?? step.moduleId ?? null,
      }))
    : []

  const executionCore = {
    contract: {
      inputs: definition.inputs ?? definition.parameters ?? null,
      outputs: definition.outputs ?? definition.outputSchema ?? null,
      contextBindings: definition.contextBindings ?? null,
      targetId: definition.targetId ?? null,
      outcomes: definition.outcomes ?? definition.successConditions ?? null,
      runtimeInvariants: definition.runtimeInvariants ?? null,
    },
    steps,
  }

  const cleaned = stripNonSemanticFields(executionCore)
  const canonical = canonicalizeJson(cleaned)
  return syncSha256(canonical)
}

/**
 * Computes sourceDefinitionDigest:
 * Immutable hash of the normalized definition prior to repair.
 */
export function computeSourceDefinitionDigest(definition: Record<string, unknown>): string {
  const cleaned = stripNonSemanticFields(definition)
  const canonical = canonicalizeJson(cleaned)
  return syncSha256(canonical)
}
