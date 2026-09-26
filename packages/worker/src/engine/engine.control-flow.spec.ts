import { describe, expect, it } from 'vitest'
import { FixtureStepExecutor } from './fixture-executor.js'
import { planBranchSuccess } from './engine-branch-plan.js'
import { systemClock } from './clock.js'
import { resolveEvidencePolicy, CONTROL_FLOW_PROTOCOL, type RunSnapshot } from '@cairn/shared'
import { testRunGrant, testRunSnapshot } from '../__tests__/harness.js'

describe('Control Flow Execution: decide, compute & branch planning', () => {
  const blockId = '11111111-1111-4111-8111-111111111111'
  const decideStepId = '22222222-2222-4222-8222-222222222222'
  const thenStepId1 = '33333333-3333-4333-8333-333333333333'
  const elseStepId1 = '44444444-4444-4444-8444-444444444444'

  const snapshotWithControlFlow: RunSnapshot = {
    ...testRunSnapshot(),
    controlFlow: {
      protocol: CONTROL_FLOW_PROTOCOL,
      blocks: [
        {
          blockId,
          kind: 'if',
          decideStepId,
          branches: [
            { key: 'then', stepIds: [thenStepId1] },
            { key: 'else', stepIds: [elseStepId1] },
          ],
        },
      ],
    },
  }

  it('FixtureStepExecutor executes decide step successfully for true condition (branch: then)', async () => {
    const fixture = new FixtureStepExecutor()
    const ctx = {
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: decideStepId,
        name: 'decide step',
        type: 'decide' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          blockId,
          condition: {
            kind: 'compare' as const,
            op: 'eq' as const,
            left: { kind: 'ref' as const, key: 'flag' },
            right: { kind: 'literal' as const, value: true },
          },
        },
      },
      input: {},
      context: { flag: true },
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: snapshotWithControlFlow,
    }

    const outcome = await fixture.execute(ctx)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.output).toEqual({
        branch: 'then',
        value: true,
        operands: { flag: true },
      })
    }
  })

  it('FixtureStepExecutor executes decide step successfully for false condition with else (branch: else)', async () => {
    const fixture = new FixtureStepExecutor()
    const ctx = {
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: decideStepId,
        name: 'decide step',
        type: 'decide' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          blockId,
          condition: {
            kind: 'compare' as const,
            op: 'eq' as const,
            left: { kind: 'ref' as const, key: 'count' },
            right: { kind: 'literal' as const, value: 5 },
          },
        },
      },
      input: {},
      context: { count: 3 },
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: snapshotWithControlFlow,
    }

    const outcome = await fixture.execute(ctx)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.output).toEqual({
        branch: 'else',
        value: false,
        operands: { count: 3 },
      })
    }
  })

  it('FixtureStepExecutor executes decide step for false condition without else (branch: none)', async () => {
    const noElseSnapshot: RunSnapshot = {
      ...testRunSnapshot(),
      controlFlow: {
        protocol: CONTROL_FLOW_PROTOCOL,
        blocks: [
          {
            blockId,
            kind: 'if',
            decideStepId,
            branches: [
              { key: 'then', stepIds: [thenStepId1] },
            ],
          },
        ],
      },
    }
    const fixture = new FixtureStepExecutor()
    const ctx = {
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: decideStepId,
        name: 'decide step',
        type: 'decide' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          blockId,
          condition: {
            kind: 'compare' as const,
            op: 'eq' as const,
            left: { kind: 'ref' as const, key: 'count' },
            right: { kind: 'literal' as const, value: 5 },
          },
        },
      },
      input: {},
      context: { count: 3 },
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: noElseSnapshot,
    }

    const outcome = await fixture.execute(ctx)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.output).toEqual({
        branch: 'none',
        value: false,
        operands: { count: 3 },
      })
    }
  })

  it('FixtureStepExecutor executes compute step successfully', async () => {
    const fixture = new FixtureStepExecutor()
    const ctx = {
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'compute step',
        type: 'compute' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          expression: {
            kind: 'call' as const,
            fn: 'concat' as const,
            args: [
              { kind: 'ref' as const, key: 'prefix' },
              { kind: 'literal' as const, value: '-suffix' },
            ],
          },
        },
        outputKey: 'result',
      },
      input: {},
      context: { prefix: 'test' },
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: testRunSnapshot(),
    }

    const outcome = await fixture.execute(ctx)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.output).toBe('test-suffix')
    }
  })

  it('planBranchSuccess marks unselected branch steps as condition_not_met', () => {
    // When then is selected, elseStepId1 is skipped
    const planThen = planBranchSuccess({
      snapshot: snapshotWithControlFlow,
      step: {
        id: decideStepId,
        name: 'decide',
        type: 'decide',
        effectType: 'READ_ONLY',
        input: { blockId, condition: { kind: 'literal', value: true } },
      },
      output: { branch: 'then', value: true },
      detail: {
        stepRuns: [
          { stepId: decideStepId, status: 'RUNNING' },
          { stepId: thenStepId1, status: 'PENDING' },
          { stepId: elseStepId1, status: 'PENDING' },
        ],
      },
    })
    expect(planThen).toBeDefined()
    expect(planThen?.skipStepIds).toEqual([elseStepId1])
    expect(planThen?.skips).toEqual([{ stepIds: [elseStepId1], reason: 'condition_not_met' }])
    expect(planThen?.last).toBe(false)

    // When else is selected, thenStepId1 is skipped
    const planElse = planBranchSuccess({
      snapshot: snapshotWithControlFlow,
      step: {
        id: decideStepId,
        name: 'decide',
        type: 'decide',
        effectType: 'READ_ONLY',
        input: { blockId, condition: { kind: 'literal', value: false } },
      },
      output: { branch: 'else', value: false },
      detail: {
        stepRuns: [
          { stepId: decideStepId, status: 'RUNNING' },
          { stepId: thenStepId1, status: 'PENDING' },
          { stepId: elseStepId1, status: 'PENDING' },
        ],
      },
    })
    expect(planElse).toBeDefined()
    expect(planElse?.skipStepIds).toEqual([thenStepId1])
    expect(planElse?.skips).toEqual([{ stepIds: [thenStepId1], reason: 'condition_not_met' }])
  })

  it('planBranchSuccess handles nested blocks by skipping all child stepIds', () => {
    const outerBlockId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const outerDecideId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const innerDecideId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const innerThenStepId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const innerElseStepId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    const outerElseStepId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

    const nestedSnapshot: RunSnapshot = {
      ...testRunSnapshot(),
      controlFlow: {
        protocol: CONTROL_FLOW_PROTOCOL,
        blocks: [
          {
            blockId: outerBlockId,
            kind: 'if',
            decideStepId: outerDecideId,
            branches: [
              { key: 'then', stepIds: [innerDecideId, innerThenStepId, innerElseStepId] },
              { key: 'else', stepIds: [outerElseStepId] },
            ],
          },
        ],
      },
    }

    // Outer block takes else: all then steps (including inner decide and inner branches) are skipped
    const plan = planBranchSuccess({
      snapshot: nestedSnapshot,
      step: {
        id: outerDecideId,
        name: 'outer decide',
        type: 'decide',
        effectType: 'READ_ONLY',
        input: { blockId: outerBlockId, condition: { kind: 'literal', value: false } },
      },
      output: { branch: 'else', value: false },
      detail: {
        stepRuns: [
          { stepId: outerDecideId, status: 'RUNNING' },
          { stepId: innerDecideId, status: 'PENDING' },
          { stepId: innerThenStepId, status: 'PENDING' },
          { stepId: innerElseStepId, status: 'PENDING' },
          { stepId: outerElseStepId, status: 'PENDING' },
        ],
      },
    })
    expect(plan?.skipStepIds).toEqual([innerDecideId, innerThenStepId, innerElseStepId])
    expect(plan?.skips).toEqual([{ stepIds: [innerDecideId, innerThenStepId, innerElseStepId], reason: 'condition_not_met' }])
  })

  it('FixtureStepExecutor returns EXPRESSION_EVALUATION_FAILED when expression evaluation fails', async () => {
    const fixture = new FixtureStepExecutor()
    const ctx = {
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: decideStepId,
        name: 'decide step',
        type: 'decide' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          blockId,
          condition: {
            kind: 'ref' as const,
            key: 'missingVar', // Not in context!
          },
        },
      },
      input: {},
      context: {},
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: snapshotWithControlFlow,
    }

    const outcome = await fixture.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('EXPRESSION_EVALUATION_FAILED')
    }
  })

  it('decide rejects a non-boolean condition result', async () => {
    const fixture = new FixtureStepExecutor()
    const outcome = await fixture.execute({
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: decideStepId,
        name: 'decide step',
        type: 'decide' as const,
        effectType: 'READ_ONLY' as const,
        input: {
          blockId,
          condition: { kind: 'ref' as const, key: 'label' },
        },
      },
      input: {},
      context: { label: 'false' },
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: snapshotWithControlFlow,
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.safeMessage).toContain('不是布尔值')
    }
  })
})
