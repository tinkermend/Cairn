import { describe, expect, it } from 'vitest'
import { overlayStepIdForSelection } from './observe'

const SOURCE_STEP_ID = '11111111-1111-4111-8111-111111111111'
const DERIVED_STEP_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_STEP_ID = '33333333-3333-4333-8333-333333333333'
const CONTRACT_ID = '44444444-4444-4444-8444-444444444444'

const overlay = {
  revision: 1,
  stepOverrides: {
    [DERIVED_STEP_ID]: {
      target: { framePath: [], candidates: [{ by: 'text' as const, value: '提交' }] },
    },
  },
}

describe('overlayStepIdForSelection', () => {
  it('选中源步骤时展示派生条件上的本次验证覆盖', () => {
    const stepId = overlayStepIdForSelection(
      {
        checkpoint: { stepId: DERIVED_STEP_ID, fencingToken: '1' },
        debugOverlay: overlay,
        snapshot: {
          outcomeManifest: {
            entries: [
              {
                contractId: CONTRACT_ID,
                scope: 'step',
                meaning: '提交成功',
                severity: 'MUST',
                onViolation: 'halt',
                provenance: 'manual',
                stepId: DERIVED_STEP_ID,
                sourceStepId: SOURCE_STEP_ID,
                rule: { kind: 'deterministic', expect: { kind: 'visible' } },
              },
            ],
          },
        },
      } as Parameters<typeof overlayStepIdForSelection>[0],
      SOURCE_STEP_ID,
    )
    expect(stepId).toBe(DERIVED_STEP_ID)
  })

  it('选中无关步骤时不展示派生覆盖', () => {
    const stepId = overlayStepIdForSelection(
      {
        checkpoint: { stepId: DERIVED_STEP_ID, fencingToken: '1' },
        debugOverlay: overlay,
        snapshot: {
          outcomeManifest: {
            entries: [
              {
                contractId: CONTRACT_ID,
                scope: 'step',
                meaning: '提交成功',
                severity: 'MUST',
                onViolation: 'halt',
                provenance: 'manual',
                stepId: DERIVED_STEP_ID,
                sourceStepId: SOURCE_STEP_ID,
                rule: { kind: 'deterministic', expect: { kind: 'visible' } },
              },
            ],
          },
        },
      } as Parameters<typeof overlayStepIdForSelection>[0],
      OTHER_STEP_ID,
    )
    expect(stepId).toBeUndefined()
  })
})
