import { describe, expect, it } from 'vitest'
import {
  canonicalizeJson,
  stripNonSemanticFields,
  computeContractDigest,
  computeExecutionDigest,
  computeSourceDefinitionDigest,
} from '../digest.js'

describe('digest pure functions', () => {
  it('canonicalizeJson orders keys and handles primitives deterministically', () => {
    const a = { z: 1, a: 2, m: { y: 'hello', x: [3, 2, 1] } }
    const b = { a: 2, m: { x: [3, 2, 1], y: 'hello' }, z: 1 }

    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b))
    expect(canonicalizeJson(a)).toBe('{"a":2,"m":{"x":[3,2,1],"y":"hello"},"z":1}')
  })

  it('canonicalizeJson drops undefined properties but keeps null', () => {
    const obj = { a: 1, b: undefined, c: null }
    expect(canonicalizeJson(obj)).toBe('{"a":1,"c":null}')
  })

  it('stripNonSemanticFields removes UI coordinates, descriptions, and draft revisions', () => {
    const raw = {
      name: 'Order Search',
      description: 'Search for active orders',
      uiPosition: { x: 100, y: 200 },
      draftRevision: 5,
      steps: [
        {
          id: 'step-1',
          description: 'Click button',
          collapsed: true,
          action: 'click',
        },
      ],
    }

    const stripped = stripNonSemanticFields(raw) as Record<string, unknown>
    expect(stripped.name).toBe('Order Search')
    expect(stripped.description).toBeUndefined()
    expect(stripped.uiPosition).toBeUndefined()
    expect(stripped.draftRevision).toBeUndefined()

    const step = (stripped.steps as Record<string, unknown>[])[0]
    expect(step.id).toBe('step-1')
    expect(step.action).toBe('click')
    expect(step.description).toBeUndefined()
    expect(step.collapsed).toBeUndefined()
  })

  it('computeContractDigest is invariant to step locator changes, but changes when outcome changes', () => {
    const defV1 = {
      targetId: 't-1',
      inputs: { query: 'string' },
      outputs: { total: 'number' },
      outcomes: [{ id: 'out-1', must: true, type: 'text_match', expected: 'Found' }],
      steps: [
        { id: 's-1', action: 'click', locator: { css: '.old-btn' }, description: 'Old step' },
      ],
    }

    const defV2WithRepairedLocator = {
      targetId: 't-1',
      inputs: { query: 'string' },
      outputs: { total: 'number' },
      outcomes: [{ id: 'out-1', must: true, type: 'text_match', expected: 'Found' }],
      steps: [
        { id: 's-1', action: 'click', locator: { css: '.new-btn-repaired' }, description: 'New step' },
      ],
      draftRevision: 2,
    }

    const defV3WithChangedOutcome = {
      targetId: 't-1',
      inputs: { query: 'string' },
      outputs: { total: 'number' },
      outcomes: [{ id: 'out-1', must: true, type: 'text_match', expected: 'Weakened Outcome' }],
      steps: [
        { id: 's-1', action: 'click', locator: { css: '.new-btn-repaired' } },
      ],
    }

    const digest1 = computeContractDigest(defV1)
    const digest2 = computeContractDigest(defV2WithRepairedLocator)
    const digest3 = computeContractDigest(defV3WithChangedOutcome)

    expect(digest1).toBe(digest2) // Locator fix does NOT change contract digest!
    expect(digest1).not.toBe(digest3) // Altering outcome DOES change contract digest!
  })

  it('computeExecutionDigest reflects step changes but ignores UI metadata', () => {
    const defV1 = {
      targetId: 't-1',
      steps: [
        { id: 's-1', action: 'click', locator: { css: '.btn' }, uiPosition: { x: 1, y: 2 } },
      ],
    }

    const defV1WithDifferentUIPos = {
      targetId: 't-1',
      steps: [
        { id: 's-1', action: 'click', locator: { css: '.btn' }, uiPosition: { x: 99, y: 99 }, description: 'new text' },
      ],
      draftRevision: 3,
    }

    const defV2WithNewLocator = {
      targetId: 't-1',
      steps: [
        { id: 's-1', action: 'click', locator: { css: '.different-btn' } },
      ],
    }

    const exec1 = computeExecutionDigest(defV1)
    const exec2 = computeExecutionDigest(defV1WithDifferentUIPos)
    const exec3 = computeExecutionDigest(defV2WithNewLocator)

    expect(exec1).toBe(exec2) // UI position change doesn't alter execution digest
    expect(exec1).not.toBe(exec3) // Locator change DOES alter execution digest
  })

  it('computeSourceDefinitionDigest returns stable 64-char sha256 hex string', () => {
    const def = { targetId: 't-1', name: 'Scenario' }
    const hash = computeSourceDefinitionDigest(def)
    expect(hash).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(hash)).toBe(true)
  })
})
