import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '../id.js'
import { schemaFor } from '../native.js'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  listMapAtlasPages,
  type NativeHandle as DbHandle,
} from '../test-entry.js'

describe.each(DRIVERS)('%s 地图群岛汇聚与海岛测绘', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let targetId: string
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `map_atlas_${Date.now().toString(36)}`)
    const { consoleAccounts, targets } = schemaFor(handle.db)
    actorId = newId()
    targetId = newId()

    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'map-atlas-user',
      email: `map-atlas-${actorId}@example.com`,
    })

    await handle.db.insert(targets).values({
      id: targetId,
      code: targetId,
      name: 'Atlas Test Target',
      entryUrl: 'https://app.example.com',
      targetKey: `tgt_${targetId.slice(0, 8)}`,
      createdByConsoleAccountId: actorId,
    })
  })

  afterAll(async () => {
    await handle.close()
  })

  it('无投影时返回空海岛列表', async () => {
    const res = await listMapAtlasPages(handle.db, targetId, { limit: 10 })
    expect(res.items).toEqual([])
    expect(res.totalObservedPages).toBe(0)
    expect(res.matchedIslands).toBe(0)
    expect(res.presentationRevision).toBe(0)
  })

  it('有投影时按 Page 聚合对象数、需复核数并清洗路由', async () => {
    const { mapProjections, mapProjectionHeads, mapPages, mapProjectionAssets } = schemaFor(handle.db)
    const projectionId = newId()
    const pageId1 = newId()
    const pageId2 = newId()

    // 1. Insert projection & head
    await handle.db.insert(mapProjections).values({
      id: projectionId,
      targetId,
      cursor: 10,
      generation: 1,
      revision: 1,
      status: 'active',
      algorithmVersion: '1.0',
      policyVersion: '1.0',
      identityRevision: 1,
    })
    await handle.db.insert(mapProjectionHeads).values({
      targetId,
      currentProjectionId: projectionId,
    })

    // 2. Insert pages
    await handle.db.insert(mapPages).values([
      {
        id: pageId1,
        targetId,
        allocationKey: `alloc_${pageId1}`,
        kind: 'top',
        routeTemplate: 'https://app.example.com/workspaces/a1b2c3d4-e5f6-7890-abcd-ef1234567890/projects',
      },
      {
        id: pageId2,
        targetId,
        allocationKey: `alloc_${pageId2}`,
        kind: 'top',
        routeTemplate: 'https://app.example.com/settings',
      },
    ])

    // 3. Insert projection assets
    // Page 1 has 3 objects: 2 healthy, 1 DEPRECATED
    const obj1 = newId()
    const obj2 = newId()
    const obj3 = newId()
    // Page 2 has 1 object: healthy
    const obj4 = newId()

    await handle.db.insert(mapProjectionAssets).values([
      {
        projectionId,
        targetId,
        assetRefKey: `p:${pageId1}:o:${obj1}:i:k:d:1`,
        pageId: pageId1,
        objectId: obj1,
        lifecycle: 'OBSERVED',
        executable: 1,
        rejectReasons: [],
        dimensions: [],
      },
      {
        projectionId,
        targetId,
        assetRefKey: `p:${pageId1}:o:${obj2}:i:k:d:1`,
        pageId: pageId1,
        objectId: obj2,
        lifecycle: 'DEGRADED',
        executable: 0,
        rejectReasons: [],
        dimensions: [],
      },
      {
        projectionId,
        targetId,
        assetRefKey: `p:${pageId1}:o:${obj3}:i:k:d:1`,
        pageId: pageId1,
        objectId: obj3,
        lifecycle: 'OBSERVED',
        executable: 1,
        rejectReasons: [],
        dimensions: [],
      },
      {
        projectionId,
        targetId,
        assetRefKey: `p:${pageId2}:o:${obj4}:i:k:d:1`,
        pageId: pageId2,
        objectId: obj4,
        lifecycle: 'OBSERVED',
        executable: 1,
        rejectReasons: [],
        dimensions: [],
      },
    ])

    const res = await listMapAtlasPages(handle.db, targetId, { limit: 10 })

    expect(res.totalObservedPages).toBe(2)
    expect(res.matchedIslands).toBe(2)
    expect(res.items).toHaveLength(2)

    // Sorted by uniqueObjectCount DESC, so pageId1 is first
    const [first, second] = res.items
    expect(first.pageId).toBe(pageId1)
    expect(first.uniqueObjectCount).toBe(3)
    expect(first.uniqueNeedsAttentionCount).toBe(1)
    expect(first.routeSummary).toBe('/workspaces/:id/projects')
    expect(first.displayName).toBe('/workspaces/:id/projects')
    expect(first.nameSource).toBe('sanitized_route')

    expect(second.pageId).toBe(pageId2)
    expect(second.uniqueObjectCount).toBe(1)
    expect(second.uniqueNeedsAttentionCount).toBe(0)
    expect(second.routeSummary).toBe('/settings')

    // Search filter test
    const searchRes = await listMapAtlasPages(handle.db, targetId, { search: 'settings' })
    expect(searchRes.totalObservedPages).toBe(2)
    expect(searchRes.matchedIslands).toBe(1)
    expect(searchRes.items[0].pageId).toBe(pageId2)
  })
})
