import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  MAP_ASSETS_PROTOCOL,
  MAP_IDENTITY_RULE_VERSION,
  mapObservationSchema,
  type MapFactCaller,
  type MapObservation,
  type MapProjectionPlan,
} from '@cairn/shared'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  appendMapObservation,
  applyMapIdentityCommand,
  commitMapProjectionBatch,
  DomainError,
  ensureMapProjection,
  expireMapFactContents,
  getMapRelease,
  loadMapProjectionState,
  loadMapQueryView,
  mapProjectionTestHooks,
  sealMapRelease,
  startMapProjectionRebuild,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

function emptyPlan(nextCursor: number, overrides: Partial<MapProjectionPlan> = {}): MapProjectionPlan {
  return {
    protocol: MAP_ASSETS_PROTOCOL,
    algorithmVersion: MAP_IDENTITY_RULE_VERSION,
    pages: [],
    objects: [],
    assignments: [],
    implementations: [],
    descriptors: [],
    assets: [],
    conflicts: [],
    nextCursor,
    ...overrides,
  }
}

describe.each(DRIVERS)('%s 地图投影与封存', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string
  let otherTargetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_proj_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    otherTargetId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-proj',
      email: `map-proj-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values([
      { id: otherTargetId, code: `proj-b-${otherTargetId}`, name: '另一目标', entryUrl: 'https://other.example' },
    ])
  })

  afterAll(async () => {
    await handle?.close()
  })

  afterEach(() => {
    mapProjectionTestHooks.beforeAdvanceCursor = null
    mapProjectionTestHooks.beforeInsertReleaseItems = null
  })

  async function freshTarget(): Promise<string> {
    const { targets } = schemaFor(handle.db)
    const id = newId()
    await handle.db.insert(targets).values({
      id,
      code: `proj-${id}`,
      name: '投影夹具',
      entryUrl: 'https://shop.example',
    })
    return id
  }

  function caller(): MapFactCaller {
    return { kind: 'console', actorId }
  }

  function observation(targetId: string, overrides: Record<string, unknown> = {}): MapObservation {
    const id = (overrides.id as string | undefined) ?? newId()
    const key = (overrides.dedupeKey as string | undefined) ?? `obs:${id}:before:0`
    return mapObservationSchema.parse({
      id,
      schemaVersion: 1,
      targetId,
      dedupeKey: key,
      observedAt: '2026-09-16T00:00:00.000Z',
      collectorVersion: 'map-collector@1',
      sourceType: 'user_confirmed',
      sourceRef: { sourceType: 'user_confirmed', actorId, decisionId: newId(), scope: 'orders.search' },
      phase: 'before_action',
      localSequence: 0,
      sourceEventKey: key,
      conditionSnapshot: {
        targetId,
        accountBinding: { presence: 'anonymous' },
        unknownFields: ['permissionProfile', 'workspace', 'locale', 'viewport', 'featureVersion'],
      },
      topUrlPattern: 'https://shop.example/orders',
      framePath: [],
      originChain: ['https://shop.example'],
      surfaceCapability: { frames: 'ok', a11y: 'ok', canvas: 'unknown', shadow: 'ok' },
      regionRefs: [{ key: 'action', kind: 'action_object' }],
      nodeSetKind: 'action_object',
      completeness: 'complete',
      truncated: false,
      missingReasons: [],
      semanticSummary: { predicates: [{ name: 'label', value: '保存' }] },
      stateSummary: { regions: {} },
      structuralSummary: { nodeCount: 4, truncated: false },
      evidenceRefs: [],
      captureStatus: 'observed',
      ...overrides,
    })
  }

  async function seedObservation(targetId: string) {
    const obs = observation(targetId)
    await appendMapObservation(handle.db, { observation: obs, caller: caller() })
    return obs
  }

  it('OMC08 同 cursor 并发只有一个 CAS 成功', async () => {
    const targetId = await freshTarget()
    const projection = await ensureMapProjection(handle.db, targetId)
    const obs = await seedObservation(targetId)
    const plan = emptyPlan(1, {
      pages: [
        {
          kind: 'top',
          allocationKey: 'page:v1:top:orders:top',
          routeTemplate: 'https://shop.example/orders',
          frameKey: 'top',
          reasons: ['allocation-key'],
          matchResult: 'MATCH',
        },
      ],
      assignments: [
        {
          observationId: obs.id,
          pageAllocationKey: 'page:v1:top:orders:top',
          matchResult: 'MATCH',
          reasons: ['allocation-key'],
        },
      ],
    })
    const first = commitMapProjectionBatch(handle.db, {
      projectionId: projection.id,
      expectedCursor: projection.cursor,
      expectedRevision: projection.revision,
      plan,
    })
    const second = commitMapProjectionBatch(handle.db, {
      projectionId: projection.id,
      expectedCursor: projection.cursor,
      expectedRevision: projection.revision,
      plan: emptyPlan(1),
    })
    const results = await Promise.allSettled([first, second])
    const fulfilled = results.filter((item) => item.status === 'fulfilled')
    const rejected = results.filter((item) => item.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DomainError)
    expect(((rejected[0] as PromiseRejectedResult).reason as DomainError).code).toBe('MAP_PROJECTION_STALE')
    const state = await loadMapProjectionState(handle.db, projection.id)
    expect(state.cursor).toBe(1)
    expect(state.revision).toBe(projection.revision + 1)
  })

  it('OMC09 推进 cursor 前失败则整批回滚', async () => {
    const targetId = await freshTarget()
    const projection = await ensureMapProjection(handle.db, targetId)
    const before = await loadMapProjectionState(handle.db, projection.id)
    mapProjectionTestHooks.beforeAdvanceCursor = () => {
      throw new Error('inject-before-cursor')
    }
    await expect(
      commitMapProjectionBatch(handle.db, {
        projectionId: projection.id,
        expectedCursor: before.cursor,
        expectedRevision: before.revision,
        plan: emptyPlan(before.cursor + 1, {
          pages: [
            {
              kind: 'top',
              allocationKey: `page:v1:top:rollback-${before.revision}:top`,
              routeTemplate: 'https://shop.example/rollback',
              frameKey: 'top',
              reasons: ['discover-page'],
              matchResult: 'MATCH',
            },
          ],
        }),
      }),
    ).rejects.toThrow('inject-before-cursor')
    const after = await loadMapProjectionState(handle.db, projection.id)
    expect(after.cursor).toBe(before.cursor)
    expect(after.revision).toBe(before.revision)
    expect(after.pages.some((page) => page.allocationKey.includes('rollback'))).toBe(false)
  })

  it('OMC10 拆分后旧 release digest 不变', async () => {
    const targetId = await freshTarget()
    const projection = await ensureMapProjection(handle.db, targetId)
    const state = await loadMapProjectionState(handle.db, projection.id)
    if (state.cursor === 0) {
      await commitMapProjectionBatch(handle.db, {
        projectionId: projection.id,
        expectedCursor: 0,
        expectedRevision: state.revision,
        plan: emptyPlan(1, {
          pages: [
            {
              kind: 'top',
              allocationKey: 'page:v1:top:seal-base:top',
              routeTemplate: 'https://shop.example/seal',
              frameKey: 'top',
              reasons: ['discover-page'],
              matchResult: 'MATCH',
            },
          ],
        }),
      })
    }
    const ready = await loadMapProjectionState(handle.db, projection.id)
    const sealed = await sealMapRelease(handle.db, {
      targetId,
      projectionId: projection.id,
      expectedProjectionRevision: ready.revision,
      policyVersion: 'map-assets@1',
      commandKey: `seal:omc10:${projection.id}`.slice(0, 192),
      actorId,
    })
    const objectId = newId()
    const splitTo = newId()
    await applyMapIdentityCommand(handle.db, {
      targetId,
      expectedIdentityRevision: ready.identityRevision,
      commandKey: `split:omc10:${projection.id}`.slice(0, 192),
      action: 'split',
      oldRefs: [{ targetId, objectId }],
      newRefs: [
        { targetId, objectId },
        { targetId, objectId: splitTo },
      ],
      reason: '误合并后拆分',
      evidenceRefs: [],
      actorId,
    })
    const again = await getMapRelease(handle.db, { releaseId: sealed.releaseId, targetId })
    expect(again.manifestDigest).toBe(sealed.manifestDigest)
    const view = await loadMapQueryView(handle.db, {
      targetId,
      view: { kind: 'release', releaseId: sealed.releaseId, manifestDigest: sealed.manifestDigest },
      limit: 10,
    })
    expect(view.viewRef.kind).toBe('release')
    expect(view.viewRef.kind === 'release' && view.viewRef.manifestDigest).toBe(sealed.manifestDigest)
  })

  it('OMC11 shadow 重建水位固定，新观察不进入该代', async () => {
    const targetId = await freshTarget()
    await seedObservation(targetId)
    await ensureMapProjection(handle.db, targetId)
    const shadow = await startMapProjectionRebuild(handle.db, { targetId })
    const watermark = shadow.sourceWatermark ?? 0
    await seedObservation(targetId)
    expect(shadow.status).toBe('shadow')
    const state = await loadMapProjectionState(handle.db, shadow.id)
    expect(state.sourceWatermark).toBe(watermark)
    expect(state.cursor).toBe(0)
    const current = await ensureMapProjection(handle.db, targetId)
    expect(current.id).not.toBe(shadow.id)
  })

  it('OMC12 封存中断无半 release，同键幂等，跨 Target 拒绝', async () => {
    const targetId = await freshTarget()
    const projection = await ensureMapProjection(handle.db, targetId)
    const state = await loadMapProjectionState(handle.db, projection.id)
    if (state.revision === 0 && state.cursor === 0) {
      await commitMapProjectionBatch(handle.db, {
        projectionId: projection.id,
        expectedCursor: 0,
        expectedRevision: 0,
        plan: emptyPlan(1),
      })
    }
    const ready = await loadMapProjectionState(handle.db, projection.id)
    mapProjectionTestHooks.beforeInsertReleaseItems = () => {
      throw new Error('inject-seal-items')
    }
    const commandKey = `seal:omc12:${newId()}`.slice(0, 192)
    await expect(
      sealMapRelease(handle.db, {
        targetId,
        projectionId: projection.id,
        expectedProjectionRevision: ready.revision,
        policyVersion: 'map-assets@1',
        commandKey,
        actorId,
      }),
    ).rejects.toThrow('inject-seal-items')
    const { mapReleases } = schemaFor(handle.db)
    const leftover = await handle.db.select().from(mapReleases)
    expect(leftover.filter((row) => row.commandKey === commandKey)).toHaveLength(0)

    mapProjectionTestHooks.beforeInsertReleaseItems = null
    const first = await sealMapRelease(handle.db, {
      targetId,
      projectionId: projection.id,
      expectedProjectionRevision: ready.revision,
      policyVersion: 'map-assets@1',
      commandKey: `seal:omc12:ok:${projection.id}`.slice(0, 192),
      actorId,
    })
    const second = await sealMapRelease(handle.db, {
      targetId,
      projectionId: projection.id,
      expectedProjectionRevision: ready.revision,
      policyVersion: 'map-assets@1',
      commandKey: `seal:omc12:ok:${projection.id}`.slice(0, 192),
      actorId,
    })
    expect(second.releaseId).toBe(first.releaseId)
    await expect(
      getMapRelease(handle.db, { releaseId: first.releaseId, targetId: otherTargetId }),
    ).rejects.toMatchObject({ code: 'MAP_TARGET_MISMATCH' })
  })

  it('OMC14 正文清理后重建标记 partial', async () => {
    const targetId = await freshTarget()
    const obs = await seedObservation(targetId)
    await expireMapFactContents(handle.db, { targetId, olderThan: new Date() })
    const shadow = await startMapProjectionRebuild(handle.db, { targetId })
    const result = await commitMapProjectionBatch(handle.db, {
      projectionId: shadow.id,
      expectedCursor: 0,
      expectedRevision: 0,
      plan: emptyPlan(1, { rebuildCompleteness: 'partial' }),
    })
    expect(result.status === 'ready' || result.cursor === 1).toBe(true)
    const state = await loadMapProjectionState(handle.db, shadow.id)
    expect(state.rebuildCompleteness).toBe('partial')
    expect(obs.id).toBeTruthy()
  })
})
