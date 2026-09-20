import { Inject, Injectable, Logger } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Response } from 'express'
import {
  DomainError,
  latestLogicalVersion,
  latestLogicalVersionForDriver,
  listApiInstanceCard,
  listMonitorAlertRules,
  listMonitorAlerts,
  listMonitorProfiles,
  newId,
  readMonitorClock,
  readMonitorSeries,
  readObjectStoreCard,
  readSchemaVersion,
  recordManualObjectStoreProbe,
  silenceMonitorAlert,
  summarizeAi,
  summarizeAnomalies,
  summarizeFleet,
  summarizeQueues,
  updateAlertingRules,
  upsertAlertChannel,
  type DbHandle,
} from '@cairn/db'
import {
  MONITOR_PROBE_RATE_LIMIT_MS,
  MONITOR_REALTIME_UNAVAILABLE,
  MONITOR_SILENCE_RATE_LIMIT_MS,
  alertWebhookHost,
  alertWebhookSecretPayloadSchema,
  clampMonitorSseInterval,
  entityIdSchema,
  hasPermission,
  knownMetric,
  localAlertSecretRef,
  monitorAiCardSchema,
  monitorAlertItemSchema,
  monitorAlertListResponseSchema,
  monitorAlertRulesResponseSchema,
  monitorAnomaliesCardSchema,
  monitorCapacityCardSchema,
  monitorObjectStoreCardSchema,
  monitorProbeResponseSchema,
  monitorProfileListResponseSchema,
  monitorQueuesCardSchema,
  monitorSeriesResponseSchema,
  monitorServiceCardSchema,
  monitorStreamControlSchema,
  monitoringOverviewResponseSchema,
  platformConfigCurrentSchema,
  unknownMetric,
  type MonitorAiCard,
  type MonitorAlertChannelBody,
  type MonitorAlertListQuery,
  type MonitorAlertRulesUpdateBody,
  type MonitorAlertSilenceBody,
  type MonitorAnomaliesCard,
  type MonitorCapacityCard,
  type MonitorObjectStoreCard,
  type MonitorProfileListQuery,
  type MonitorProfileListResponse,
  type MonitorQueuesCard,
  type MonitorSeriesQuery,
  type MonitorSeriesResponse,
  type MonitorServiceCard,
  type MonitorStreamControl,
  type MonitorUnavailableReason,
  type MonitoringOverviewResponse,
} from '@cairn/shared'
import type { ObjectStore } from '@cairn/storage'
import { OBJECT_STORE } from '../objects/object-store.token'
import { trackSseConnection } from '../common/process-gauges'
import { ApiInstanceHeartbeatService } from './api-instance.service'
import { DB_HANDLE } from '../db/db.module'
import { classifyAccountRecheck, rethrowDomain } from '../common/domain-error'
import { config } from '../config/env'
import { AuthService } from '../auth/auth.service'
import { HealthService } from '../health/health.service'
import { LocalSecretProvider } from '../secrets/local-secret-provider'

type Partition<T> =
  | { availability: 'available'; source: 'self' | 'registry' | 'aggregate'; sampledAt: string; data: T }
  | { availability: 'unavailable'; reasonCode: MonitorUnavailableReason; message: string }

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name)
  private readonly lastProbeAt = new Map<string, number>()
  private readonly lastSilenceAt = new Map<string, number>()
  private overviewInFlight: Promise<MonitoringOverviewResponse> | null = null
  private overviewCached: { value: MonitoringOverviewResponse; expiresAt: number } | null = null

  constructor(
    @Inject(DB_HANDLE) private readonly handle: DbHandle,
    private readonly health: HealthService,
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly apiInstances: ApiInstanceHeartbeatService,
    private readonly secrets: LocalSecretProvider,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  async overview(): Promise<MonitoringOverviewResponse> {
    const now = Date.now()
    const cached = this.overviewCached
    if (cached && now < cached.expiresAt) return cached.value
    if (this.overviewInFlight) return this.overviewInFlight
    const pending = this.loadOverview()
      .then((value) => {
        this.overviewCached = {
          value,
          expiresAt: Date.now() + config.CAIRN_MONITOR_OVERVIEW_CACHE_MS,
        }
        return value
      })
      .finally(() => {
        if (this.overviewInFlight === pending) this.overviewInFlight = null
      })
    this.overviewInFlight = pending
    return pending
  }

  private async loadOverview(): Promise<MonitoringOverviewResponse> {
    const asOf = await this.resolveAsOf()
    const sampledAt = asOf.toISOString()
    const [service, capacity, queues, anomalies, ai] = await Promise.all([
      this.loadService(asOf, sampledAt),
      this.loadPartition(
        'capacity',
        'registry',
        sampledAt,
        () => summarizeFleet(this.handle, asOf).then((row) => row.data),
        monitorCapacityCardSchema,
      ),
      this.loadPartition(
        'queues',
        'aggregate',
        sampledAt,
        () => summarizeQueues(this.handle, asOf).then((row) => row.data),
        monitorQueuesCardSchema,
      ),
      this.loadPartition(
        'anomalies',
        'aggregate',
        sampledAt,
        () => summarizeAnomalies(this.handle, asOf).then((row) => row.data),
        monitorAnomaliesCardSchema,
      ),
      this.loadPartition('ai', 'aggregate', sampledAt, () => summarizeAi(this.handle, asOf), monitorAiCardSchema),
    ])
    return monitoringOverviewResponseSchema.parse({
      asOf: sampledAt,
      partitions: { service, capacity, queues, anomalies, ai },
    })
  }

  async series(query: MonitorSeriesQuery): Promise<MonitorSeriesResponse> {
    try {
      return monitorSeriesResponseSchema.parse(await readMonitorSeries(this.handle, query))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async probe(actor: { id: string }): Promise<ReturnType<typeof monitorProbeResponseSchema.parse>> {
    try {
      const now = Date.now()
      const previous = this.lastProbeAt.get(actor.id)
      if (previous != null && now - previous < MONITOR_PROBE_RATE_LIMIT_MS) {
        throw new DomainError('rate_limited', 'MONITOR_PROBE_RATE', '探测过于频繁', {
          retryAfter: Math.ceil((MONITOR_PROBE_RATE_LIMIT_MS - (now - previous)) / 1000),
        })
      }
      this.lastProbeAt.set(actor.id, now)
      const result = await this.store.probe()
      const objectStore = await recordManualObjectStoreProbe(this.handle, {
        status: result.ok ? 'ok' : 'failed',
        latencyMs: result.latencyMs,
        errorClass: result.errorClass,
        probedBy: `api:${this.apiInstances.identity().id}`,
        actor: { id: actor.id },
      })
      return monitorProbeResponseSchema.parse({
        asOf: objectStore.probedAt ?? new Date().toISOString(),
        target: 'object_store',
        objectStore,
      })
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async profiles(query: MonitorProfileListQuery): Promise<MonitorProfileListResponse> {
    try {
      return monitorProfileListResponseSchema.parse(await listMonitorProfiles(this.handle, query))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async alerts(query: MonitorAlertListQuery) {
    try {
      return monitorAlertListResponseSchema.parse(await listMonitorAlerts(this.handle, query))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async alertRules() {
    try {
      return monitorAlertRulesResponseSchema.parse(await listMonitorAlertRules(this.handle))
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async updateAlertRules(body: MonitorAlertRulesUpdateBody, actor: { id: string }) {
    try {
      return platformConfigCurrentSchema.parse(
        await updateAlertingRules(this.handle, {
          expectedRevision: body.expectedRevision,
          reason: body.reason,
          rules: body.rules,
          actor,
        }),
      )
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async upsertAlertChannel(body: MonitorAlertChannelBody, actor: { id: string }) {
    try {
      const payload = alertWebhookSecretPayloadSchema.parse({
        v: 1,
        url: body.url,
        ...(body.token ? { token: body.token } : {}),
      })
      const current = await listMonitorAlertRules(this.handle)
      const existing = body.id ? current.channels.find((channel) => channel.id === body.id) : undefined
      const secretId = newId()
      return platformConfigCurrentSchema.parse(
        await upsertAlertChannel(this.handle, {
          expectedRevision: body.expectedRevision,
          reason: body.reason,
          actor,
          channel: {
            id: body.id ?? existing?.id ?? newId(),
            name: body.name,
            kind: 'webhook',
            enabled: body.enabled,
            secretRef: localAlertSecretRef(secretId),
            urlHost: alertWebhookHost(payload.url),
          },
          secret: {
            id: secretId,
            ciphertext: this.secrets.encrypt(secretId, JSON.stringify(payload)),
          },
        }),
      )
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async silence(alertId: string, body: MonitorAlertSilenceBody, actor: { id: string }) {
    try {
      entityIdSchema.parse(alertId)
      const now = Date.now()
      const previous = this.lastSilenceAt.get(actor.id)
      if (previous != null && now - previous < MONITOR_SILENCE_RATE_LIMIT_MS) {
        throw new DomainError('rate_limited', 'MONITOR_SILENCE_RATE', '静默过于频繁', {
          retryAfter: Math.ceil((MONITOR_SILENCE_RATE_LIMIT_MS - (now - previous)) / 1000),
        })
      }
      this.lastSilenceAt.set(actor.id, now)
      return monitorAlertItemSchema.parse(
        await silenceMonitorAlert(this.handle, {
          alertId,
          durationSeconds: body.durationSeconds,
          actor,
        }),
      )
    } catch (error) {
      rethrowDomain(error)
    }
  }

  async stream(input: {
    intervalMs?: number
    lastEventId?: string
    authorization?: string
    account: { id: string }
    response: Response
    signal: AbortSignal
  }): Promise<void> {
    const res = input.response
    res.status(200)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const releaseSse = trackSseConnection()

    const intervalMs = clampMonitorSseInterval(
      input.intervalMs,
      config.CAIRN_MONITOR_SSE_MIN_INTERVAL_MS,
      config.CAIRN_MONITOR_SSE_INTERVAL_MS,
    )
    const expiresAt = this.tokenExpiresAt(input.authorization)
    let closed = false
    let tickTimer: NodeJS.Timeout | undefined
    let heartbeat: NodeJS.Timeout | undefined
    let authTick: NodeJS.Timeout | undefined
    let lastAsOf = input.lastEventId

    const close = () => {
      if (closed) return
      closed = true
      releaseSse()
      if (tickTimer) clearTimeout(tickTimer)
      if (heartbeat) clearInterval(heartbeat)
      if (authTick) clearInterval(authTick)
      if (!res.writableEnded) res.end()
    }
    const sendControl = (control: MonitorStreamControl) => {
      writeFrame(res, { event: control.kind, data: monitorStreamControlSchema.parse(control) })
    }
    const sendSnapshot = (snapshot: MonitoringOverviewResponse) => {
      writeFrame(res, { id: snapshot.asOf, event: 'snapshot', data: snapshot })
    }

    input.signal.addEventListener('abort', close)
    res.on('close', close)
    if (Date.now() >= expiresAt) {
      sendControl({ kind: 'error', code: 'UNAUTHORIZED', message: '登录已过期或无效' })
      close()
      return
    }

    sendControl({
      kind: 'ready',
      intervalMs,
      minIntervalMs: config.CAIRN_MONITOR_SSE_MIN_INTERVAL_MS,
    })

    const tick = async () => {
      if (closed) return
      try {
        const snapshot = await this.overview()
        if (closed) return
        if (snapshot.asOf !== lastAsOf) {
          sendSnapshot(snapshot)
          lastAsOf = snapshot.asOf
        }
      } catch (error) {
        this.logger.warn(
          { errName: error instanceof Error ? error.name : 'Error' },
          '监控快照推送失败',
        )
      }
      if (closed) return
      tickTimer = setTimeout(() => void tick(), intervalMs)
      tickTimer.unref()
    }
    await tick()
    if (closed) return

    heartbeat = setInterval(() => {
      if (closed) return
      res.write(': keepalive\n\n')
    }, config.CAIRN_SSE_HEARTBEAT_MS)
    heartbeat.unref()

    authTick = setInterval(() => {
      void this.recheck(input.account.id, expiresAt)
        .then((code) => {
          if (!code || closed) return
          if (code === 'INTERNAL') {
            this.logger.warn('监控 SSE 鉴权复核暂时失败，保持连接')
            return
          }
          sendControl({
            kind: 'error',
            code,
            message:
              code === 'UNAUTHORIZED' ? '登录已过期或无效' : '没有运行监控读取权限',
          })
          close()
        })
        .catch((error) => this.logger.error(error, 'sse auth refresh failed'))
    }, config.CAIRN_SSE_AUTH_REFRESH_MS)
    authTick.unref()
  }

  private tokenExpiresAt(authorization?: string): number {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
    if (!token) return Date.now() + 12 * 3600 * 1000
    const payload = this.jwt.decode(token)
    if (payload && typeof payload === 'object' && 'exp' in payload && typeof payload.exp === 'number') {
      return payload.exp * 1000
    }
    return Date.now() + 12 * 3600 * 1000
  }

  private async recheck(
    accountId: string,
    expiresAt: number,
  ): Promise<'UNAUTHORIZED' | 'FORBIDDEN' | 'INTERNAL' | null> {
    if (Date.now() >= expiresAt) return 'UNAUTHORIZED'
    try {
      const account = await this.auth.resolveAccount(accountId)
      if (account.status !== 'active') return 'FORBIDDEN'
      if (!hasPermission(account.permissions, 'monitor:read')) return 'FORBIDDEN'
      return null
    } catch (error) {
      return classifyAccountRecheck(error)
    }
  }

  private async resolveAsOf(): Promise<Date> {
    try {
      return await readMonitorClock(this.handle)
    } catch {
      return new Date()
    }
  }

  private async loadService(asOf: Date, sampledAt: string): Promise<Partition<MonitorServiceCard>> {
    try {
      const inspect = await this.health.inspect()
      let expectedLogicalVersion = latestLogicalVersion()
      let expectedPrefix = latestLogicalVersionForDriver(this.handle.driver)
      let appliedPrefix: string | null = null
      let schemaConsistency: MonitorServiceCard['database']['schemaConsistency'] = 'unknown'
      try {
        const schema = await readSchemaVersion(this.handle)
        expectedLogicalVersion = schema.expectedLogicalVersion
        expectedPrefix = schema.expectedPrefix
        appliedPrefix = schema.appliedPrefix
        schemaConsistency = schema.schemaConsistency
      } catch (error) {
        this.warnPartition('service-schema', error)
      }
      const pool = this.handle.poolStats?.() ?? null
      const data: MonitorServiceCard = {
        api: {
          status: inspect.status,
          service: inspect.service,
          uptimeSeconds: knownMetric(inspect.uptimeSeconds),
        },
        database: {
          driver: this.handle.driver,
          ping: inspect.database,
          pingLatencyMs:
            inspect.pingLatencyMs == null ? unknownMetric('unavailable') : knownMetric(inspect.pingLatencyMs),
          expectedLogicalVersion,
          appliedPrefix,
          expectedPrefix,
          schemaConsistency,
          pool: pool
            ? {
                totalCount: knownMetric(pool.totalCount),
                idleCount: knownMetric(pool.idleCount),
                waitingCount: knownMetric(pool.waitingCount),
              }
            : {
                totalCount: unknownMetric('unsupported'),
                idleCount: unknownMetric('unsupported'),
                waitingCount: unknownMetric('unsupported'),
              },
        },
        changeHint: {
          status: inspect.changeHint,
          realtime: inspect.realtime,
          realtimeProgressAvailable: inspect.changeHint === 'up',
          consequence:
            inspect.changeHint === 'down' || !inspect.realtime ? MONITOR_REALTIME_UNAVAILABLE : null,
        },
        apiInstances: await this.loadApiInstances(asOf),
        objectStore: await this.loadObjectStore(asOf),
      }
      return {
        availability: 'available',
        source: 'self',
        sampledAt,
        data: monitorServiceCardSchema.parse(data),
      }
    } catch (error) {
      return this.unavailable('service', error)
    }
  }

  private async loadApiInstances(asOf: Date): Promise<MonitorServiceCard['apiInstances']> {
    try {
      return await listApiInstanceCard(this.handle, asOf)
    } catch (error) {
      this.warnPartition('service-api-instances', error)
      return {
        ready: unknownMetric('unavailable'),
        lost: unknownMetric('unavailable'),
        derivedCount: unknownMetric('unavailable'),
        items: [],
      }
    }
  }

  private async loadObjectStore(asOf: Date): Promise<MonitorObjectStoreCard> {
    try {
      return monitorObjectStoreCardSchema.parse(
        await readObjectStoreCard(this.handle, asOf, 2 * config.CAIRN_MONITOR_OBJECT_STORE_PROBE_MS),
      )
    } catch (error) {
      this.warnPartition('service-object-store', error)
      return {
        status: unknownMetric('unavailable'),
        latencyMs: unknownMetric('unavailable'),
        probedAt: null,
        errorClass: null,
      }
    }
  }

  private async loadPartition<T extends MonitorCapacityCard | MonitorQueuesCard | MonitorAnomaliesCard | MonitorAiCard>(
    name: string,
    source: 'registry' | 'aggregate',
    sampledAt: string,
    load: () => Promise<T>,
    schema: { parse(data: unknown): T },
  ): Promise<Partition<T>> {
    try {
      return { availability: 'available', source, sampledAt, data: schema.parse(await load()) }
    } catch (error) {
      return this.unavailable(name, error)
    }
  }

  private unavailable(name: string, error: unknown): Partition<never> {
    this.warnPartition(name, error)
    const reasonCode = this.reasonCode(error)
    return {
      availability: 'unavailable',
      reasonCode,
      message: reasonCode === 'DATA_PLANE_UNAVAILABLE' ? '数据面不可用' : '聚合失败',
    }
  }

  private reasonCode(error: unknown): MonitorUnavailableReason {
    const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
    return /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection|connect|pool|timeout|EPIPE|ECONNRESET/i.test(text)
      ? 'DATA_PLANE_UNAVAILABLE'
      : 'AGGREGATE_FAILED'
  }

  private warnPartition(name: string, error: unknown): void {
    this.logger.warn(
      { partition: name, errName: error instanceof Error ? error.name : 'Error' },
      '监控分区不可用',
    )
  }
}

function writeFrame(res: Response, frame: { id?: string; event: string; data: unknown }): void {
  if (frame.id) res.write(`id: ${frame.id}\n`)
  res.write(`event: ${frame.event}\n`)
  const text = JSON.stringify(frame.data)
  for (const line of text.split('\n')) res.write(`data: ${line}\n`)
  res.write('\n')
}
