import { describe, expect, it } from 'vitest'
import {
  repairCandidateSchema,
  guardResultsSchema,
  digestManifestSchema,
  contextBindingSchema,
  diagnosticFocusSchema,
} from '../index.js'

describe('repair candidate and context schemas', () => {
  it('validates contextBindingSchema', () => {
    const valid = {
      name: 'orderId',
      source: 'steps.step1.orderId',
      path: 'orderId',
      required: true,
      projection: 'value' as const,
    }
    expect(contextBindingSchema.parse(valid)).toEqual(valid)
  })

  it('rejects contextBinding with invalid identifier name or prototype paths', () => {
    expect(() =>
      contextBindingSchema.parse({
        name: 'invalid name!',
        source: 'steps.step1.id',
        path: 'id',
      }),
    ).toThrow()

    expect(() =>
      contextBindingSchema.parse({
        name: '__proto__',
        source: 'steps.step1.id',
        path: 'id',
      }),
    ).toThrow()

    expect(() =>
      contextBindingSchema.parse({
        name: 'orderId',
        source: 'steps.step1.__proto__',
        path: 'id',
      }),
    ).toThrow()

    expect(() =>
      contextBindingSchema.parse({
        name: 'orderId',
        source: 'steps.step1.id',
        path: '__proto__.secret',
      }),
    ).toThrow()
  })

  it('validates repairCandidateSchema', () => {
    const candidate = {
      id: '11111111-1111-4111-8111-111111111111',
      candidateId: 'rep_cand_123',
      runId: '22222222-2222-4222-8222-222222222222',
      sourceAttemptId: '33333333-3333-4333-8333-333333333333',
      patchTargetRef: {
        kind: 'scenario',
        stepId: 'step_login_btn',
        sourceDefinitionDigest: 'sha256:abc',
      },
      patch: {
        kind: 'REPLACE_LOCATOR',
        suggestedCandidate: {
          by: 'css',
          value: 'button.login-submit',
        },
      },
      hypothesis: 'Button selector changed from #login to .login-submit',
      digestManifest: {
        sourceDefinitionDigest: 'sha256:abc',
        postPatchExecutionDigest: 'sha256:def',
        originalContractDigest: 'sha256:contract',
        algorithmVersion: 'v1',
      },
      guardResults: {
        allowedFields: { name: 'allowedFields', status: 'passed', reason: 'ok' },
        unchangedBusinessGoal: { name: 'unchangedBusinessGoal', status: 'passed', reason: 'ok' },
        sideEffectSafety: { name: 'sideEffectSafety', status: 'passed', reason: 'ok' },
        contextIntegrity: { name: 'contextIntegrity', status: 'passed', reason: 'ok' },
        overallPassed: true,
      },
      status: 'proposed',
      validationScope: {
        locatorValid: false,
        stepPassed: false,
        outcomePassed: false,
        crossSampleStable: false,
      },
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    }

    const parsed = repairCandidateSchema.parse(candidate)
    expect(parsed.candidateId).toBe('rep_cand_123')
    expect(parsed.status).toBe('proposed')
    expect(parsed.patch.kind).toBe('REPLACE_LOCATOR')
  })

  it('validates diagnosticFocusSchema', () => {
    expect(diagnosticFocusSchema.parse('failure')).toBe('failure')
    expect(diagnosticFocusSchema.parse('evidence_missing')).toBe('evidence_missing')
    expect(() => diagnosticFocusSchema.parse('nonexistent_focus')).toThrow()
  })
})
