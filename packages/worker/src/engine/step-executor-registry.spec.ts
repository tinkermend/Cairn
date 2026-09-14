import { describe, expect, it } from 'vitest'
import {
  StepExecutorRegistry,
  type StepExecutionContext,
  type StepExecutionOutcome,
  type StepExecutor,
} from './step-executor.js'
import { FixtureStepExecutor } from './fixture-executor.js'
import { BrowserStepExecutor } from './browser-executor.js'
import { systemClock } from './clock.js'
import { resolveEvidencePolicy } from '@cairn/shared'
import { testRunGrant, testRunSnapshot } from '../__tests__/harness.js'

describe('StepExecutorRegistry & StepExecutors', () => {
  it('支持注册、查询与覆盖检测', () => {
    const registry = new StepExecutorRegistry()
    expect(registry.registeredTypes()).toEqual([])

    const fixture = new FixtureStepExecutor()
    registry.register(fixture)

    expect(registry.has('echo')).toBe(true)
    expect(registry.has('delay')).toBe(true)
    expect(registry.has('fail')).toBe(true)
    expect(registry.has('non_existent')).toBe(false)
    expect(registry.get('echo')).toBe(fixture)
    expect(registry.get('unknown')).toBeUndefined()
  })

  it('FixtureStepExecutor 能够执行 echo 步骤', async () => {
    const fixture = new FixtureStepExecutor()
    const ctx: StepExecutionContext = {
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: '01912345-6789-7abc-def0-1234567890ab',
        name: 'echo test',
        type: 'echo',
        effectType: 'READ_ONLY',
        input: { value: { msg: 'cairn-universal' } },
      },
      input: { msg: 'cairn-universal' },
      context: {},
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: testRunSnapshot(),
    }

    const outcome = await fixture.execute(ctx)
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.output).toEqual({ msg: 'cairn-universal' })
    }
  })

  it('FixtureStepExecutor 能够执行 fail 步骤', async () => {
    const fixture = new FixtureStepExecutor()
    const ctx: StepExecutionContext = {
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: '01912345-6789-7abc-def0-1234567890ab',
        name: 'fail test',
        type: 'fail',
        effectType: 'READ_ONLY',
        input: { message: '人为注入的失败', code: 'CHAOS_FAIL', retryable: true },
      },
      input: { message: '人为注入的失败', code: 'CHAOS_FAIL', retryable: true },
      context: {},
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: testRunSnapshot(),
    }

    const outcome = await fixture.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('CHAOS_FAIL')
      expect(outcome.error.safeMessage).toBe('人为注入的失败')
      expect(outcome.error.retryable).toBe(true)
    }
  })

  it('BrowserStepExecutor 在无会话或无浏览器端口时优雅失败', async () => {
    // 传入假 db handle 和 undefined browser
    const executor = new BrowserStepExecutor({} as any, undefined)
    const ctx: StepExecutionContext = {
      runId: 'run-1',
      stepRunId: 'sr-1',
      attemptId: 'att-1',
      targetId: 't-1',
      step: {
        id: '01912345-6789-7abc-def0-1234567890ab',
        name: 'click test',
        type: 'click',
        effectType: 'SIDE_EFFECT',
        input: { target: { framePath: [], candidates: [{ by: 'text', value: 'Login' }] } },
      },
      input: { target: { framePath: [], candidates: [{ by: 'text', value: 'Login' }] } },
      context: {},
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: testRunSnapshot(),
    }

    const outcome = await executor.execute(ctx)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.code).toBe('BROWSER_UNAVAILABLE')
      expect(outcome.error.category).toBe('INFRASTRUCTURE')
    }
  })

  it('支持在测试中无缝挂载自定义扩展执行器（通用化插拔能力）', async () => {
    class CustomChaosExecutor implements StepExecutor {
      readonly supportedTypes = ['chaos_probe']
      async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
        return {
          kind: 'success',
          output: { probeId: ctx.stepRunId, status: 'CHAOS_TEST_PASSED' },
        }
      }
    }

    const registry = new StepExecutorRegistry([new FixtureStepExecutor()])
    expect(registry.has('chaos_probe')).toBe(false)

    registry.register(new CustomChaosExecutor())
    expect(registry.has('chaos_probe')).toBe(true)

    const custom = registry.get('chaos_probe')!
    const outcome = await custom.execute({
      runId: 'r-custom',
      stepRunId: 'sr-custom',
      attemptId: 'att-custom',
      targetId: 't-custom',
      step: {
        id: '01912345-6789-7abc-def0-1234567890ab',
        name: 'custom chaos',
        type: 'chaos_probe' as any,
        effectType: 'READ_ONLY',
        input: {} as any,
      },
      input: {},
      context: {},
      signal: new AbortController().signal,
      clock: systemClock,
      evidencePolicy: resolveEvidencePolicy({}),
      grant: testRunGrant(),
      snapshot: testRunSnapshot(),
    })

    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') {
      expect(outcome.output).toEqual({
        probeId: 'sr-custom',
        status: 'CHAOS_TEST_PASSED',
      })
    }
  })
})
