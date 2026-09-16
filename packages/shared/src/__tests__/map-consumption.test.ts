import { describe, expect, it } from 'vitest'
import { browserCommandSchema, browserCommandResultSchema } from '../browser-command.js'
import {
  FACTORY_MAP_CONSUMPTION_POLICY,
  MAP_CONSUMPTION_CONSUMER_VERSION,
  MAP_CONSUMPTION_MAX_CANDIDATES,
  frozenMapConsumptionSchema,
  isMapConsumptionEnabled,
  mapConsumptionOverrideSchema,
  mapConsumptionPolicySchema,
  mapConsumptionPolicyUpdateBodySchema,
  mapConsumptionPolicyDtoSchema,
  mapDecisionListQuerySchema,
} from '../map-consumption.js'

const ids = {
  target: '00000000-0000-4000-8000-000000000001',
  release: '00000000-0000-4000-8000-000000000002',
  step: '00000000-0000-4000-8000-000000000003',
  object: '00000000-0000-4000-8000-000000000004',
}
const digest = 'a'.repeat(64)

describe('map consumption schema', () => {
  it('工厂政策默认关闭且 AI 预算为 0', () => {
    expect(FACTORY_MAP_CONSUMPTION_POLICY.mode).toBe('off')
    expect(FACTORY_MAP_CONSUMPTION_POLICY.maxExtraAiCalls).toBe(0)
    expect(FACTORY_MAP_CONSUMPTION_POLICY.maxCandidateCount).toBeLessThanOrEqual(
      MAP_CONSUMPTION_MAX_CANDIDATES,
    )
  })

  it('缺 Snapshot 字段视为未启用', () => {
    expect(isMapConsumptionEnabled({})).toBe(false)
    expect(isMapConsumptionEnabled({ mapConsumption: { mode: 'off' } })).toBe(false)
  })

  it('启用冻结要求 policy.mode 与外层一致', () => {
    expect(() =>
      frozenMapConsumptionSchema.parse({
        mode: 'shadow',
        releaseId: ids.release,
        targetId: ids.target,
        manifestDigest: digest,
        sourceWatermark: 1,
        policy: mapConsumptionPolicySchema.parse({
          schemaVersion: 1,
          mode: 'read_only_fallback',
        }),
        bindings: [],
        consumerVersion: MAP_CONSUMPTION_CONSUMER_VERSION,
        frozenAt: '2026-09-16T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('可操作绑定必须带对象实现版本', () => {
    expect(() =>
      frozenMapConsumptionSchema.parse({
        mode: 'shadow',
        releaseId: ids.release,
        targetId: ids.target,
        manifestDigest: digest,
        sourceWatermark: 1,
        policy: mapConsumptionPolicySchema.parse({ schemaVersion: 1, mode: 'shadow' }),
        bindings: [
          {
            stepId: ids.step,
            slotKey: 'step:extract',
            assetRef: { targetId: ids.target, pageId: ids.object },
            bindingDigest: digest,
          },
        ],
        consumerVersion: MAP_CONSUMPTION_CONSUMER_VERSION,
        frozenAt: '2026-09-16T00:00:00.000Z',
      }),
    ).toThrow()
  })

  it('创建覆盖只能收窄为 off 或指定 release', () => {
    expect(mapConsumptionOverrideSchema.parse({ mode: 'off' }).mode).toBe('off')
    expect(() => mapConsumptionOverrideSchema.parse({ mode: 'shadow' })).toThrow()
    expect(mapConsumptionOverrideSchema.parse({ releaseId: ids.release }).releaseId).toBe(ids.release)
  })

  it('政策更新不能把 extra AI 打开', () => {
    const parsed = mapConsumptionPolicyUpdateBodySchema.parse({
      expectedRevision: 0,
      idempotencyKey: 'policy:shadow-1',
      mode: 'shadow',
      reason: '仅比较',
    })
    expect(parsed.mode).toBe('shadow')
    expect(() =>
      mapConsumptionPolicySchema.parse({
        schemaVersion: 1,
        mode: 'shadow',
        maxExtraAiCalls: 1,
      }),
    ).toThrow()
  })
  it('定位预算和一次性目标凭据经过 Runtime Schema 校验', () => {
    expect(() => mapDecisionListQuerySchema.parse({ cursor: 'invalid' })).toThrow()
    const target = { framePath: [], candidates: [{ by: 'text', value: 'value' }] }
    expect(() => browserCommandSchema.parse({ type: 'locate', target, timeoutMs: 5001 })).toThrow()
    expect(browserCommandSchema.parse({ type: 'extract', target, as: 'text', expectedTargetToken: ids.object })).toMatchObject({ expectedTargetToken: ids.object })
    expect(() => browserCommandSchema.parse({ type: 'extract', target, as: 'text', expectedTargetToken: 'not-a-token' })).toThrow()
    expect(browserCommandResultSchema.parse({ ok: true, output: {}, resolvedTargetToken: ids.object })).toMatchObject({ resolvedTargetToken: ids.object })
  })

  it('确认错配后的资格冻结在控制面契约中可见', () => {
    expect(mapConsumptionPolicyDtoSchema.parse({
      targetId: ids.target,
      revision: 1,
      policy: mapConsumptionPolicySchema.parse({ schemaVersion: 1, mode: 'read_only_fallback' }),
      eligibility: {
        reportId: 'omt-feedback-1', eligibleStepTypes: ['extract'], recordedAt: '2026-09-16T00:00:00.000Z',
        suspendedAt: '2026-09-16T00:01:00.000Z', suspensionReason: '确认错配',
      },
      updatedAt: '2026-09-16T00:00:00.000Z',
    }).eligibility).toMatchObject({ suspendedAt: '2026-09-16T00:01:00.000Z' })
  })

})
