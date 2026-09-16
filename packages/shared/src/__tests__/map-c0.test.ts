import { describe, expect, it } from 'vitest'
import {
  MAP_FACT_MAX_BYTES,
  MAP_FACTS_PROTOCOL,
  assertMapFactSize,
  containsSensitiveMapFields,
  mapConditionSnapshotSchema,
  mapObservationSchema,
  mapUtcInstantSchema,
  mapVerificationClaimSchema,
  mapVerificationSchema,
  type MapObservation,
  type MapVerification,
} from '../map-c0.js'

const targetId = '11111111-1111-4111-8111-111111111111'
const runId = '22222222-2222-4222-8222-222222222222'
const stepRunId = '33333333-3333-4333-8333-333333333333'
const attemptId = '44444444-4444-4444-8444-444444444444'
const observationId = '55555555-5555-4555-8555-555555555555'
const accountId = '66666666-6666-4666-8666-666666666666'

function validCondition(unknown: string[] = []) {
  return {
    targetId,
    accountBinding: { presence: 'known' as const, targetAccountId: accountId },
    permissionProfile: { source: 'rbac', version: 'v1' },
    workspace: 'ops',
    locale: 'zh-CN',
    viewport: { category: 'desktop' as const, widthPx: 1440, heightPx: 900 },
    featureVersion: '2026.9',
    unknownFields: unknown,
  }
}

function observationInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: observationId,
    schemaVersion: 1,
    targetId,
    dedupeKey: 'run:step:before:0',
    observedAt: '2026-09-16T00:00:00.000Z',
    collectorVersion: 'map-collector@1',
    sourceType: 'formal_run',
    sourceRef: { sourceType: 'formal_run', runId, stepRunId, attemptId },
    phase: 'before_action',
    localSequence: 0,
    sourceEventKey: 'run:step:before:0',
    conditionSnapshot: validCondition(),
    topUrlPattern: 'https://shop.example/orders',
    framePath: [],
    originChain: ['https://shop.example'],
    surfaceCapability: { frames: 'ok', a11y: 'ok', canvas: 'unknown', shadow: 'ok' },
    regionRefs: [{ key: 'action', kind: 'action_object' }],
    nodeSetKind: 'action_object',
    completeness: 'partial',
    truncated: true,
    missingReasons: ['TRUNCATED'],
    semanticSummary: { predicates: [{ name: 'ready', value: true }] },
    stateSummary: { regions: { list: { empty: false } } },
    structuralSummary: { nodeCount: 12, truncated: true },
    evidenceRefs: [],
    captureStatus: 'observed',
    ...overrides,
  }
}

function validObservation(overrides: Record<string, unknown> = {}): MapObservation {
  return mapObservationSchema.parse(observationInput(overrides))
}

describe('OM-A C0 契约', () => {
  it('OMA01 合法 UUID、UTC 与部分未知条件可通过', () => {
    expect(MAP_FACTS_PROTOCOL).toBe('map-facts@1')
    const parsed = mapObservationSchema.parse(
      validObservation({
        conditionSnapshot: {
          targetId,
          accountBinding: { presence: 'unknown' },
          unknownFields: ['targetAccount', 'permissionProfile', 'workspace'],
        },
      }),
    )
    expect(parsed.conditionSnapshot.accountBinding.presence).toBe('unknown')
    expect(mapUtcInstantSchema.parse('2026-09-16T00:00:00.000Z')).toBe('2026-09-16T00:00:00.000Z')
  })

  it('OMA01 非 UTC、缺失未知声明或把 anonymous 写入账号 ID 均拒绝', () => {
    expect(mapUtcInstantSchema.safeParse('2026-09-16T08:00:00+08:00').success).toBe(false)
    expect(
      mapConditionSnapshotSchema.safeParse({
        targetId,
        accountBinding: { presence: 'unknown' },
        unknownFields: [],
      }).success,
    ).toBe(false)
    expect(
      mapConditionSnapshotSchema.safeParse({
        targetId,
        accountBinding: { presence: 'known', targetAccountId: accountId },
        unknownFields: ['targetAccount'],
      }).success,
    ).toBe(false)
    expect(
      mapConditionSnapshotSchema.safeParse({
        targetId,
        accountBinding: { presence: 'anonymous', targetAccountId: 'anonymous' },
        unknownFields: [],
      }).success,
    ).toBe(false)
    expect(
      mapObservationSchema.safeParse(
        observationInput({
          sourceType: 'formal_run',
          sourceRef: { sourceType: 'trial', runId, stepRunId, attemptId },
        }),
      ).success,
    ).toBe(false)
  })

  it('公开表面用 anonymous 绑定，不伪造 TargetAccount', () => {
    const parsed = mapConditionSnapshotSchema.parse({
      targetId,
      accountBinding: { presence: 'anonymous' },
      unknownFields: ['permissionProfile'],
    })
    expect(parsed.accountBinding).toEqual({ presence: 'anonymous' })
  })

  it('descriptorVersion 必须带 objectId 与 implementationKey', () => {
    expect(
      mapObservationSchema.safeParse(
        observationInput({
          assetRef: { targetId, descriptorVersion: 2 },
        }),
      ).success,
    ).toBe(false)
    expect(
      mapObservationSchema.parse(
        validObservation({
          assetRef: {
            targetId,
            pageId: '77777777-7777-4777-8777-777777777777',
            objectId: '88888888-8888-4888-8888-888888888888',
            implementationKey: 'desktop-zh',
            descriptorVersion: 2,
          },
        }),
      ).assetRef?.implementationKey,
    ).toBe('desktop-zh')
  })

  it('跳过步骤不得携带 attemptId；采集缺口必须给原因', () => {
    expect(
      mapObservationSchema.safeParse(
        observationInput({
          phase: 'step_skipped',
          sourceRef: { sourceType: 'formal_run', runId, stepRunId, attemptId },
        }),
      ).success,
    ).toBe(false)
    expect(
      mapObservationSchema.parse(
        validObservation({
          phase: 'step_skipped',
          sourceRef: { sourceType: 'formal_run', runId, stepRunId },
          captureStatus: 'skipped',
          captureReason: 'NOT_APPLICABLE',
        }),
      ).sourceRef,
    ).not.toHaveProperty('attemptId')
    expect(
      mapObservationSchema.safeParse(
        observationInput({
          captureStatus: 'missing',
          missingReasons: [],
          captureReason: undefined,
        }),
      ).success,
    ).toBe(false)
  })

  it('OMA10 凭据键、超上限与未知版本被拒绝', () => {
    expect(containsSensitiveMapFields({ semanticSummary: { password: 'x' } })).toBe(
      'semanticSummary.password',
    )
    expect(
      mapObservationSchema.safeParse(observationInput({ topUrlPattern: 'https://user:pass@shop.example/' }))
        .success,
    ).toBe(false)
    expect(mapObservationSchema.safeParse(observationInput({ schemaVersion: 2 })).success).toBe(false)
    const huge = { text: 'n'.repeat(MAP_FACT_MAX_BYTES + 8) }
    expect(() => assertMapFactSize(huge, '观察')).toThrow(/超过/)
    expect(
      mapVerificationClaimSchema.safeParse({
        proposition: 'ok',
        expected: { success: true },
      }).success,
    ).toBe(false)
  })

  it('评价必须绑定观察且更正要有原因', () => {
    const verification: MapVerification = mapVerificationSchema.parse({
      id: '99999999-9999-4999-8999-999999999999',
      schemaVersion: 1,
      targetId,
      dedupeKey: 'verify:locator:1',
      observationIds: [observationId],
      dimension: 'locator',
      verdict: 'confirmed',
      claim: { proposition: '唯一命中订单搜索按钮' },
      evidenceRefs: [],
      evaluatedAt: '2026-09-16T00:00:01.000Z',
      evaluatorVersion: 'rule@1',
      verificationSource: {
        kind: 'rule',
        runId,
        stepRunId,
        attemptId,
        ruleRef: 'unique-match',
        sourceEventKey: 'verify:locator:1',
        sourceVersion: 'rule@1',
      },
    })
    expect(verification.observationIds).toEqual([observationId])
    expect(
      mapVerificationSchema.safeParse({
        ...verification,
        supersedesVerificationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }).success,
    ).toBe(false)
  })
})
