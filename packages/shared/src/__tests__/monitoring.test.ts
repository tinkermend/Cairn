import { describe, expect, it } from 'vitest'
import {
  MONITOR_METRIC_CATALOG,
  MONITOR_METRIC_KEYS,
  MONITOR_REALTIME_UNAVAILABLE,
  MONITOR_SAMPLE_KEYS,
  MONITOR_SAMPLE_KEY_SCOPES,
  MONITOR_UPLOAD_FAILED_REASONS,
  alignMonitorSampleBucket,
  clampMonitorSseInterval,
  deriveApiInstanceId,
  downsampleMonitorSeries,
  knownMetric,
  monitorMetricNumberSchema,
  monitorProfileListQuerySchema,
  monitorSeriesQuerySchema,
  monitorStreamControlSchema,
  monitorStreamQuerySchema,
  monitoringOverviewResponseSchema,
  resolveBuildVersion,
  unknownMetric,
} from '../monitoring.js'

describe('监控契约', () => {
  it('指标键封闭且每项都有层、单位与 unknown 条件', () => {
    expect(new Set(MONITOR_METRIC_KEYS).size).toBe(MONITOR_METRIC_KEYS.length)
    for (const key of MONITOR_METRIC_KEYS) {
      const def = MONITOR_METRIC_CATALOG[key]
      expect(def.layer).toMatch(/^L[1-4]$/)
      expect(def.unit).toBeTruthy()
      expect(def.unknownWhen.length).toBeGreaterThan(0)
    }
    expect(new Set(MONITOR_SAMPLE_KEYS).size).toBe(MONITOR_SAMPLE_KEYS.length)
    for (const key of MONITOR_SAMPLE_KEYS) {
      expect(MONITOR_METRIC_KEYS).toContain(key)
      expect(MONITOR_SAMPLE_KEY_SCOPES[key]).toMatch(/^(platform|api|worker)$/)
    }
  })

  it('未知不等于零', () => {
    expect(knownMetric(0)).toEqual({ availability: 'known', value: 0 })
    expect(unknownMetric('not_collected')).toEqual({
      availability: 'unknown',
      reason: 'not_collected',
    })
    expect(unknownMetric('not_collected')).not.toEqual(knownMetric(0))
    expect(() => monitorMetricNumberSchema.parse({ availability: 'known', value: Number.NaN })).toThrow()
    expect(() => monitorMetricNumberSchema.parse({ availability: 'known', value: Number.POSITIVE_INFINITY })).toThrow()
    expect([...MONITOR_UPLOAD_FAILED_REASONS]).toEqual(['object_store_unavailable', 'upload_incomplete'])
  })

  it('profiles 的 limit 默认 20、上限 100，非法参数拒绝', () => {
    expect(monitorProfileListQuerySchema.parse({}).limit).toBe(20)
    expect(monitorProfileListQuerySchema.parse({ limit: '100' }).limit).toBe(100)
    expect(() => monitorProfileListQuerySchema.parse({ limit: 0 })).toThrow()
    expect(() => monitorProfileListQuerySchema.parse({ limit: 101 })).toThrow()
    expect(() => monitorProfileListQuerySchema.parse({ cursor: '' })).toThrow()
  })

  it('overview 分区降级与可用可以共存，且不含完整列表', () => {
    const asOf = '2026-09-18T00:00:00.000Z'
    const parsed = monitoringOverviewResponseSchema.parse({
      asOf,
      partitions: {
        service: {
          availability: 'available',
          source: 'self',
          sampledAt: asOf,
          data: {
            api: {
              status: 'degraded',
              service: 'cairn-api',
              uptimeSeconds: knownMetric(12),
            },
            database: {
              driver: 'postgres',
              ping: 'up',
              pingLatencyMs: knownMetric(3),
              expectedLogicalVersion: '0059',
              appliedPrefix: '0059',
              expectedPrefix: '0059',
              schemaConsistency: 'consistent',
              pool: {
                totalCount: unknownMetric('unsupported'),
                idleCount: unknownMetric('unsupported'),
                waitingCount: unknownMetric('unsupported'),
              },
            },
            changeHint: {
              status: 'unused',
              realtime: false,
              realtimeProgressAvailable: false,
              consequence: MONITOR_REALTIME_UNAVAILABLE,
            },
          },
        },
        capacity: {
          availability: 'unavailable',
          reasonCode: 'DATA_PLANE_UNAVAILABLE',
          message: '数据面不可用',
        },
        queues: {
          availability: 'unavailable',
          reasonCode: 'AGGREGATE_FAILED',
          message: '队列聚合失败',
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
          },
        },
      },
    })
    expect(parsed.partitions.capacity.availability).toBe('unavailable')
    expect(parsed.partitions.service.availability).toBe('available')
    if (parsed.partitions.service.availability === 'available') {
      expect(parsed.partitions.service.data.changeHint.consequence).toBe(MONITOR_REALTIME_UNAVAILABLE)
    }
    expect(JSON.stringify(parsed)).not.toMatch(/items":\[\{"id"/)
    expect(parsed.partitions.service.availability === 'available' && parsed.partitions.service.data.objectStore.status).toEqual(
      unknownMetric('not_collected'),
    )
    expect(parsed.partitions.ai.availability).toBe('unavailable')
  })

  it('构建版本与派生 API ID、采样桶与降采样遵守契约', () => {
    expect(resolveBuildVersion(undefined)).toBeNull()
    expect(resolveBuildVersion('')).toBeNull()
    expect(resolveBuildVersion('0.0.0')).toBeNull()
    expect(resolveBuildVersion('2026.09.18')).toBe('2026.09.18')
    expect(deriveApiInstanceId('dev-host', 3030)).toBe('dev-host:3030')
    expect(alignMonitorSampleBucket(new Date('2026-09-18T00:00:37.000Z'), 60_000).toISOString()).toBe(
      '2026-09-18T00:00:00.000Z',
    )
    const points = Array.from({ length: 400 }, (_, i) => ({
      bucketAt: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      value: i,
    }))
    const down = downsampleMonitorSeries(points, 300)
    expect(down.length).toBeLessThanOrEqual(300)
    expect(down.at(-1)?.value).toBe(399)
    expect(monitorSeriesQuerySchema.parse({ keys: 'queue.claimableRuns,worker.status.ready' }).keys).toEqual([
      'queue.claimableRuns',
      'worker.status.ready',
    ])
    expect(() => monitorSeriesQuerySchema.parse({ keys: 'api.uptimeSeconds' })).toThrow()
    expect(() => monitorSeriesQuerySchema.parse({ keys: 'queue.claimableRuns', scope: 'worker' })).toThrow()
    expect(() =>
      monitorSeriesQuerySchema.parse({
        keys: 'queue.claimableRuns',
        from: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      }),
    ).toThrow()
  })

  it('推送间隔客户端不能压到下限以下', () => {
    expect(clampMonitorSseInterval(1_000, 5_000, 5_000)).toBe(5_000)
    expect(clampMonitorSseInterval(undefined, 5_000, 5_000)).toBe(5_000)
    expect(clampMonitorSseInterval(8_000, 5_000, 5_000)).toBe(8_000)
    expect(clampMonitorSseInterval(2_000, 2_000, 5_000)).toBe(2_000)
    expect(monitorStreamQuerySchema.parse({ intervalMs: '1000' }).intervalMs).toBe(1_000)
    expect(() => monitorStreamQuerySchema.parse({ intervalMs: 0 })).toThrow()
    expect(() => monitorStreamQuerySchema.parse({ intervalMs: 60_001 })).toThrow()
    const ready = monitorStreamControlSchema.parse({ kind: 'ready', intervalMs: 5_000, minIntervalMs: 5_000 })
    expect(ready).toEqual({ kind: 'ready', intervalMs: 5_000, minIntervalMs: 5_000 })
  })
})
