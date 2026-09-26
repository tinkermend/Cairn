import { describe, expect, it } from 'vitest'
import {
  type HealingPatch,
  type ScenarioAuthoringDocumentV2,
  type ScenarioDocument,
} from '@cairn/shared'
import { applyPatchToDocument, findStepInDocument, PatchApplyError } from '../patch-apply.js'
import { computeTargetDigest } from '../digest.js'

describe('patch-apply and computeTargetDigest', () => {
  const targetA = {
    framePath: [],
    candidates: [
      { by: 'role' as const, value: 'button', name: '登录' },
      { by: 'css' as const, value: '#old-login-btn' },
    ],
  }

  it('computes stable target digest regardless of non-semantic fields', () => {
    const d1 = computeTargetDigest(targetA)
    const d2 = computeTargetDigest({
      ...targetA,
      description: 'login button',
      uiPosition: { x: 10, y: 20 },
    })
    const d3 = computeTargetDigest({
      framePath: [],
      candidates: [{ by: 'role' as const, value: 'button', name: '提交' }],
    })

    expect(d1).toBeTruthy()
    expect(d1).toBe(d2)
    expect(d1).not.toBe(d3)
  })

  it('applies ADD_CANDIDATE to ScenarioAuthoringDocumentV2 placing new candidate first', () => {
    const docV2: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: {
            id: 'step_btn_1',
            name: '点击登录',
            type: 'click',
            effectType: 'IDEMPOTENT',
            input: {
              target: targetA,
            },
          } as any,
        },
      ],
    }

    const patch: HealingPatch = {
      kind: 'ADD_CANDIDATE',
      suggestedCandidate: {
        by: 'testId',
        value: 'submit-login-btn',
      },
    }

    const patched = applyPatchToDocument(docV2, 'step_btn_1', patch)
    const stepNode = patched.nodes[0] as any
    expect(stepNode.step.input.target.candidates).toHaveLength(3)
    expect(stepNode.step.input.target.candidates[0]).toEqual({
      by: 'testId',
      value: 'submit-login-btn',
    })
    expect(stepNode.step.input.target.candidates[1]).toEqual(targetA.candidates[0])
    expect(stepNode.step.input.target.candidates[2]).toEqual(targetA.candidates[1])
  })

  it('deduplicates identical existing candidate and caps at MAX_LOCATOR_CANDIDATES', () => {
    const docV1: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [
        {
          id: 'step_v1',
          name: '点击',
          type: 'click',
          effectType: 'IDEMPOTENT',
          input: {
            target: {
              framePath: [],
              candidates: [
                { by: 'testId', value: 'c1' },
                { by: 'testId', value: 'c2' },
                { by: 'testId', value: 'c3' },
                { by: 'testId', value: 'c4' },
                { by: 'testId', value: 'target-cand' },
              ],
            },
          },
        } as any,
      ],
    }

    const patch: HealingPatch = {
      kind: 'ADD_CANDIDATE',
      suggestedCandidate: {
        by: 'testId',
        value: 'target-cand',
      },
    }

    const patched = applyPatchToDocument(docV1, 'step_v1', patch)
    const candidates = (patched.steps[0] as any).input.target.candidates
    // Should be moved to index 0, total length capped at 5
    expect(candidates).toHaveLength(5)
    expect(candidates[0]).toEqual({ by: 'testId', value: 'target-cand' })
    expect(candidates[1]).toEqual({ by: 'testId', value: 'c1' })
  })

  it('throws PatchApplyError when step is not found', () => {
    const docV2: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [],
    }

    const patch: HealingPatch = {
      kind: 'ADD_CANDIDATE',
      suggestedCandidate: { by: 'testId', value: 'xyz' },
    }

    expect(() => applyPatchToDocument(docV2, 'non_existent', patch)).toThrow(PatchApplyError)
  })

  it('findStepInDocument finds step across V1 and V2 documents correctly', () => {
    const docV1: ScenarioDocument = {
      schemaVersion: 1,
      inputs: [],
      steps: [{ id: 's1', name: 'Step 1', type: 'click', effectType: 'IDEMPOTENT' } as any],
    }
    const docV2: ScenarioAuthoringDocumentV2 = {
      authoringSchemaVersion: 2,
      schemaVersion: 1,
      inputs: [],
      nodes: [
        {
          kind: 'step',
          step: { id: 's2', name: 'Step 2', type: 'fill', effectType: 'IDEMPOTENT' } as any,
        },
      ],
    }

    expect(findStepInDocument(docV1, 's1')?.name).toBe('Step 1')
    expect(findStepInDocument(docV1, 's_missing')).toBeUndefined()
    expect(findStepInDocument(docV2, 's2')?.name).toBe('Step 2')
    expect(findStepInDocument(docV2, 's_missing')).toBeUndefined()
  })
})
