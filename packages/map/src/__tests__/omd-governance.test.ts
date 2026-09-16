import { describe, expect, it } from 'vitest'
import { mapAssetRefKey, type MapAssetDetail, type MapIdentityAlias } from '@cairn/shared'
import {
  applyDetailApplicability,
  applyGovernanceOverlay,
  cluesFromScenarioStep,
  gradeMapImpact,
  groupMapDiagnosisClues,
  mapListQueryKey,
  proposeMapReferenceCandidates,
  resolveBindingAfterIdentity,
} from '../governance.js'

const targetId = '11111111-1111-4111-8111-111111111111'
const pageId = '33333333-3333-4333-8333-333333333333'
const objectId = '44444444-4444-4444-8444-444444444444'

describe('OM-D 治理规则', () => {
  it('overlay 只覆盖 TRUSTED/RETIRED，restore 后透出投影生命周期', () => {
    expect(applyGovernanceOverlay('VERIFIED', 'TRUSTED')).toBe('TRUSTED')
    expect(applyGovernanceOverlay('OBSERVED', 'RETIRED')).toBe('RETIRED')
    expect(applyGovernanceOverlay('VERIFIED')).toBe('VERIFIED')
  })

  it('查询键区分 Target 与视图，避免跨页复用', () => {
    expect(mapListQueryKey({ targetId, kind: 'objects' })).not.toEqual(
      mapListQueryKey({ targetId: pageId, kind: 'objects' }),
    )
    expect(mapListQueryKey({ targetId, kind: 'objects', projectionId: pageId })).not.toEqual(
      mapListQueryKey({ targetId, kind: 'objects', projectionId: objectId }),
    )
  })

  it('存量扫描只给候选，不把同名按钮直接当成引用', () => {
    const candidates = proposeMapReferenceCandidates({
      steps: [
        cluesFromScenarioStep({
          id: objectId,
          type: 'click',
          name: '保存',
          input: { target: { candidates: [{ by: 'role', value: 'button', name: '保存' }] } },
        }),
        cluesFromScenarioStep({
          id: pageId,
          type: 'navigate',
          input: { url: 'https://shop.example/orders' },
        }),
      ],
      assets: [
        {
          assetRefKey: mapAssetRefKey({ objectId }),
          objectId,
          semanticName: '保存',
          role: 'button',
          routeTemplate: 'https://shop.example/orders',
        },
      ],
    })
    expect(candidates.some((item) => item.reasons.includes('semantic-name'))).toBe(true)
    expect(candidates.some((item) => item.reasons.includes('route-template'))).toBe(true)
  })

  it('影响分级：确切绑定优先，未扫描才是 unknown', () => {
    const graded = gradeMapImpact({
      changedAssetKeys: ['obj:a'],
      bindings: [{ scenarioId: 's1', assetRefKey: 'obj:a', stepId: objectId }],
      candidates: [{ scenarioId: 's2', assetRefKey: 'obj:a', reasons: ['semantic-name'] }],
      scannedScenarioIds: ['s1', 's2'],
      visibleScenarioIds: ['s1', 's2', 's3'],
    })
    expect(graded.items.find((item) => item.scenarioId === 's1')?.grade).toBe('confirmed_reference')
    expect(graded.items.find((item) => item.scenarioId === 's2')?.grade).toBe('potential_match')
    expect(graded.items.find((item) => item.scenarioId === 's3')?.grade).toBe('unknown_coverage')
    expect(graded.notes[0]).toMatch(/不能据此认定场景必然失败/)
  })

  it('拆分后不能唯一映射则待确认，不自动落到一个子对象', () => {
    const aliases: MapIdentityAlias[] = [
      {
        revision: 2,
        action: 'split',
        oldObjectId: objectId,
        newObjectId: pageId,
      },
      {
        revision: 2,
        action: 'split',
        oldObjectId: objectId,
        newObjectId: targetId,
      },
    ]
    expect(resolveBindingAfterIdentity({ binding: { objectId }, aliases, action: 'split' }).resolution).toBe(
      'pending_confirmation',
    )
  })

  it('业务拒绝且定位成功时不宣称页面改版', () => {
    const result = groupMapDiagnosisClues([
      { dimension: 'locator', verdict: 'confirmed' },
      { dimension: 'business', verdict: 'rejected', note: '库存不足' },
    ])
    expect(result.clues.find((item) => item.dimension === 'locator')?.verdict).toBe('confirmed')
    expect(result.clues.find((item) => item.dimension === 'business')?.verdict).toBe('rejected')
    expect(result.counterExamples[0]).toMatch(/不能据此宣称页面改版/)
  })

  it('详情适用性由 evaluateCondition 得出，无查询条件则为 unknown', () => {
    const detail: MapAssetDetail = {
      assetRef: { targetId, objectId },
      assetRefKey: mapAssetRefKey({ objectId }),
      lifecycle: 'VERIFIED' as const,
      dimensions: [],
      unknownFields: [],
      changeCount: 0,
      evidenceAvailability: 'available' as const,
      implementations: [
        {
          implementationKey: 'impl:v1:zh',
          conditionUnknownFields: [],
          conditionSnapshot: {
            targetId,
            accountBinding: { presence: 'anonymous' as const },
            locale: 'zh-CN',
            unknownFields: ['permissionProfile', 'workspace', 'viewport', 'featureVersion'],
          },
        },
      ],
      identityHistory: [],
      view: {
        viewRef: { kind: 'missing' as const },
        identityRevision: 0,
        governanceRevision: 0,
        publicationRevision: 0,
        computedAt: '2026-09-16T00:00:00.000Z',
      },
    }
    expect(applyDetailApplicability(detail).applicability).toBe('unknown')
    expect(
      applyDetailApplicability(detail, {
        targetId,
        accountBinding: { presence: 'anonymous' },
        locale: 'zh-CN',
        unknownFields: ['permissionProfile', 'workspace', 'viewport', 'featureVersion'],
      }).applicability,
    ).toBe('satisfied')
    expect(
      applyDetailApplicability(detail, {
        targetId,
        accountBinding: { presence: 'anonymous' },
        locale: 'en-US',
        unknownFields: ['permissionProfile', 'workspace', 'viewport', 'featureVersion'],
      }).applicability,
    ).toBe('unsatisfied')
  })
  it('合并后的影响沿多次身份纠正反查，并保留原始绑定', () => {
    const movedId = '55555555-5555-4555-8555-555555555555'
    const finalId = '66666666-6666-4666-8666-666666666666'
    const originalKey = mapAssetRefKey({ objectId })
    const result = gradeMapImpact({
      changedAssetKeys: [mapAssetRefKey({ objectId: finalId })],
      bindings: [{ scenarioId: targetId, assetRefKey: originalKey, assetRef: { targetId, objectId } }],
      candidates: [], scannedScenarioIds: [targetId], visibleScenarioIds: [targetId],
      identityAliases: [
        { revision: 1, action: 'merge', oldObjectId: objectId, newObjectId: movedId },
        { revision: 2, action: 'alias', oldObjectId: movedId, newObjectId: finalId },
      ],
    })
    expect(result.items[0]?.assetRefKey).toBe(originalKey)
    expect(result.items[0]?.reasons).toContain('identity-alias')
  })

})
