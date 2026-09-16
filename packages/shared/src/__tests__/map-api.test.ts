import { describe, expect, it } from 'vitest'
import {
  deriveMapEvidenceAvailability,
  mapGovernanceCommandBodySchema,
  mapGovernancePreviewBodySchema,
  mapListQuerySchema,
  mapScenarioBindingBodySchema,
  mapViewMetaSchema,
} from '../map-api.js'
import { mapSealReleaseInputSchema } from '../map-release.js'

const targetId = '11111111-1111-4111-8111-111111111111'
const objectId = '44444444-4444-4444-8444-444444444444'
const actorId = '22222222-2222-4222-8222-222222222222'
const projectionId = '33333333-3333-4333-8333-333333333333'

describe('OM-D 查询与治理契约', () => {
  it('列表查询拒绝 projection 与 release 混读，并解析条件 JSON', () => {
    expect(mapListQuerySchema.safeParse({ projectionId, releaseId: objectId }).success).toBe(false)
    const parsed = mapListQuerySchema.parse({
      projectionId,
      conditionSnapshot: JSON.stringify({
        targetId,
        accountBinding: { presence: 'anonymous' },
        unknownFields: ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
      }),
    })
    expect(parsed.limit).toBe(20)
    expect(parsed.conditionSnapshot?.unknownFields).toContain('workspace')
  })

  it('身份纠正与 overlay 使用不同修订字段', () => {
    expect(
      mapGovernancePreviewBodySchema.safeParse({
        kind: 'correct_identity',
        reason: '拆错了',
        expectedGovernanceRevision: 1,
      }).success,
    ).toBe(false)
    expect(
      mapGovernanceCommandBodySchema.safeParse({
        kind: 'retire',
        reason: '下线旧入口',
        expectedGovernanceRevision: 1,
        idempotencyKey: 'cmd:retire-1',
        assetRef: { targetId, objectId },
      }).success,
    ).toBe(true)
    expect(
      mapGovernancePreviewBodySchema.safeParse({
        kind: 'retire',
        reason: '下线旧入口',
        expectedGovernanceRevision: 1,
      }).success,
    ).toBe(false)
  })

  it('无投影 viewRef 是 missing，不用哨兵 UUID', () => {
    expect(mapViewMetaSchema.parse({
      viewRef: { kind: 'missing' },
      identityRevision: 0,
      governanceRevision: 0,
      publicationRevision: 0,
      computedAt: '2026-09-16T00:00:00.000Z',
    }).viewRef.kind).toBe('missing')
  })

  it('证据可用性：封存可用，部分重建为 partial，无核验为 unavailable', () => {
    expect(deriveMapEvidenceAvailability({ sealed: true, changeCount: 0, hasDimensions: false })).toBe('available')
    expect(
      deriveMapEvidenceAvailability({
        sealed: false,
        rebuildCompleteness: 'partial',
        changeCount: 1,
        hasDimensions: true,
      }),
    ).toBe('partial')
    expect(deriveMapEvidenceAvailability({ sealed: false, changeCount: 0, hasDimensions: false })).toBe('unavailable')
  })

  it('页面级绑定不能虚构 stepId', () => {
    expect(
      mapScenarioBindingBodySchema.safeParse({
        scenarioId: objectId,
        stepId: actorId,
        assetRef: { targetId, objectId },
        expectedDraftRevision: 1,
        scopeKind: 'page_context',
      }).success,
    ).toBe(false)
  })

  it('封存可快照治理 overlay', () => {
    const parsed = mapSealReleaseInputSchema.parse({
      targetId,
      projectionId,
      expectedProjectionRevision: 1,
      policyVersion: 'map-assets@1',
      commandKey: 'cmd:seal-1',
      actorId,
      lifecycleOverrides: [{ assetRefKey: 'p:x:o:44444444-4444-4444-8444-444444444444:i:x:d:0', lifecycle: 'TRUSTED' }],
    })
    expect(parsed.lifecycleOverrides?.[0]?.lifecycle).toBe('TRUSTED')
  })
})
