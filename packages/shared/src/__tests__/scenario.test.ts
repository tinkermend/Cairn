import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import {
  RUN_ERROR_CODES,
  SCENARIO_ERROR_CODES,
  ScenarioValidationError,
  TARGET_ERROR_CODES,
  assertRunFromResolved,
  createScenarioBodySchema,
  updateScenarioBodySchema,
  validateScenarioDefinition,
  type EchoStep,
} from '../index.js'

const echo = (
  id: string,
  name: string,
  extra: { input: EchoStep['input']; outputKey?: string; policy?: EchoStep['policy'] },
): EchoStep => ({
  id,
  name,
  type: 'echo',
  effectType: 'READ_ONLY',
  ...extra,
})

const ids = {
  a: '00000000-0000-4000-8000-000000000041',
  b: '00000000-0000-4000-8000-000000000042',
  c: '00000000-0000-4000-8000-000000000043',
  target: '00000000-0000-4000-8000-000000000044',
}

describe('validateScenarioDefinition', () => {
  it('接受参数化 from（保存期不要求 input 已存在）', () => {
    const definition = validateScenarioDefinition({
      schemaVersion: 1,
      steps: [echo(ids.a, '回显单号', { input: { from: 'orderId' }, outputKey: 'echoed' })],
    })
    expect(definition.steps).toHaveLength(1)
  })

  it('拒绝指向更晚步骤 outputKey 的 from', () => {
    expect(() =>
      validateScenarioDefinition({
        schemaVersion: 1,
        steps: [
          echo(ids.a, '先读', { input: { from: 'later' } }),
          echo(ids.b, '后写', { input: { value: 1 }, outputKey: 'later' }),
        ],
      }),
    ).toThrow(ScenarioValidationError)
  })

  it('拒绝自引用 from', () => {
    expect(() =>
      validateScenarioDefinition({
        schemaVersion: 1,
        steps: [echo(ids.a, '自指', { input: { from: 'self' }, outputKey: 'self' })],
      }),
    ).toThrow(/不得指向本步/)
  })

  it('接受引用更早步骤的 from', () => {
    const definition = validateScenarioDefinition({
      schemaVersion: 1,
      steps: [
        echo(ids.a, '写', { input: { value: 'hello' }, outputKey: 'greeting' }),
        echo(ids.b, '读', { input: { from: 'greeting' } }),
      ],
    })
    expect(definition.steps[1]?.input).toEqual({ from: 'greeting' })
  })

  it('拒绝超过 32 步', () => {
    const steps = Array.from({ length: 33 }, (_, index) =>
      echo(
        `00000000-0000-4000-8000-${(0x50 + index).toString(16).padStart(12, '0')}`,
        `s${index}`,
        { input: { value: index } },
      ),
    )
    expect(() => validateScenarioDefinition({ schemaVersion: 1, steps })).toThrow(ZodError)
  })
})

describe('assertRunFromResolved', () => {
  const steps = [echo(ids.a, '回显单号', { input: { from: 'orderId' }, outputKey: 'echoed' })]

  it('input 含该键时通过', () => {
    expect(() => assertRunFromResolved(steps, { orderId: 'A-1' })).not.toThrow()
  })

  it('缺少 input 键时拒绝', () => {
    expect(() => assertRunFromResolved(steps, {})).toThrow(ScenarioValidationError)
    try {
      assertRunFromResolved(steps, {})
    } catch (error) {
      expect(error).toMatchObject({ code: 'SCENARIO_UNRESOLVED_REF' })
    }
  })
})

describe('领域码常量', () => {
  it('覆盖方案表中的场景 / Run / Target 增量码', () => {
    expect(SCENARIO_ERROR_CODES).toEqual([
      'SCENARIO_NOT_FOUND',
      'SCENARIO_VERSION_NOT_FOUND',
      'SCENARIO_NAME_CONFLICT',
      'SCENARIO_HAS_RUNS',
      'SCENARIO_UNRESOLVED_REF',
      'SCENARIO_DISABLED',
      'SCENARIO_DRAFT_CONFLICT',
      'SCENARIO_COMPILE_BLOCKED',
      'SCENARIO_VERSION_NOT_PUBLISHED',
    ])
    expect(RUN_ERROR_CODES).toEqual([
      'RUN_NOT_FOUND',
      'RUN_IDEMPOTENCY_CONFLICT',
      'RUN_ACCOUNT_MISMATCH',
      'RUN_ACCOUNT_DISABLED',
      'RUN_NOT_REVIEWABLE',
      'RUN_NOT_WAITING_FOR_AUTH',
      'EVIDENCE_NOT_FOUND',
      'EVIDENCE_NOT_AVAILABLE',
    ])
    expect(TARGET_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'TARGET_HAS_SCENARIOS',
        'TARGET_HAS_RECORDINGS',
        'TARGET_DISABLED',
        'TARGET_ACCOUNT_HAS_RUNS',
      ]),
    )
  })
})

describe('createScenarioBodySchema / updateScenarioBodySchema', () => {
  it('创建体接受最小字段', () => {
    const parsed = createScenarioBodySchema.parse({
      targetId: ids.target,
      name: ' 回显链路 ',
      steps: [echo(ids.a, '回显', { input: { value: 1 } })],
    })
    expect(parsed.name).toBe('回显链路')
    expect(parsed.status).toBeUndefined()
  })

  it('更新体必须至少一项，且禁止 targetId 与 steps', () => {
    expect(() => updateScenarioBodySchema.parse({})).toThrow()
    expect(() =>
      updateScenarioBodySchema.parse({ targetId: ids.target, name: 'x' }),
    ).toThrow()
    expect(() =>
      updateScenarioBodySchema.parse({
        steps: [echo(ids.a, '回显', { input: { value: 1 } })],
      }),
    ).toThrow()
  })
})
