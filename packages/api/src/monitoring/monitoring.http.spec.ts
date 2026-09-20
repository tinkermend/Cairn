import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INestApplication,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common'
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FACTORY_ALERTING,
  FACTORY_PLATFORM_CONFIG,
  MONITOR_REALTIME_UNAVAILABLE,
  PERMISSIONS,
  knownMetric,
  monitoringOverviewResponseSchema,
  unknownMetric,
} from '@cairn/shared'
import { AllExceptionsFilter } from '../common/all-exceptions.filter'
import type { RequestAccount } from '../common/request-account'
import { AuthService } from '../auth/auth.service'
import { PermissionsGuard } from '../rbac/permissions.guard'
import { listenForSupertest, unusedChangeHint } from '../__tests__/http-app'
import { CHANGE_HINT } from '../observe/change-hint.module'
import { DB_HANDLE } from '../db/db.module'
import { HealthService } from '../health/health.service'
import { OBJECT_STORE } from '../objects/object-store.token'
import { LocalSecretProvider } from '../secrets/local-secret-provider'
import { ApiInstanceHeartbeatService } from './api-instance.service'
import { MonitoringController } from './monitoring.controller'
import { MonitoringService } from './monitoring.service'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    summarizeFleet: vi.fn(),
    summarizeQueues: vi.fn(),
    summarizeAnomalies: vi.fn(),
    summarizeAi: vi.fn(),
    listMonitorProfiles: vi.fn(),
    listMonitorAlerts: vi.fn(),
    listMonitorAlertRules: vi.fn(),
    updateAlertingRules: vi.fn(),
    upsertAlertChannel: vi.fn(),
    silenceMonitorAlert: vi.fn(),
    registerStandaloneSecret: vi.fn(),
    newId: vi.fn(() => '00000000-0000-4000-8000-000000000011'),
    listApiInstanceCard: vi.fn(),
    readObjectStoreCard: vi.fn(),
    readMonitorSeries: vi.fn(),
    recordManualObjectStoreProbe: vi.fn(),
    readSchemaVersion: vi.fn(),
    readMonitorClock: vi.fn(),
    latestLogicalVersion: vi.fn(() => '0062'),
    latestLogicalVersionForDriver: vi.fn(() => '0062'),
  }
})

const {
  summarizeFleet,
  summarizeQueues,
  summarizeAnomalies,
  summarizeAi,
  listMonitorProfiles,
  listMonitorAlerts,
  listMonitorAlertRules,
  updateAlertingRules,
  upsertAlertChannel,
  silenceMonitorAlert,
  registerStandaloneSecret,
  listApiInstanceCard,
  readObjectStoreCard,
  readMonitorSeries,
  recordManualObjectStoreProbe,
  readSchemaVersion,
  readMonitorClock,
} = await import('@cairn/db')

const AS_OF = new Date('2026-09-18T03:00:00.000Z')

const emptyCapacity = {
  workers: {
    ready: knownMetric(0),
    draining: knownMetric(0),
    stopped: knownMetric(0),
    lost: knownMetric(0),
    heartbeatFresh: knownMetric(0),
    heartbeatStale: knownMetric(0),
  },
  capacity: { total: knownMetric(0), used: knownMetric(0) },
  sessions: { total: knownMetric(0), used: knownMetric(0) },
  slots: {
    occupied: knownMetric(0),
    lostOccupied: knownMetric(0),
    executing: knownMetric(0),
    running: knownMetric(0),
    holding: knownMetric(0),
    waitingForAuth: knownMetric(0),
    leftoverAuthHolds: knownMetric(0),
    expiredLeaseResidue: knownMetric(0),
    runCapacityUsed: knownMetric(0),
  },
  workerSamples: { items: [] },
}

const emptyQueues = {
  claimableRuns: knownMetric(0),
  oldestWaitMs: knownMetric(0),
  unclaimableRuns: knownMetric(0),
  recovering: knownMetric(0),
  needsReview: knownMetric(0),
  sessionOperations: knownMetric(0),
  schedulePending: knownMetric(0),
  mapJobsActive: knownMetric(0),
  mapJobsQueued: knownMetric(0),
  mapJobsRunning: knownMetric(0),
  mapJobsActiveGuardMismatch: knownMetric(0),
  maxTargetBacklog: knownMetric(0),
  targetsWithBacklog: knownMetric(0),
  targetBacklogP95: knownMetric(0),
  lastClaimScanCount: { availability: 'unknown' as const, reason: 'not_collected' as const },
  lastGlobalReclaimAgeMs: { availability: 'unknown' as const, reason: 'not_collected' as const },
}

const emptyAnomalies = {
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
  clockSkew: { maxAbsSkewMs: unknownMetric('not_collected') },
}

function account(permissions: readonly string[], id = 'acc-mon'): RequestAccount {
  return {
    id,
    displayName: 'Monitor',
    email: `${id}@example.com`,
    status: 'active',
    roles: [{ id: 'custom', key: 'custom', name: 'Custom', kind: 'custom' }],
    permissions: [...permissions],
  }
}

class StaticAuthGuard implements CanActivate {
  constructor(private readonly actor: RequestAccount | null) {}
  canActivate(context: ExecutionContext): boolean {
    if (!this.actor) throw new UnauthorizedException('未认证')
    context.switchToHttp().getRequest().account = this.actor
    return true
  }
}

async function buildApp(input: {
  actor: RequestAccount | null
  driver?: 'postgres' | 'mysql'
  poolStats?: { totalCount: number; idleCount: number; waitingCount: number } | null
  hint?: typeof unusedChangeHint
}) {
  const moduleRef = await Test.createTestingModule({
    controllers: [MonitoringController],
    providers: [
      Reflector,
      HealthService,
      MonitoringService,
      {
        provide: DB_HANDLE,
        useValue: {
          driver: input.driver ?? 'postgres',
          ping: vi.fn(async () => true),
          close: vi.fn(async () => {}),
          poolStats: () => input.poolStats === undefined
            ? { totalCount: 4, idleCount: 3, waitingCount: 0 }
            : input.poolStats,
        },
      },
      { provide: CHANGE_HINT, useValue: input.hint ?? unusedChangeHint },
      {
        provide: JwtService,
        useValue: { decode: () => ({ exp: Date.now() / 1000 + 3600 }) },
      },
      {
        provide: AuthService,
        useValue: {
          resolveAccount: async () => input.actor ?? account([]),
        },
      },
      {
        provide: ApiInstanceHeartbeatService,
        useValue: { identity: () => ({ id: 'api-test', idSource: 'configured' }) },
      },
      {
        provide: OBJECT_STORE,
        useValue: { probe: vi.fn(async () => ({ ok: true, latencyMs: 4, errorClass: null })) },
      },
      { provide: LocalSecretProvider, useValue: { encrypt: () => Buffer.from('cipher') } },
      { provide: APP_GUARD, useValue: new StaticAuthGuard(input.actor) },
      { provide: APP_GUARD, useClass: PermissionsGuard },
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ],
  }).compile()
  const app = moduleRef.createNestApplication({ logger: false })
  await listenForSupertest(app)
  return app
}

function mockHappyPath() {
  vi.mocked(readMonitorClock).mockResolvedValue(AS_OF)
  vi.mocked(readSchemaVersion).mockResolvedValue({
    expectedLogicalVersion: '0059',
    expectedPrefix: '0059',
    appliedPrefix: '0059',
    schemaConsistency: 'consistent',
  })
  vi.mocked(summarizeFleet).mockResolvedValue({ asOf: AS_OF, data: emptyCapacity, liveHeartbeatStale: 0 })
  vi.mocked(summarizeQueues).mockResolvedValue({ asOf: AS_OF, data: emptyQueues })
  vi.mocked(summarizeAnomalies).mockResolvedValue({ asOf: AS_OF, data: emptyAnomalies })
  vi.mocked(summarizeAi).mockResolvedValue({
    calls: knownMetric(0),
    errors: knownMetric(0),
    inputTokens: knownMetric(0),
    outputTokens: knownMetric(0),
    durationP95Ms: unknownMetric('not_collected'),
    cost: unknownMetric('not_collected'),
    lastCallAt: null,
    lastErrorAt: null,
    lastErrorClass: null,
  })
  vi.mocked(listApiInstanceCard).mockResolvedValue({
    ready: unknownMetric('not_collected'),
    lost: unknownMetric('not_collected'),
    derivedCount: unknownMetric('not_collected'),
    items: [],
  })
  vi.mocked(readObjectStoreCard).mockResolvedValue({
    status: unknownMetric('not_collected'),
    latencyMs: unknownMetric('not_collected'),
    probedAt: null,
    errorClass: null,
  })
  vi.mocked(readMonitorSeries).mockResolvedValue({
    asOf: AS_OF.toISOString(),
    from: AS_OF.toISOString(),
    to: AS_OF.toISOString(),
    scope: 'platform',
    scopeId: '',
    items: [],
  })
  vi.mocked(listMonitorAlerts).mockResolvedValue({
    asOf: AS_OF.toISOString(),
    items: [],
  })
  vi.mocked(listMonitorAlertRules).mockResolvedValue({
    revision: 1,
    rules: FACTORY_ALERTING.rules,
    channels: [],
  })
  vi.mocked(updateAlertingRules).mockResolvedValue({
    revision: 2,
    document: FACTORY_PLATFORM_CONFIG,
    updatedAt: AS_OF.toISOString(),
    updatedByAccountId: '00000000-0000-4000-8000-000000000012',
    reason: '开启失联告警',
    source: 'update',
  })
  vi.mocked(upsertAlertChannel).mockResolvedValue({
    revision: 3,
    document: FACTORY_PLATFORM_CONFIG,
    updatedAt: AS_OF.toISOString(),
    updatedByAccountId: '00000000-0000-4000-8000-000000000012',
    reason: '登记 webhook',
    source: 'update',
  })
  vi.mocked(registerStandaloneSecret).mockResolvedValue({ id: '00000000-0000-4000-8000-000000000011' })
  vi.mocked(listMonitorProfiles).mockResolvedValue({
    asOf: AS_OF.toISOString(),
    items: [
      {
        profileKey: 't1/a1',
        locationWorkerId: 'worker-a',
        state: 'PRESENT',
        revision: 1,
        pendingCleanups: 0,
        targetId: '11111111-1111-4111-8111-111111111111',
        targetAccountId: '22222222-2222-4222-8222-222222222222',
        targetName: '目标',
        accountLabel: '账号',
        updatedAt: AS_OF.toISOString(),
        diskUsageBytes: unknownMetric('not_collected'),
      },
    ],
    nodes: [],
  })
}

describe('Monitoring HTTP', () => {
  let reader: INestApplication
  let author: INestApplication
  let viewer: INestApplication
  let operator: INestApplication
  let mysql: INestApplication
  let downHint: INestApplication

  beforeAll(async () => {
    reader = await buildApp({ actor: account(['monitor:read']) })
    author = await buildApp({ actor: account(['workflow:write', 'run:read', 'session:read']) })
    viewer = await buildApp({ actor: account(['run:read', 'target:read']) })
    operator = await buildApp({ actor: account(['monitor:read', 'session:read', 'session:dispose']) })
    mysql = await buildApp({ actor: account(['monitor:read']), driver: 'mysql', poolStats: null })
    downHint = await buildApp({
      actor: account(['monitor:read']),
      hint: { ...unusedChangeHint, realtime: true, ping: async () => false },
    })
  })

  afterAll(async () => {
    await reader.close()
    await author.close()
    await viewer.close()
    await operator.close()
    await mysql.close()
    await downHint.close()
  })

  beforeEach(() => {
    mockHappyPath()
    for (const app of [reader, author, viewer, operator, mysql, downHint]) {
      const svc = app.get(MonitoringService) as unknown as {
        overviewCached: null
        overviewInFlight: null
      }
      svc.overviewCached = null
      svc.overviewInFlight = null
    }
  })

  it('RMA01 只读：仅 GET，open/v1 下无监控路由', async () => {
    await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    await request(reader.getHttpServer()).post('/monitoring/overview').expect(404)
    await request(reader.getHttpServer()).post('/monitoring/stream').expect(404)
    await request(reader.getHttpServer()).get('/open/v1/monitoring/overview').expect(404)
    await request(reader.getHttpServer()).get('/open/v1/monitoring/profiles').expect(404)
    await request(reader.getHttpServer()).get('/open/v1/monitoring/stream').expect(404)
    await request(reader.getHttpServer()).get('/open/v1/monitoring/series').expect(404)
    await request(reader.getHttpServer()).post('/open/v1/monitoring/probe').expect(404)
    await request(reader.getHttpServer()).get('/open/v1/monitoring/alerts').expect(404)
    await request(reader.getHttpServer()).get('/open/v1/monitoring/alert-rules').expect(404)
    await request(reader.getHttpServer()).post('/open/v1/monitoring/alert-channels').expect(404)
    await request(reader.getHttpServer())
      .post('/open/v1/monitoring/alerts/00000000-0000-4000-8000-000000000021/silence')
      .expect(404)
  })

  it('RMA04/RMA11 未知不等于零：磁盘未采集、MySQL 池水位 unsupported', async () => {
    const pg = await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(() => monitoringOverviewResponseSchema.parse(pg.body)).not.toThrow()
    expect(pg.body.partitions.service.data.database.pool.totalCount).toEqual(knownMetric(4))
    const my = await request(mysql.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(my.body.partitions.service.data.database.pool.totalCount).toEqual(unknownMetric('unsupported'))
    expect(my.body.partitions.service.data.database.pool.totalCount).not.toEqual(knownMetric(0))
    const profiles = await request(reader.getHttpServer()).get('/monitoring/profiles').expect(200)
    expect(profiles.body.items[0].diskUsageBytes).toEqual(unknownMetric('not_collected'))
    expect(profiles.body.items[0].diskUsageBytes).not.toEqual(knownMetric(0))
  })

  it('RMA05 分区降级：单个分区失败不 500', async () => {
    vi.mocked(summarizeFleet).mockRejectedValue(new Error('connection refused postgres://secret:pw@db/cairn'))
    const res = await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(res.body.partitions.capacity).toEqual({
      availability: 'unavailable',
      reasonCode: 'DATA_PLANE_UNAVAILABLE',
      message: '数据面不可用',
    })
    expect(res.body.partitions.service.availability).toBe('available')
    expect(res.body.partitions.queues.availability).toBe('available')
    expect(res.body.partitions.anomalies.availability).toBe('available')
    expect(JSON.stringify(res.body)).not.toMatch(/postgres:\/\//)
    expect(JSON.stringify(res.body)).not.toMatch(/secret:pw/)
  })

  it('RMA05 分区出站校验失败只降级该分区', async () => {
    vi.mocked(summarizeQueues).mockResolvedValue({
      asOf: AS_OF,
      data: {
        ...emptyQueues,
        oldestWaitMs: { availability: 'known', value: Number.NaN },
      },
    })
    const res = await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(res.body.partitions.queues).toEqual({
      availability: 'unavailable',
      reasonCode: 'AGGREGATE_FAILED',
      message: '聚合失败',
    })
    expect(res.body.partitions.service.availability).toBe('available')
    expect(res.body.partitions.capacity.availability).toBe('available')
    expect(res.body.partitions.anomalies.availability).toBe('available')
  })

  it('RMA06 有界读取：overview 不内嵌无界列表，profiles 校验 limit', async () => {
    const overview = await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(overview.body.partitions.capacity.data.items).toBeUndefined()
    expect(overview.body.partitions.queues.data.items).toBeUndefined()
    expect(overview.body.partitions.service.data.apiInstances.items.length).toBeLessThanOrEqual(16)
    expect(overview.body.partitions.capacity.data.workerSamples.items.length).toBeLessThanOrEqual(32)
    await request(reader.getHttpServer()).get('/monitoring/profiles?limit=101').expect(400)
    await request(reader.getHttpServer()).get('/monitoring/profiles?limit=0').expect(400)
    await request(reader.getHttpServer()).get('/monitoring/profiles?cursor=').expect(400)
  })

  it('RMA08 权限：viewer/author 拒绝，monitor:read 可读，不按角色名', async () => {
    await request(viewer.getHttpServer()).get('/monitoring/overview').expect(403)
    await request(author.getHttpServer()).get('/monitoring/overview').expect(403)
    await request(author.getHttpServer()).get('/monitoring/profiles').expect(403)
    const custom = await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(custom.body.partitions.service.availability).toBe('available')
    const ops = await request(operator.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(JSON.stringify(ops.body)).not.toMatch(/internalEndpoint/)
    expect(JSON.stringify(ops.body)).not.toMatch(/127\.0\.0\.1:8091/)
  })

  it('RMA09 脱敏：响应不含连接串、Redis、bucket、路径', async () => {
    const res = await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    const text = JSON.stringify(res.body)
    expect(text).not.toMatch(/redis:\/\//i)
    expect(text).not.toMatch(/s3:\/\//i)
    expect(text).not.toMatch(/\/Users\//)
    expect(text).not.toMatch(/bucket/)
    expect(text).not.toMatch(/CAIRN_DB_PASSWORD/)
  })

  it('RMA10 降级后果可读：realtime=false 与 down 都写明实时进度不可用', async () => {
    const unused = await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(unused.body.partitions.service.data.changeHint).toMatchObject({
      status: 'unused',
      realtime: false,
      realtimeProgressAvailable: false,
      consequence: MONITOR_REALTIME_UNAVAILABLE,
    })
    const down = await request(downHint.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(down.body.partitions.service.data.changeHint).toMatchObject({
      status: 'down',
      realtime: true,
      realtimeProgressAvailable: false,
      consequence: MONITOR_REALTIME_UNAVAILABLE,
    })
  })

  it('admin 权限集可读，operate 单独不能读', async () => {
    const adminApp = await buildApp({ actor: account([...PERMISSIONS], 'acc-admin') })
    await request(adminApp.getHttpServer()).get('/monitoring/overview').expect(200)
    await adminApp.close()
    const operateOnly = await buildApp({ actor: account(['monitor:operate']) })
    await request(operateOnly.getHttpServer()).get('/monitoring/overview').expect(403)
    await request(operateOnly.getHttpServer()).get('/monitoring/stream').expect(403)
    await operateOnly.close()
  })

  it('RMB03/RMB04 SSE：权限、Last-Event-ID、间隔下限与 keepalive 参数', async () => {
    await request(viewer.getHttpServer()).get('/monitoring/stream').expect(403)
    await request(author.getHttpServer()).get('/monitoring/stream').expect(403)
    const source = readFileSync(join(__dirname, 'monitoring.service.ts'), 'utf8')
    const controller = readFileSync(join(__dirname, 'monitoring.controller.ts'), 'utf8')
    expect(source).not.toMatch(/setTimeout\(\(\) => void tick\(\), 1000\)/)
    expect(source).toMatch(/CAIRN_MONITOR_SSE_(INTERVAL|MIN_INTERVAL)_MS/)
    expect(source).toMatch(/CAIRN_SSE_HEARTBEAT_MS/)
    expect(source).toMatch(/CAIRN_SSE_AUTH_REFRESH_MS/)
    expect(controller).toMatch(/abortWhenSseClientDrops/)
    const stream = vi.spyOn(reader.get(MonitoringService), 'stream').mockImplementation(async (input) => {
      input.response.status(200)
      input.response.setHeader('Content-Type', 'text/event-stream')
      input.response.setHeader('Cache-Control', 'no-cache, no-transform')
      input.response.end()
    })
    const res = await request(reader.getHttpServer())
      .get('/monitoring/stream?intervalMs=1000')
      .set('Last-Event-ID', '2026-09-17T00:00:00.000Z')
      .set('Accept', 'text/event-stream')
      .expect(200)
    expect(res.headers['content-type']).toMatch(/text\/event-stream/)
    expect(res.request.url).not.toMatch(/token=|access_token=/)
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        intervalMs: 1_000,
        lastEventId: '2026-09-17T00:00:00.000Z',
      }),
    )
    stream.mockRestore()
  })

  it('RMC08/RMC17 series 与探测权限、限流、成本 unknown', async () => {
    const series = await request(reader.getHttpServer())
      .get('/monitoring/series?keys=queue.claimableRuns,worker.status.ready')
      .expect(200)
    expect(series.body.items).toEqual([])
    await request(reader.getHttpServer()).get('/monitoring/series?keys=not.a.key').expect(400)
    await request(reader.getHttpServer())
      .get(
        `/monitoring/series?keys=queue.claimableRuns&from=${encodeURIComponent(new Date(Date.now() - 40 * 86_400_000).toISOString())}`,
      )
      .expect(400)
    await request(reader.getHttpServer())
      .get(
        '/monitoring/series?keys=queue.claimableRuns,worker.status.ready,evidence.pendingUpload,worker.status.lost,queue.oldestWaitMs,queue.unclaimableRuns,queue.recovering,queue.needsReview,ai.calls',
      )
      .expect(400)
    await request(reader.getHttpServer()).post('/monitoring/probe').send({ target: 'object_store' }).expect(403)
    const operatorApp = await buildApp({ actor: account(['monitor:read', 'monitor:operate'], 'acc-probe') })
    vi.mocked(recordManualObjectStoreProbe).mockResolvedValue({
      status: knownMetric(1),
      latencyMs: knownMetric(4),
      probedAt: AS_OF.toISOString(),
      errorClass: null,
    })
    await request(operatorApp.getHttpServer()).post('/monitoring/probe').send({ target: 'object_store' }).expect(200)
    const limited = await request(operatorApp.getHttpServer())
      .post('/monitoring/probe')
      .send({ target: 'object_store' })
      .expect(429)
    expect(limited.headers['retry-after']).toBeDefined()
    const overview = await request(reader.getHttpServer()).get('/monitoring/overview').expect(200)
    expect(overview.body.partitions.ai.data.cost).toEqual(unknownMetric('not_collected'))
    const profiles = await request(reader.getHttpServer()).get('/monitoring/profiles').expect(200)
    expect(profiles.body.items[0].diskUsageBytes).toEqual(unknownMetric('not_collected'))
    expect(profiles.body.nodes).toEqual([])
    await operatorApp.close()
  })

  it('RMD09 告警权限：可读、可静默、可改规则／渠道', async () => {
    const rules = await request(reader.getHttpServer()).get('/monitoring/alert-rules').expect(200)
    expect(rules.body.rules.every((rule: { enabled: boolean }) => rule.enabled === false)).toBe(true)
    expect(JSON.stringify(rules.body)).not.toMatch(/https?:\/\/|token/i)
    await request(reader.getHttpServer()).get('/monitoring/alerts').expect(200)
    await request(author.getHttpServer()).get('/monitoring/alerts').expect(403)
    await request(viewer.getHttpServer()).get('/monitoring/alert-rules').expect(403)
    await request(reader.getHttpServer())
      .post('/monitoring/alerts/00000000-0000-4000-8000-000000000021/silence')
      .send({ durationSeconds: 300 })
      .expect(403)

    const operatorApp = await buildApp({ actor: account(['monitor:read', 'monitor:operate'], 'acc-silence') })
    vi.mocked(silenceMonitorAlert).mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000021',
      ruleId: 'factory.worker.lost',
      ruleName: '执行节点失联',
      kind: 'threshold',
      metricKey: 'worker.status.lost',
      staleSource: null,
      scope: 'platform',
      scopeId: 'platform',
      state: 'firing',
      severity: 'critical',
      comparator: 'gte',
      threshold: 1,
      triggerValue: 1,
      conditionOpenedAt: AS_OF.toISOString(),
      firedAt: AS_OF.toISOString(),
      interruptedAt: null,
      resolvedAt: null,
      silencedUntil: new Date(AS_OF.getTime() + 300_000).toISOString(),
      silenceRemainingSeconds: 300,
      noticeKind: 'firing',
      deliveryStatus: 'pending',
      lastDeliveryError: null,
    })
    const silenced = await request(operatorApp.getHttpServer())
      .post('/monitoring/alerts/00000000-0000-4000-8000-000000000021/silence')
      .send({ durationSeconds: 300 })
      .expect(200)
    expect(silenced.body.state).toBe('firing')
    await request(operatorApp.getHttpServer())
      .post('/monitoring/alerts/00000000-0000-4000-8000-000000000021/silence')
      .send({ durationSeconds: 300 })
      .expect(429)

    const writer = await buildApp({ actor: account(['monitor:read', 'platform-config:write'], 'acc-rules') })
    await request(operatorApp.getHttpServer())
      .post('/monitoring/alert-rules')
      .send({ expectedRevision: 1, reason: '开启', rules: FACTORY_ALERTING.rules })
      .expect(403)
    await request(writer.getHttpServer())
      .post('/monitoring/alert-rules')
      .send({
        expectedRevision: 1,
        reason: '开启失联',
        rules: FACTORY_ALERTING.rules.map((rule) =>
          rule.id === 'factory.worker.lost' ? { ...rule, enabled: true } : rule,
        ),
      })
      .expect(200)
    const channel = await request(writer.getHttpServer())
      .post('/monitoring/alert-channels')
      .send({
        expectedRevision: 2,
        reason: '登记 webhook',
        name: '值班',
        url: 'https://hooks.example.com/alert',
        token: 'secret-token',
      })
      .expect(200)
    expect(JSON.stringify(channel.body)).not.toContain('hooks.example.com/alert')
    expect(JSON.stringify(channel.body)).not.toContain('secret-token')
    expect(vi.mocked(registerStandaloneSecret)).not.toHaveBeenCalled()
    expect(vi.mocked(upsertAlertChannel)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        secret: expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000011',
          ciphertext: expect.any(Buffer),
        }),
      }),
    )
    await request(writer.getHttpServer())
      .post('/monitoring/alert-channels')
      .send({
        expectedRevision: 2,
        reason: '内网地址',
        name: '坏渠道',
        url: 'http://127.0.0.1/hook',
      })
      .expect(400)
    await request(writer.getHttpServer())
      .post('/monitoring/alert-rules')
      .send({
        expectedRevision: 1,
        reason: 'L1 非法',
        rules: [
          {
            kind: 'threshold',
            id: 'bad.l1',
            name: '数据库 ping',
            metricKey: 'database.pingLatencyMs',
            scope: 'platform',
            comparator: 'gte',
            threshold: 200,
            forSeconds: 60,
            severity: 'warning',
            channelIds: [],
            enabled: true,
          },
        ],
      })
      .expect(400)
    await operatorApp.close()
    await writer.close()
  })

  it('PS11 overview 并发共享在途查询，失败不缓存，且无调用者参数', async () => {
    expect(MonitoringService.prototype.overview.length).toBe(0)
    const app = await buildApp({ actor: account(['monitor:read']) })
    mockHappyPath()
    vi.mocked(summarizeFleet).mockClear()
    vi.mocked(summarizeQueues).mockClear()
    vi.mocked(summarizeAnomalies).mockClear()
    vi.mocked(summarizeAi).mockClear()
    const svc = app.get(MonitoringService)
    await Promise.all(Array.from({ length: 50 }, () => svc.overview()))
    expect(summarizeFleet).toHaveBeenCalledTimes(1)
    expect(summarizeQueues).toHaveBeenCalledTimes(1)
    expect(summarizeAnomalies).toHaveBeenCalledTimes(1)
    expect(summarizeAi).toHaveBeenCalledTimes(1)
    const cached = await Promise.all([svc.overview(), svc.overview()])
    expect(cached[0]?.asOf).toBe(cached[1]?.asOf)
    expect(summarizeFleet).toHaveBeenCalledTimes(1)
    ;(
      svc as unknown as { overviewCached: null; overviewInFlight: null }
    ).overviewCached = null
    const load = vi
      .spyOn(svc as unknown as { loadOverview: () => Promise<unknown> }, 'loadOverview')
      .mockRejectedValueOnce(new Error('boom'))
    await expect(svc.overview()).rejects.toThrow('boom')
    expect((svc as unknown as { overviewCached: unknown }).overviewCached).toBeNull()
    load.mockRestore()
    await svc.overview()
    expect(summarizeFleet).toHaveBeenCalledTimes(2)
    await app.close()
  })
})
