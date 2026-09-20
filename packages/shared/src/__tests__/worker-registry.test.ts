import { describe, expect, it } from 'vitest'
import {
  canSeeWorkerInternalEndpoint,
  evaluateWorkerRegistration,
  evaluateWorkerRoute,
  handleMismatchState,
  heartbeatFresh,
  nextHandleMismatchStreak,
  normalizeWorkerEndpoint,
  parseWorkerEndpoints,
  projectWorkerInternalEndpoint,
  resolveWorkerAdvertiseUrl,
  workerListResponseSchema,
  WORKER_RESULT_UNKNOWN_MESSAGE,
  WORKER_STATUSES,
} from '../index.js'

const instance = '11111111-1111-4111-8111-111111111111'
const asOf = new Date('2026-09-14T00:00:00.000Z')
const freshExpiry = '2026-09-14T00:01:00.000Z'
const expiredAt = '2026-09-14T00:00:00.000Z'

function registration(overrides: Partial<Parameters<typeof evaluateWorkerRegistration>[0]> = {}) {
  return evaluateWorkerRegistration({
    workerStatus: 'READY',
    heartbeatExpiresAt: freshExpiry,
    lostAfterSeconds: 60,
    internalBaseUrl: null,
    asOf,
    networkMode: 'local',
    envEndpoint: 'http://127.0.0.1:8091',
    ...overrides,
  })
}

function route(overrides: Partial<Parameters<typeof evaluateWorkerRoute>[0]> = {}) {
  return evaluateWorkerRoute({
    workerStatus: 'READY',
    workerInstanceId: instance,
    sessionOwnerInstanceId: instance,
    lostAfterSeconds: 60,
    heartbeatExpiresAt: freshExpiry,
    internalBaseUrl: null,
    asOf,
    networkMode: 'local',
    envEndpoint: 'http://127.0.0.1:8091',
    ...overrides,
  })
}

describe('Worker 地址校验', () => {
  it('拒绝 userinfo、path、query、fragment、unix、通配、调试端口与非 loopback HTTP', () => {
    const local = { networkMode: 'local' as const }
    expect(() => normalizeWorkerEndpoint('http://user:pass@127.0.0.1:8091', local)).toThrow(/userinfo/)
    expect(() => normalizeWorkerEndpoint('http://127.0.0.1:8091/internal', local)).toThrow(/origin/)
    expect(() => normalizeWorkerEndpoint('http://127.0.0.1:8091?x=1', local)).toThrow(/query/)
    expect(() => normalizeWorkerEndpoint('http://127.0.0.1:8091#frag', local)).toThrow(/fragment/)
    expect(() => normalizeWorkerEndpoint('http://unix/', local)).toThrow(/unix/)
    expect(() => normalizeWorkerEndpoint('http://0.0.0.0:8091', local)).toThrow(/通配/)
    expect(() => normalizeWorkerEndpoint('http://127.0.0.1:9222', local)).toThrow(/9222/)
    expect(() => normalizeWorkerEndpoint('http://worker.example:8091', local)).toThrow(/https/)
    expect(normalizeWorkerEndpoint('http://127.0.0.1:8091/', local).origin).toBe('http://127.0.0.1:8091')
    expect(normalizeWorkerEndpoint('http://[::1]:8091', local).host).toBe('[::1]')
  })

  it('distributed 只接受非 loopback HTTPS；无广告 URL 不自动拼 loopback', () => {
    expect(() =>
      normalizeWorkerEndpoint('https://127.0.0.1:8443', { networkMode: 'distributed' }),
    ).toThrow(/loopback/)
    expect(() =>
      normalizeWorkerEndpoint('http://worker-a.internal:8443', { networkMode: 'distributed' }),
    ).toThrow(/https/)
    expect(
      normalizeWorkerEndpoint('https://worker-a.internal:8443', { networkMode: 'distributed' }).origin,
    ).toBe('https://worker-a.internal:8443')
    expect(
      resolveWorkerAdvertiseUrl({ networkMode: 'local', internalPort: 8091 }),
    ).toBeNull()
    expect(
      resolveWorkerAdvertiseUrl({ networkMode: 'local', internalPort: 0 }),
    ).toBeNull()
    expect(() =>
      resolveWorkerAdvertiseUrl({
        networkMode: 'local',
        internalPort: 0,
        advertiseUrl: 'http://127.0.0.1:8091',
      }),
    ).toThrow(/广告 URL/)
    expect(() =>
      resolveWorkerAdvertiseUrl({ networkMode: 'distributed', internalPort: 8091 }),
    ).toThrow(/HTTPS/)
  })

  it('distributed 未配置映射时得到空表，不注入本机默认值', () => {
    expect(parseWorkerEndpoints(undefined, { networkMode: 'distributed' })).toEqual({})
    expect(parseWorkerEndpoints(undefined, { networkMode: 'local' })['local-worker']).toBe(
      'http://127.0.0.1:8091',
    )
  })
})

describe('Worker 路由回退', () => {
  it('仅有效登记且库内入口为空时才用环境变量映射', () => {
    expect(registration({ internalBaseUrl: 'http://127.0.0.1:8092' })).toMatchObject({
      availability: 'eligible',
      endpointSource: 'database',
      endpoint: 'http://127.0.0.1:8092',
    })
    expect(registration()).toMatchObject({
      availability: 'eligible',
      endpointSource: 'environment',
      endpoint: 'http://127.0.0.1:8091',
    })
  })

  it('READY 但过期、未知归属、非 READY、库内 URL 无效时不得换用映射', () => {
    expect(registration({ heartbeatExpiresAt: expiredAt })).toMatchObject({
      availability: 'unavailable',
      reason: 'heartbeat_expired',
      endpointSource: 'none',
      endpoint: null,
    })
    expect(registration({ lostAfterSeconds: null, heartbeatExpiresAt: null })).toMatchObject({
      reason: 'registration_incomplete',
      endpoint: null,
    })
    expect(registration({ workerStatus: 'DRAINING' })).toMatchObject({
      reason: 'worker_not_ready',
      endpoint: null,
    })
    expect(registration({ internalBaseUrl: 'http://worker.example:8091' })).toMatchObject({
      reason: 'endpoint_invalid',
      endpoint: null,
    })
    expect(route({ sessionOwnerInstanceId: null })).toMatchObject({
      reason: 'registration_incomplete',
      endpoint: null,
    })
    expect(route({ sessionOwnerInstanceId: '22222222-2222-4222-8222-222222222222' })).toMatchObject({
      reason: 'registration_incomplete',
      endpoint: null,
    })
    expect(heartbeatFresh({ heartbeatExpiresAt: expiredAt, asOf })).toBe(false)
    expect(heartbeatFresh({ heartbeatExpiresAt: freshExpiry, asOf })).toBe(true)
  })
})

describe('句柄采样连续差异', () => {
  it('未上报、第一次差异、连续差异与缺样本重置', () => {
    expect(nextHandleMismatchStreak({ previous: 1, liveHandleCount: null, sampledSlotCount: 1 })).toBe(0)
    expect(nextHandleMismatchStreak({ previous: 0, liveHandleCount: 1, sampledSlotCount: 0 })).toBe(1)
    expect(nextHandleMismatchStreak({ previous: 1, liveHandleCount: 2, sampledSlotCount: 0 })).toBe(2)
    expect(nextHandleMismatchStreak({ previous: 2, liveHandleCount: 2, sampledSlotCount: 0 })).toBe(2)
    expect(nextHandleMismatchStreak({ previous: 2, liveHandleCount: 1, sampledSlotCount: 1 })).toBe(0)
    expect(
      nextHandleMismatchStreak({ previous: 0, liveHandleCount: 1, sampledSlotCount: 1, browserProcessCount: 3 }),
    ).toBe(1)
    expect(
      nextHandleMismatchStreak({ previous: 0, liveHandleCount: 1, sampledSlotCount: 1, browserProcessCount: null }),
    ).toBe(0)
    expect(
      handleMismatchState({
        liveHandleCount: 1,
        sampledSlotCount: 0,
        handleMismatchStreak: 1,
        heartbeatFresh: false,
      }),
    ).toBe('unknown')
    expect(
      handleMismatchState({
        liveHandleCount: 1,
        sampledSlotCount: 0,
        handleMismatchStreak: 1,
        heartbeatFresh: true,
      }),
    ).toBe('pending')
    expect(
      handleMismatchState({
        liveHandleCount: 1,
        sampledSlotCount: 0,
        handleMismatchStreak: 2,
        heartbeatFresh: true,
      }),
    ).toBe('persistent')
  })
})

describe('四值状态与入口投影', () => {
  it('同一列表响应接受 READY/DRAINING/STOPPED/LOST', () => {
    expect(WORKER_STATUSES).toEqual(['READY', 'DRAINING', 'STOPPED', 'LOST'])
    const asOfIso = asOf.toISOString()
    const item = (status: 'READY' | 'DRAINING' | 'STOPPED' | 'LOST') => ({
      workerId: `w-${status.toLowerCase()}`,
      instanceId: instance,
      status,
      heartbeatAt: asOfIso,
      lostAfterSeconds: 60,
      heartbeatExpiresAt: freshExpiry,
      heartbeatFresh: status === 'READY',
      capacity: 1,
      maxSessions: 2,
      counts: {
        occupiedSlots: 0,
        lostOccupied: 0,
        executingSlots: 0,
        running: 0,
        holding: 0,
        waitingForAuth: 0,
        leftoverAuthHolds: 0,
        expiredLeaseResidue: 0,
        runCapacityUsed: 0,
      },
      handleSample: {
        liveHandleCount: null,
        sampledSlotCount: null,
        handleMismatchStreak: 0,
        handleSampledAt: null,
        mismatchState: 'unknown' as const,
      },
      routeAvailability: 'unavailable' as const,
      routeReason: 'worker_not_ready' as const,
      endpointSource: 'none' as const,
      internalEndpoint: null,
    })
    expect(
      workerListResponseSchema.parse({
        items: [item('READY'), item('DRAINING'), item('STOPPED'), item('LOST')],
        asOf: asOfIso,
      }).items.map((row) => row.status),
    ).toEqual(['READY', 'DRAINING', 'STOPPED', 'LOST'])
  })

  it('只有 read+dispose 才投影 host/port/protocol', () => {
    expect(canSeeWorkerInternalEndpoint(['session:read'])).toBe(false)
    expect(canSeeWorkerInternalEndpoint(['session:read', 'session:dispose'])).toBe(true)
    expect(projectWorkerInternalEndpoint({ canSeeEndpoint: false, origin: 'http://127.0.0.1:8091' })).toBeNull()
    expect(projectWorkerInternalEndpoint({ canSeeEndpoint: true, origin: 'http://127.0.0.1:8091' })).toEqual({
      baseUrl: 'http://127.0.0.1:8091',
      host: '127.0.0.1',
      port: 8091,
      protocol: 'http',
    })
    expect(WORKER_RESULT_UNKNOWN_MESSAGE).toBe('结果未知，请先查看状态')
  })
})
