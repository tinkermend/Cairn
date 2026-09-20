import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JwtService } from '@nestjs/jwt'
import { knownMetric, type MonitoringOverviewResponse } from '@cairn/shared'
import { AuthService } from '../auth/auth.service'
import { HealthService } from '../health/health.service'
import { MonitoringService } from './monitoring.service'

const AS_OF = '2026-09-18T03:00:00.000Z'

function snapshot(asOf = AS_OF): MonitoringOverviewResponse {
  return {
    asOf,
    partitions: {
      service: {
        availability: 'unavailable',
        reasonCode: 'AGGREGATE_FAILED',
        message: '聚合失败',
      },
      capacity: {
        availability: 'unavailable',
        reasonCode: 'DATA_PLANE_UNAVAILABLE',
        message: '数据面不可用',
      },
      queues: {
        availability: 'unavailable',
        reasonCode: 'AGGREGATE_FAILED',
        message: '聚合失败',
      },
      anomalies: {
        availability: 'available',
        source: 'aggregate',
        sampledAt: asOf,
        data: {
          leases: {
            expiredActiveRunLeases: knownMetric(0),
            expiredActiveSessionLeases: knownMetric(0),
            leftoverAuthHolds: knownMetric(0),
            orphanAttempts: knownMetric(0),
            recoveryCappedRuns: knownMetric(0),
          },
          evidence: {
            pendingUpload: knownMetric(0),
            uploadFailed: knownMetric(0),
            maxUploadAttempts: knownMetric(0),
            purgeBacklog: knownMetric(0),
            purgeFailed: knownMetric(0),
            missingReasons: [],
          },
          clockSkew: { maxAbsSkewMs: knownMetric(0) },
        },
      },
      ai: {
        availability: 'unavailable',
        reasonCode: 'AGGREGATE_FAILED',
        message: 'AI 账本尚未采集',
      },
    },
  }
}

class FakeResponse extends EventEmitter {
  writableEnded = false
  statusCode = 0
  headers: Record<string, string> = {}
  writes: string[] = []
  status(code: number) {
    this.statusCode = code
    return this
  }
  setHeader(name: string, value: string) {
    this.headers[name] = value
  }
  flushHeaders() {}
  write(chunk: string) {
    this.writes.push(chunk)
    return true
  }
  end() {
    this.writableEnded = true
  }
}

describe('监控 SSE 节拍', () => {
  let service: MonitoringService
  let resolveAccount: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    resolveAccount = vi.fn(async () => ({
      id: 'acc-mon',
      status: 'active',
      permissions: ['monitor:read'],
    }))
    service = new MonitoringService(
      { driver: 'postgres', ping: async () => true, close: async () => undefined } as never,
      {} as HealthService,
      { decode: () => ({ exp: Date.now() / 1000 + 3600 }) } as unknown as JwtService,
      { resolveAccount } as unknown as AuthService,
      { identity: () => ({ id: 'api-test', idSource: 'configured' }) } as never,
      { encrypt: () => Buffer.from('cipher') } as never,
      { probe: async () => ({ ok: true, latencyMs: 1, errorClass: null }) } as never,
    )
    vi.spyOn(service, 'overview').mockResolvedValue(snapshot())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('首帧立即推送，客户端间隔被抬到服务端下限，同 asOf 不重复计数', async () => {
    const response = new FakeResponse()
    const controller = new AbortController()
    const running = service.stream({
      intervalMs: 1_000,
      lastEventId: undefined,
      authorization: 'Bearer test',
      account: { id: 'acc-mon' },
      response: response as never,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(response.writes.join('')).toContain('event: snapshot'))
    const first = response.writes.join('')
    expect(first).toContain('"intervalMs":5000')
    expect(first).toContain('"minIntervalMs":5000')
    expect(first).toContain('id: 2026-09-18T03:00:00.000Z')
    expect(response.headers['Content-Type']).toBe('text/event-stream')
    expect(response.headers['Cache-Control']).toBe('no-cache, no-transform')
    const snapshots = first.match(/event: snapshot/g) ?? []
    expect(snapshots).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect((response.writes.join('').match(/event: snapshot/g) ?? []).length).toBe(1)
    vi.mocked(service.overview).mockResolvedValueOnce(snapshot('2026-09-18T03:00:05.000Z'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(response.writes.join('')).toContain('id: 2026-09-18T03:00:05.000Z')
    controller.abort()
    await running
  })

  it('Last-Event-ID 命中当前 asOf 时跳过首张快照', async () => {
    const response = new FakeResponse()
    const controller = new AbortController()
    const running = service.stream({
      lastEventId: AS_OF,
      account: { id: 'acc-mon' },
      response: response as never,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(response.writes.join('')).toContain('event: ready'))
    expect(response.writes.join('')).not.toContain('event: snapshot')
    vi.mocked(service.overview).mockResolvedValueOnce(snapshot('2026-09-18T03:00:05.000Z'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(response.writes.join('')).toContain('event: snapshot')
    controller.abort()
    await running
  })

  it('鉴权复核库故障保持连接，不发 INTERNAL、不关流', async () => {
    resolveAccount.mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    const response = new FakeResponse()
    const controller = new AbortController()
    const running = service.stream({
      authorization: 'Bearer test',
      account: { id: 'acc-mon' },
      response: response as never,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(response.writes.join('')).toContain('event: snapshot'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(response.writableEnded).toBe(false)
    expect(response.writes.join('')).not.toContain('"code":"INTERNAL"')
    expect(response.writes.join('')).not.toContain('"code":"UNAUTHORIZED"')
    controller.abort()
    await running
  })

  it('鉴权复核撤权后结束连接', async () => {
    const response = new FakeResponse()
    const controller = new AbortController()
    const running = service.stream({
      authorization: 'Bearer test',
      account: { id: 'acc-mon' },
      response: response as never,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(response.writes.join('')).toContain('event: snapshot'))
    resolveAccount.mockResolvedValueOnce({ id: 'acc-mon', status: 'active', permissions: [] })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(response.writableEnded).toBe(true)
    expect(response.writes.join('')).toContain('"code":"FORBIDDEN"')
    expect(response.writes.join('')).toContain('没有运行监控读取权限')
    controller.abort()
    await running
  })
})
