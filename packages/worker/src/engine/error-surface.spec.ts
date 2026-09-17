import { describe, expect, it } from 'vitest'
import { type RunSnapshot, type Step } from '@cairn/shared'

function surfaceInvariant(evaluateAt: 'before_side_effect' | 'each_step') {
  return {
    id: '00000000-0000-4000-8000-000000000061',
    meaning: '不得出现系统错误弹窗',
    kind: 'error_surface' as const,
    severity: 'MUST' as const,
    onViolation: 'halt' as const,
    evaluateAt,
  }
}
import {
  collectErrorSurfaceResults,
  shouldProbeErrorSurface,
} from './error-surface.js'

const snapshot = (evaluateAt: 'before_side_effect' | 'each_step'): RunSnapshot =>
  ({
    runtimeInvariantManifest: {
      entries: [surfaceInvariant(evaluateAt)],
    },
  }) as RunSnapshot

const clickStep: Step = {
  id: '00000000-0000-4000-8000-000000000062',
  name: '点击',
  type: 'click',
  effectType: 'SIDE_EFFECT',
  input: { target: { candidates: [{ by: 'css', value: 'button' }] } },
}

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000063',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  input: { value: 'ok' },
}

describe('error_surface 调度', () => {
  it('before_side_effect 只在副作用步前探测，each_step 在步骤后探测', () => {
    expect(shouldProbeErrorSurface(snapshot('before_side_effect'), clickStep, 'before')).toBe(true)
    expect(shouldProbeErrorSurface(snapshot('before_side_effect'), echoStep, 'before')).toBe(false)
    expect(shouldProbeErrorSurface(snapshot('before_side_effect'), clickStep, 'after')).toBe(false)
    expect(shouldProbeErrorSurface(snapshot('each_step'), echoStep, 'after')).toBe(true)
    expect(shouldProbeErrorSurface({} as RunSnapshot, clickStep, 'after')).toBe(false)
  })

  it('命中 alertdialog 记 FAIL 且 halt；正常页记 PASS', () => {
    const failed = collectErrorSurfaceResults({
      snapshot: snapshot('before_side_effect'),
      stepRunId: '00000000-0000-4000-8000-000000000064',
      attemptId: '00000000-0000-4000-8000-000000000065',
      now: new Date('2026-09-17T00:00:00.000Z'),
      matches: [{ role: 'alertdialog', text: '系统异常' }],
    })
    expect(failed.violated).toBe(true)
    expect(failed.halt).toBe(true)
    expect(failed.results[0]?.verdict).toBe('FAIL')

    const passed = collectErrorSurfaceResults({
      snapshot: snapshot('each_step'),
      stepRunId: '00000000-0000-4000-8000-000000000064',
      attemptId: '00000000-0000-4000-8000-000000000065',
      now: new Date('2026-09-17T00:00:00.000Z'),
      matches: [{ role: 'alert', text: '通信 在线' }],
    })
    expect(passed.violated).toBe(false)
    expect(passed.results[0]?.verdict).toBe('PASS')
  })

  it('OCC-07：error_surface + continue 命中仍不 halt', () => {
    const continued = collectErrorSurfaceResults({
      snapshot: {
        runtimeInvariantManifest: {
          entries: [{ ...surfaceInvariant('before_side_effect'), onViolation: 'continue' as const }],
        },
      } as RunSnapshot,
      stepRunId: '00000000-0000-4000-8000-000000000064',
      attemptId: '00000000-0000-4000-8000-000000000065',
      now: new Date('2026-09-17T00:00:00.000Z'),
      matches: [{ role: 'alertdialog', text: '系统异常' }],
    })
    expect(continued.violated).toBe(true)
    expect(continued.halt).toBe(false)
    expect(continued.results[0]?.verdict).toBe('FAIL')
  })

  it('OCC-06: 单次判定纯逻辑远低于一步超时，each_step 默认不调度', () => {
    const started = performance.now()
    for (let i = 0; i < 200; i += 1) {
      collectErrorSurfaceResults({
        snapshot: snapshot('each_step'),
        stepRunId: '00000000-0000-4000-8000-000000000064',
        attemptId: '00000000-0000-4000-8000-000000000065',
        now: new Date(),
        matches: [],
      })
    }
    const elapsedMs = performance.now() - started
    expect(elapsedMs / 200).toBeLessThan(5)
    expect(shouldProbeErrorSurface(snapshot('before_side_effect'), echoStep, 'after')).toBe(false)
  })
})
