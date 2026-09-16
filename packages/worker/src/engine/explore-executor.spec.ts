import { describe, expect, it, vi } from 'vitest'
import { FACTORY_EXPLORATION_POLICY, type Step } from '@cairn/shared'
import { MapExploreExecutor } from './explore-executor.js'
import type { StepExecutionContext } from './step-executor.js'

const policy = {
  ...FACTORY_EXPLORATION_POLICY,
  allowlist: [{ origin: 'https://shop.example', pathPrefix: '/orders' }],
}

function context(step: Step, extras?: Partial<StepExecutionContext>): StepExecutionContext {
  return {
    runId: '00000000-0000-4000-8000-000000000201',
    stepRunId: '00000000-0000-4000-8000-000000000202',
    attemptId: '00000000-0000-4000-8000-000000000203',
    targetId: '00000000-0000-4000-8000-000000000204',
    step,
    input: step.input as never,
    context: {},
    signal: new AbortController().signal,
    clock: { now: () => Date.now() },
    evidencePolicy: { screenshot: 'off', trace: 'off', retainDays: { screenshot: 1, trace: 1, debugTrace: 1 } },
    grant: { runId: '00000000-0000-4000-8000-000000000201', fencingToken: 1, holderWorkerId: 'w', expiresAt: new Date().toISOString() },
    snapshot: { mapJob: { jobId: '00000000-0000-4000-8000-000000000205', purpose: 'map_explore' } } as never,
    ...extras,
  }
}

describe('MapExploreExecutor', () => {
  it('观察后零 AI 提名名单内一跳', async () => {
    const browser = {
      describeHold: vi.fn(async () => ({ url: 'https://shop.example/orders' })),
      execute: vi.fn(),
    }
    const executor = new MapExploreExecutor(browser as never)
    const observe = await executor.execute(
      context({
        id: '00000000-0000-4000-8000-000000000111',
        name: '观察',
        type: 'map_observe',
        effectType: 'READ_ONLY',
        outputKey: 'explore_observation',
        input: {
          mode: 'allowlist',
          allowlist: policy.allowlist,
          seedUrls: ['https://shop.example/orders/open'],
        },
      }),
    )
    expect(observe.kind).toBe('success')
    const propose = await executor.execute(
      context(
        {
          id: '00000000-0000-4000-8000-000000000112',
          name: '提名',
          type: 'map_propose',
          effectType: 'READ_ONLY',
          outputKey: 'explore_proposal',
          input: { from: 'explore_observation' },
        },
        { context: { explore_observation: observe.kind === 'success' ? observe.output : {} } },
      ),
    )
    expect(propose).toMatchObject({ kind: 'success', output: { kind: 'navigate', candidateId: 'nav:1' } })
  })

  it('OMI04 stop 不派发浏览器动作', async () => {
    const execute = vi.fn()
    const executor = new MapExploreExecutor({ execute, describeHold: vi.fn() } as never)
    const outcome = await executor.execute(
      context(
        {
          id: '00000000-0000-4000-8000-000000000113',
          name: '守卫',
          type: 'map_guarded_action',
          effectType: 'READ_ONLY',
          outputKey: 'explore_action',
          input: { from: 'explore_proposal' },
        },
        {
          context: {
            explore_observation: {
              currentUrl: 'https://shop.example/orders',
              origin: 'https://shop.example',
              allowlisted: true,
              candidates: [],
              visited: ['https://shop.example/orders'],
            },
            explore_proposal: { kind: 'stop', reason: 'no_safe_candidate' },
          },
        },
      ),
    )
    expect(outcome).toMatchObject({ kind: 'success', output: { state: 'not_dispatched' } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('OMI10 核验不升格', async () => {
    const executor = new MapExploreExecutor({
      describeHold: vi.fn(async () => ({ url: 'https://shop.example/orders/open' })),
    } as never)
    const outcome = await executor.execute(
      context(
        {
          id: '00000000-0000-4000-8000-000000000114',
          name: '核验',
          type: 'map_verify',
          effectType: 'READ_ONLY',
          outputKey: 'explore_verification',
          input: { from: 'explore_action', observationFrom: 'explore_observation' },
        },
        {
          context: {
            explore_action: { state: 'completed', url: 'https://shop.example/orders/open' },
          },
        },
      ),
    )
    expect(outcome).toMatchObject({
      kind: 'success',
      output: { promoted: false, businessResult: 'unknown' },
    })
  })
})
