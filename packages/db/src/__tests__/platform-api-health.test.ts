import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { openContractDb } from './contract-fixture.js'
import { newId } from '../id.js'
import { clockNow, schemaFor } from '../native.js'
import {
  heartbeatApiInstance,
  listApiInstanceCard,
  markApiInstanceStopped,
  markLostApiInstances,
  readPlatformApiHealthSummary,
} from '../monitoring/index.js'

describe('平台 API 健康摘要', () => {
  let handle: Awaited<ReturnType<typeof openContractDb>>

  beforeAll(async () => {
    handle = await openContractDb('postgres', 'platform-api-health')
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('只在心跳租期内把失联实例计为当前降级，并保留监控历史', async () => {
    const healthyId = `health-ready-${newId()}`
    const lostId = `health-lost-${newId()}`
    const stoppedId = `health-stopped-${newId()}`
    const healthyInstanceId = newId()
    const lostInstanceId = newId()
    const stoppedInstanceId = newId()

    await heartbeatApiInstance(handle.db, {
      id: healthyId,
      instanceId: healthyInstanceId,
      idSource: 'configured',
      lostAfterSeconds: 3_600,
      version: null,
      schemaLogicalVersion: null,
    })
    await heartbeatApiInstance(handle.db, {
      id: lostId,
      instanceId: lostInstanceId,
      idSource: 'configured',
      lostAfterSeconds: 45,
      version: null,
      schemaLogicalVersion: null,
    })
    await heartbeatApiInstance(handle.db, {
      id: stoppedId,
      instanceId: stoppedInstanceId,
      idSource: 'configured',
      lostAfterSeconds: 45,
      version: null,
      schemaLogicalVersion: null,
    })
    expect(await markApiInstanceStopped(handle.db, stoppedId, stoppedInstanceId)).toBe(true)

    const asOf = await clockNow(handle.db)
    const before = await readPlatformApiHealthSummary(handle.db, asOf)
    expect(before.recentlyLostInstances).toBe(0)
    expect(before.earliestApiValidUntil?.getTime()).toBeGreaterThan(asOf.getTime())

    const expiredAt = new Date(asOf.getTime() - 1_000)
    const { apiInstances } = schemaFor(handle.db)
    await handle.db.update(apiInstances)
      .set({ heartbeatExpiresAt: expiredAt })
      .where(eq(apiInstances.id, lostId))

    const during = await readPlatformApiHealthSummary(handle.db, asOf)
    expect(during.recentlyLostInstances).toBe(1)
    expect(during.earliestApiValidUntil?.getTime()).toBe(expiredAt.getTime() + 45_000)

    expect(await markLostApiInstances(handle.db)).toContain(lostId)
    expect((await readPlatformApiHealthSummary(handle.db, asOf)).recentlyLostInstances).toBe(1)

    const afterWindow = new Date(expiredAt.getTime() + 45_001)
    expect((await readPlatformApiHealthSummary(handle.db, afterWindow)).recentlyLostInstances).toBe(0)
    const historyCard = await listApiInstanceCard(handle.db, afterWindow)
    expect(historyCard.lost).toMatchObject({ availability: 'known' })
    if (historyCard.lost.availability !== 'known') throw new Error('expected known metric')
    expect(historyCard.lost.value).toBe(1)

    await heartbeatApiInstance(handle.db, {
      id: lostId,
      instanceId: newId(),
      idSource: 'configured',
      lostAfterSeconds: 45,
      version: null,
      schemaLogicalVersion: null,
    })
    expect((await readPlatformApiHealthSummary(handle.db, await clockNow(handle.db))).recentlyLostInstances).toBe(0)
  })
})
