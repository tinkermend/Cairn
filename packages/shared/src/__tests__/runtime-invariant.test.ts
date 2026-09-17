import { describe, expect, it } from 'vitest'
import { aggregateRunOutcomeStatus } from '../outcome.js'
import {
  classifyErrorSurface,
  createRuntimeInvariant,
  deriveRuntimeInvariantResults,
  joinRuntimeInvariantEvaluations,
  redactErrorSurfaceText,
  runtimeInvariantSchema,
  type RuntimeInvariant,
  type RuntimeInvariantWindow,
} from '../runtime-invariant.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const baseWindow = (extra: Partial<RuntimeInvariantWindow> = {}): RuntimeInvariantWindow => ({
  stepId: id(1),
  stepRunId: id(2),
  attemptId: id(3),
  stepType: 'navigate',
  effectType: 'IDEMPOTENT',
  status: 'SUCCEEDED',
  ...extra,
})

describe('OCC-01 RuntimeInvariant Schema', () => {
  it('接受五类正例', () => {
    for (const kind of [
      'navigation_boundary',
      'auth_validity',
      'effect_ceiling',
      'readonly_guarantee',
      'error_surface',
    ] as const) {
      expect(runtimeInvariantSchema.parse(createRuntimeInvariant(kind, id(10))).kind).toBe(kind)
    }
  })

  it('error_surface 配 step_boundary 被拒', () => {
    expect(() =>
      runtimeInvariantSchema.parse({
        ...createRuntimeInvariant('error_surface', id(11)),
        evaluateAt: 'step_boundary',
      }),
    ).toThrow(/必须在步骤后或副作用前看页面/)
  })

  it('SHOULD / INFO 配 halt 被拒', () => {
    expect(() =>
      runtimeInvariantSchema.parse({
        ...createRuntimeInvariant('auth_validity', id(12)),
        onViolation: 'halt',
      }),
    ).toThrow(/SHOULD 运行期约束不允许配置 halt/)
    expect(() =>
      runtimeInvariantSchema.parse({
        ...createRuntimeInvariant('error_surface', id(13)),
        severity: 'INFO',
        onViolation: 'halt',
      }),
    ).toThrow(/INFO 运行期约束不允许配置 halt/)
  })

  it('auth_validity 默认 SHOULD + continue', () => {
    const created = createRuntimeInvariant('auth_validity', id(14))
    expect(created.severity).toBe('SHOULD')
    expect(created.onViolation).toBe('continue')
  })
})

describe('派生规则', () => {
  it('越界导航写 FAIL，未越界且已停机写 PASS，无窗口不写', () => {
    const invariant = createRuntimeInvariant('navigation_boundary', id(20))
    const fail = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [
        baseWindow({
          status: 'FAILED',
          errorCode: 'NAVIGATE_OUT_OF_SCOPE',
        }),
      ],
      runFinished: false,
    })
    expect(fail).toHaveLength(1)
    expect(fail[0]?.verdict).toBe('FAIL')
    expect(fail[0]?.actual).toMatchObject({ errorCode: 'NAVIGATE_OUT_OF_SCOPE' })

    const handoff = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [
        baseWindow({
          status: 'FAILED',
          errorCode: 'PAGE_HANDOFF_OUT_OF_SCOPE',
        }),
      ],
      runFinished: false,
    })
    expect(handoff[0]?.actual).toMatchObject({ errorCode: 'PAGE_HANDOFF_OUT_OF_SCOPE' })

    const pass = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow()],
      runFinished: true,
    })
    expect(pass[0]?.verdict).toBe('PASS')

    expect(
      deriveRuntimeInvariantResults({
        invariants: [invariant],
        windows: [],
        runFinished: true,
      }),
    ).toEqual([])
  })

  it('认证失效即使恢复也写 FAIL；无 checkpoint 且已停机写 PASS', () => {
    const invariant = createRuntimeInvariant('auth_validity', id(21))
    const recovered = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow()],
      authCheckpoint: {
        status: 'recovered',
        autoRecoveriesUsed: 1,
        manualRecoveriesUsed: 0,
        nextStepId: id(1),
      },
      runFinished: true,
    })
    expect(recovered[0]?.verdict).toBe('FAIL')

    const counted = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow()],
      authCheckpoint: {
        status: 'closed',
        autoRecoveriesUsed: 1,
        manualRecoveriesUsed: 0,
        nextStepId: id(1),
      },
      runFinished: false,
    })
    expect(counted[0]?.verdict).toBe('FAIL')

    const held = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow()],
      runFinished: true,
    })
    expect(held[0]?.verdict).toBe('PASS')

    expect(
      deriveRuntimeInvariantResults({
        invariants: [invariant],
        windows: [baseWindow()],
        runFinished: false,
      }),
    ).toEqual([])

    const waiting = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow()],
      runFinished: false,
      runStatus: 'WAITING_FOR_AUTH',
    })
    expect(waiting[0]).toMatchObject({
      verdict: 'FAIL',
      actual: { status: 'waiting_for_auth' },
    })

    expect(
      deriveRuntimeInvariantResults({
        invariants: [invariant],
        windows: [],
        runFinished: false,
        runStatus: 'WAITING_FOR_AUTH',
      }),
    ).toEqual([])
  })

  it('只读对照 SIDE_EFFECT 记 FAIL，全程只读记 PASS', () => {
    const invariant = createRuntimeInvariant('readonly_guarantee', id(22))
    const failed = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow({ stepType: 'click', effectType: 'SIDE_EFFECT' })],
      runFinished: true,
    })
    expect(failed[0]?.verdict).toBe('FAIL')

    const passed = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow({ effectType: 'READ_ONLY' })],
      runFinished: true,
    })
    expect(passed[0]?.verdict).toBe('PASS')
  })

  it('模块步骤超出 ceiling 记 FAIL；无模块步骤不写', () => {
    const invariant = createRuntimeInvariant('effect_ceiling', id(23))
    const failed = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [
        baseWindow({
          effectType: 'SIDE_EFFECT',
          moduleId: id(30),
          moduleEffectCeiling: 'READ_ONLY',
        }),
      ],
      runFinished: true,
    })
    expect(failed[0]?.verdict).toBe('FAIL')

    expect(
      deriveRuntimeInvariantResults({
        invariants: [invariant],
        windows: [baseWindow({ effectType: 'SIDE_EFFECT' })],
        runFinished: true,
      }),
    ).toEqual([])
  })

  it('错误弹窗探测命中写 FAIL；探测过且未命中写 PASS；未探测不写', () => {
    const invariant = createRuntimeInvariant('error_surface', id(24))
    const failed = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow()],
      errorSurfaces: [
        {
          attemptId: id(3),
          stepRunId: id(2),
          stepId: id(1),
          probed: true,
          matches: [{ role: 'alertdialog', text: '系统异常：保存失败' }],
        },
      ],
      runFinished: true,
    })
    expect(failed[0]?.verdict).toBe('FAIL')

    const passed = deriveRuntimeInvariantResults({
      invariants: [invariant],
      windows: [baseWindow()],
      errorSurfaces: [
        {
          attemptId: id(3),
          stepRunId: id(2),
          stepId: id(1),
          probed: true,
          matches: [],
        },
      ],
      runFinished: true,
    })
    expect(passed[0]?.verdict).toBe('PASS')

    expect(
      deriveRuntimeInvariantResults({
        invariants: [invariant],
        windows: [baseWindow()],
        runFinished: true,
      }),
    ).toEqual([])
  })
})

describe('探测分类与脱敏', () => {
  it('role=alert 无错误语义不误报', () => {
    expect(classifyErrorSurface([{ role: 'alert', text: '通信 在线' }]).violated).toBe(false)
    expect(classifyErrorSurface([{ role: 'alertdialog', text: '保存失败' }]).violated).toBe(true)
  })

  it('脱敏口令与邮箱', () => {
    expect(redactErrorSurfaceText('password=hunter2 user@example.com')).toBe(
      'password=*** [redacted-email]',
    )
  })
})

describe('OCC-08 聚合与左连接', () => {
  it('SHOULD 不变量 FAIL 使结果轴 WARN', () => {
    const invariant: RuntimeInvariant = createRuntimeInvariant('auth_validity', id(40))
    expect(
      aggregateRunOutcomeStatus(undefined, [{ contractId: invariant.id, verdict: 'FAIL' }], {
        entries: [invariant],
      }),
    ).toBe('WARN')
  })

  it('MUST 不变量缺行是 UNKNOWN，不得推定 PASS', () => {
    const invariant: RuntimeInvariant = createRuntimeInvariant('navigation_boundary', id(41))
    expect(aggregateRunOutcomeStatus(undefined, [], { entries: [invariant] })).toBe('UNKNOWN')
  })

  it('左连接缺行显示未求值，多行取最坏', () => {
    const invariant = createRuntimeInvariant('navigation_boundary', id(42))
    const joined = joinRuntimeInvariantEvaluations(
      { entries: [invariant] },
      [
        {
          id: id(50),
          runId: id(51),
          stepRunId: id(2),
          attemptId: id(3),
          contractId: invariant.id,
          scope: 'scenario',
          meaning: invariant.meaning,
          severity: invariant.severity,
          onViolation: invariant.onViolation,
          provenance: 'runtime_invariant',
          verdict: 'PASS',
          evaluatedAt: '2026-09-17T00:00:00.000Z',
        },
        {
          id: id(52),
          runId: id(51),
          stepRunId: id(2),
          attemptId: id(4),
          contractId: invariant.id,
          scope: 'scenario',
          meaning: invariant.meaning,
          severity: invariant.severity,
          onViolation: invariant.onViolation,
          provenance: 'runtime_invariant',
          verdict: 'FAIL',
          evaluatedAt: '2026-09-17T00:00:01.000Z',
        },
      ],
    )
    expect(joined[0]?.displayVerdict).toBe('FAIL')
    expect(joinRuntimeInvariantEvaluations({ entries: [invariant] }, [])[0]?.displayVerdict).toBe(
      'NOT_EVALUATED',
    )
  })
})
