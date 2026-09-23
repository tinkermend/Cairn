import { describe, expect, it } from 'vitest'
import {
  compileScenarioDocument,
  evaluatePatchGuards,
  computeDigestManifest,
} from '../index.js'
import { type ScenarioDocument, type Step } from '@cairn/shared'

describe('patch guardrails & digest manifest', () => {
  const dummyScenario: ScenarioDocument = {
    schemaVersion: 1,
    title: 'Test Scenario',
    inputs: [{ key: 'orderId', label: 'Order ID', type: 'string', required: true }],
    steps: [
      {
        id: 's1',
        name: 'Step 1',
        type: 'click',
        input: {
          target: {
            kind: 'locator',
            candidates: [{ by: 'css', value: '#submit' }],
          },
        },
      } as Step,
      {
        id: 's2',
        name: 'AI Assert Step',
        type: 'ai_assert',
        input: {
          prompt: 'Check order status is confirmed',
        },
        contextBindings: [
          {
            name: 'orderId',
            source: 'input.orderId',
            path: 'orderId',
            required: true,
          },
        ],
      } as Step,
    ],
  }

  it('computes digest manifest deterministically', () => {
    const manifest = computeDigestManifest(
      dummyScenario as any,
      dummyScenario as any,
    )
    expect(manifest.sourceDefinitionDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.postPatchExecutionDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.originalContractDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.algorithmVersion).toBe('v1')
  })

  it('passes guards for valid REPLACE_LOCATOR patch', () => {
    const originalStep = dummyScenario.steps[0]!
    const patch = {
      kind: 'REPLACE_LOCATOR' as const,
      suggestedCandidate: {
        by: 'css' as const,
        value: 'button.btn-primary',
      },
    }

    const guards = evaluatePatchGuards({
      originalStep,
      patch,
      sourceDefinition: dummyScenario as any,
      patchedDefinition: dummyScenario as any,
    })

    expect(guards.overallPassed).toBe(true)
    expect(guards.allowedFields.status).toBe('passed')
    expect(guards.unchangedBusinessGoal.status).toBe('passed')
    expect(guards.sideEffectSafety.status).toBe('passed')
    expect(guards.contextIntegrity.status).toBe('passed')
  })

  it('rejects patch trying to upgrade an assert step to non-assert AI step', () => {
    const assertStep: Step = {
      id: 's_assert',
      name: 'Verify Result',
      type: 'assert',
      input: {
        expect: {
          kind: 'text_contains',
          expected: 'Success',
        },
      },
    }

    const patch = {
      kind: 'UPGRADE_TO_AI_STEP' as const,
      upgradeSuggestion: {
        stepType: 'ai_action' as const,
        prompt: 'Check something',
      },
    }

    const guards = evaluatePatchGuards({
      originalStep: assertStep,
      patch,
      sourceDefinition: dummyScenario as any,
    })

    expect(guards.overallPassed).toBe(false)
    expect(guards.unchangedBusinessGoal.status).toBe('rejected')
  })

  it('compiler catches invalid and forward-referencing contextBindings', () => {
    const invalidDoc: ScenarioDocument = {
      schemaVersion: 1,
      title: 'Invalid Context Scenario',
      inputs: [{ key: 'account', label: 'Account', type: 'string', required: true }],
      steps: [
        {
          id: 'step_ai_1',
          name: 'AI Action 1',
          type: 'ai_action',
          input: {
            instruction: 'Do something',
          },
          contextBindings: [
            {
              name: 'futureData',
              source: 'steps.step_ai_2.output',
              path: 'field',
              required: true,
            },
            {
              name: 'account',
              source: 'input.account',
              path: '__proto__.polluted',
              required: true,
            },
            {
              name: 'unresolvedInput',
              source: 'input.not_existing_key',
              path: 'field',
              required: true,
            },
          ],
        } as Step,
        {
          id: 'step_ai_2',
          name: 'AI Action 2',
          type: 'ai_action',
          input: {
            instruction: 'Do next',
          },
        } as Step,
      ],
    }

    const result = compileScenarioDocument(invalidDoc, { mode: 'save' })
    const codes = result.diagnostics.map((d) => d.code)
    expect(codes).toContain('SCENARIO_AI_CONTEXT_BINDING_UNRESOLVED')
    expect(codes).toContain('SCENARIO_AI_CONTEXT_BINDING_INVALID')
  })
})
