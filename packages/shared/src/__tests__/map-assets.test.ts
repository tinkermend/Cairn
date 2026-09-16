import { describe, expect, it } from 'vitest'
import {
  MAP_ASSETS_PROTOCOL,
  mapImplementationKey,
  mapIdentityCommandSchema,
  mapProjectionPlanSchema,
  mapQueryRequestSchema,
  overlayMapFreshness,
} from '../map-assets.js'
import { mapReleaseManifestSchema } from '../map-release.js'

const targetId = '11111111-1111-4111-8111-111111111111'
const actorId = '22222222-2222-4222-8222-222222222222'
const pageId = '33333333-3333-4333-8333-333333333333'
const objectId = '44444444-4444-4444-8444-444444444444'

describe('OM-C 资产契约', () => {
  it('实现键按 locale/viewport/角色/工作区拆开', () => {
    expect(MAP_ASSETS_PROTOCOL).toBe('map-assets@1')
    expect(
      mapImplementationKey({
        locale: 'zh-CN',
        viewport: { category: 'desktop' },
        permissionProfile: { source: 'rbac', version: 'v1' },
        workspace: 'ops',
      }),
    ).toBe('impl:v1:zh-CN:desktop:rbac.v1:ops:u')
    expect(
      mapImplementationKey({
        locale: 'en',
        viewport: { category: 'mobile' },
        permissionProfile: { source: 'rbac', version: 'v2' },
        workspace: 'finance',
      }),
    ).not.toBe(
      mapImplementationKey({
        locale: 'zh-CN',
        viewport: { category: 'desktop' },
        permissionProfile: { source: 'rbac', version: 'v1' },
        workspace: 'ops',
      }),
    )
  })

  it('查询视图互斥；身份命令不能跨 Target', () => {
    expect(
      mapQueryRequestSchema.safeParse({
        targetId,
        view: { kind: 'release', releaseId: pageId, manifestDigest: 'a'.repeat(64) },
      }).success,
    ).toBe(true)
    expect(
      mapIdentityCommandSchema.safeParse({
        targetId,
        expectedIdentityRevision: 0,
        commandKey: 'cmd:merge-1',
        action: 'merge',
        oldRefs: [
          { targetId, objectId },
          { targetId: pageId, objectId },
        ],
        newRefs: [{ targetId, objectId }],
        reason: '误合并纠正',
        evidenceRefs: [],
        actorId,
      }).success,
    ).toBe(false)
  })

  it('新鲜度到期只标 STALE，不改 RETIRED', () => {
    const stale = overlayMapFreshness({
      lifecycle: 'VERIFIED',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z',
      asOf: '2026-02-01T00:00:00.000Z',
      freshnessMs: 7 * 24 * 3600 * 1000,
    })
    expect(stale.lifecycle).toBe('STALE')
    expect(
      overlayMapFreshness({
        lifecycle: 'RETIRED',
        lastVerifiedAt: '2026-01-01T00:00:00.000Z',
        asOf: '2026-02-01T00:00:00.000Z',
      }).lifecycle,
    ).toBe('RETIRED')
  })

  it('空规划与最小 manifest 可通过', () => {
    expect(
      mapProjectionPlanSchema.parse({
        protocol: 'map-assets@1',
        algorithmVersion: 'map-identity@1',
        pages: [],
        objects: [],
        assignments: [],
        implementations: [],
        descriptors: [],
        assets: [],
        conflicts: [],
        nextCursor: 0,
      }).nextCursor,
    ).toBe(0)
    expect(
      mapReleaseManifestSchema.parse({
        protocol: 'map-assets@1',
        algorithmVersion: 'map-identity@1',
        targetId,
        projectionId: pageId,
        policyVersion: 'map-assets@1',
        sourceWatermark: 3,
        identityRevision: 1,
        projectionRevision: 2,
        items: [],
      }).items,
    ).toEqual([])
  })
})
