import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FACTORY_ALERT_RULES,
  LOCAL_SECRET_PROVIDER,
  SESSION_OCCUPANCY_PROTOCOL,
  alertOpenKey,
  type AlertRule,
  type PlatformConfigDocument,
} from '@cairn/shared'
import { eq } from 'drizzle-orm'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  claimDueAlertDeliveries,
  evaluateAlerts,
  collectAlertReadings,
  finishAlertDelivery,
  insertMonitorSamples,
  listMonitorAlerts,
  upsertAlertChannel,
  markLostWorkers,
  newId,
  registerWorker,
  silenceMonitorAlert,
  upsertObjectStoreProbe,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { getOrCreatePlatformConfig, updatePlatformConfig } from '../platform-config/store.js'
import { loadSecretCiphertext } from '../secrets/store.js'
import { clockNow, schemaFor } from '../native.js'
import { isUniqueViolation } from '../runs/errors.js'
import { consoleAccounts as pg_consoleAccounts } from '../schema/console.js'

const here = dirname(fileURLToPath(import.meta.url))

let consoleAccounts = pg_consoleAccounts

describe('告警评估实现约束', () => {
  it('RMD05 评估不读 L4 采样表', () => {
    const src = readFileSync(resolve(here, '../monitoring/alerts.ts'), 'utf8')
    expect(src).not.toMatch(/monitor_samples|insertMonitorSamples|readMonitorSeries|collectPlatformSamples/)
  })
})

describe.each(DRIVERS)('%s 告警评估', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle
  let actorId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `alrt_${Date.now().toString(36)}`)
    ;({ consoleAccounts } = schemaFor(handle.db))
    actorId = newId()
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'alert',
      email: `alert-${actorId}@example.com`,
      status: 'active',
    })
    const { consoleRoles, consoleAccountRoles } = schemaFor(handle.db)
    const [admin] = await handle.db.select().from(consoleRoles).where(eq(consoleRoles.key, 'admin'))
    await handle.db.insert(consoleAccountRoles).values({ consoleAccountId: actorId, consoleRoleId: admin!.id, targetScopeMode: 'all' })
    await getOrCreatePlatformConfig(handle.db)
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function setRules(rules: AlertRule[]) {
    const current = await getOrCreatePlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: '测试告警规则',
      document: {
        ...current.document,
        alerting: { ...current.document.alerting, rules },
      } satisfies PlatformConfigDocument,
      actor: { id: actorId },
    })
  }

  function enableFactory(id: string, overrides: Partial<AlertRule> = {}): AlertRule[] {
    return FACTORY_ALERT_RULES.map((rule) =>
      rule.id === id ? ({ ...rule, enabled: true, forSeconds: 0, ...overrides } as AlertRule) : rule,
    )
  }

  async function resetAlerts() {
    const { monitoringAlerts } = schemaFor(handle.db)
    await handle.db.delete(monitoringAlerts)
  }

  async function resetWorkers() {
    const { workers } = schemaFor(handle.db)
    await handle.db.delete(workers)
  }

  async function lostWorker(workerId = `lost-${newId().slice(0, 8)}`) {
    await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const { workers } = schemaFor(handle.db)
    await handle.db.update(workers).set({ heartbeatExpiresAt: new Date(Date.now() - 1_000) }).where(eq(workers.id, workerId))
    expect(await markLostWorkers(handle.db)).toContain(workerId)
    return workerId
  }

  it('RMD01 出厂关闭不产生通知', async () => {
    await resetAlerts()
    await setRules(FACTORY_ALERT_RULES)
    await lostWorker()
    const result = await evaluateAlerts(handle.db)
    expect(result).toEqual({ evaluated: 0, fired: 0, resolved: 0, interrupted: 0 })
    const active = await listMonitorAlerts(handle.db, { view: 'active', limit: 20 })
    expect(active.items).toEqual([])
    expect(await claimDueAlertDeliveries(handle.db)).toEqual([])
  })

  it('RMD02/RMD11 并发评估只产生一条 firing，open_key 拦住第二条', async () => {
    await resetAlerts()
    await setRules(enableFactory('factory.worker.lost'))
    await lostWorker()
    const [first, second] = await Promise.all([evaluateAlerts(handle.db), evaluateAlerts(handle.db)])
    expect(first.fired + second.fired).toBe(1)
    const active = await listMonitorAlerts(handle.db, { view: 'active', limit: 20 })
    const lost = active.items.filter((item) => item.ruleId === 'factory.worker.lost' && item.state === 'firing')
    expect(lost).toHaveLength(1)
    const jobs = await claimDueAlertDeliveries(handle.db)
    expect(jobs.filter((job) => job.notice.kind === 'firing' && job.notice.ruleId === 'factory.worker.lost')).toHaveLength(1)

    const { monitoringAlerts } = schemaFor(handle.db)
    const openKey = alertOpenKey('factory.worker.lost', 'platform', 'platform')
    const now = await clockNow(handle.db)
    try {
      await handle.db.insert(monitoringAlerts).values({
        id: newId(),
        ruleId: 'factory.worker.lost',
        ruleName: 'dup',
        scope: 'platform',
        scopeId: 'platform',
        state: 'firing',
        severity: 'critical',
        kind: 'threshold',
        metricKey: 'worker.status.lost',
        conditionOpenedAt: now,
        channelIds: [],
        openKey,
        createdAt: now,
        updatedAt: now,
      })
      throw new Error('expected unique violation')
    } catch (error) {
      expect(isUniqueViolation(error)).toBe(true)
    }
  })

  it('RMD03 未满迟滞只进 pending，不通知', async () => {
    await resetAlerts()
    await setRules(enableFactory('factory.worker.lost', { forSeconds: 600 }))
    const result = await evaluateAlerts(handle.db)
    expect(result.fired).toBe(0)
    const { monitoringAlerts } = schemaFor(handle.db)
    const pending = (await handle.db.select().from(monitoringAlerts)).filter(
      (row) => row.ruleId === 'factory.worker.lost',
    )
    expect(pending).toHaveLength(1)
    expect(pending[0]?.state).toBe('pending')
    expect(await claimDueAlertDeliveries(handle.db)).toEqual([])
  })

  it('RMD04 unknown 不误报，firing 转 unknown 发 interrupted', async () => {
    await resetAlerts()
    await setRules(enableFactory('factory.object_store.down'))
    await evaluateAlerts(handle.db)
    const { monitoringAlerts } = schemaFor(handle.db)
    expect(
      (await handle.db.select().from(monitoringAlerts)).filter((row) => row.ruleId === 'factory.object_store.down'),
    ).toHaveLength(0)

    await upsertObjectStoreProbe(handle.db, {
      status: 'failed',
      latencyMs: 12,
      errorClass: 'unavailable',
      probedBy: 'test',
    })
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    await handle.db.delete(schemaFor(handle.db).objectStoreProbes)
    expect((await evaluateAlerts(handle.db)).interrupted).toBe(1)
    const active = await listMonitorAlerts(handle.db, { view: 'active', limit: 20 })
    const row = active.items.find((item) => item.ruleId === 'factory.object_store.down')
    expect(row?.state).toBe('interrupted')
    expect(row?.noticeKind).toBe('interrupted')
    const jobs = await claimDueAlertDeliveries(handle.db)
    expect(jobs.some((job) => job.notice.kind === 'interrupted')).toBe(true)
  })

  it('RMD05 采样缺失不改变告警', async () => {
    const before = await listMonitorAlerts(handle.db, { view: 'active', limit: 100 })
    await insertMonitorSamples(handle.db, [{ key: 'objectStore.up', scope: 'platform', value: 0 }])
    await evaluateAlerts(handle.db)
    const after = await listMonitorAlerts(handle.db, { view: 'active', limit: 100 })
    expect(after.items.map((item) => item.id).sort()).toEqual(before.items.map((item) => item.id).sort())
    expect(after.items.map((item) => item.state)).toEqual(before.items.map((item) => item.state))
  })

  it('RMD06 投递失败有界重试', async () => {
    await resetAlerts()
    await setRules(enableFactory('factory.worker.lost'))
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    const jobs = await claimDueAlertDeliveries(handle.db, { maxAttempts: 5 })
    const job = jobs.find((item) => item.notice.ruleId === 'factory.worker.lost')
    expect(job).toBeTruthy()
    await finishAlertDelivery(handle.db, { alertId: job!.alertId, status: 'failed', errorClass: 'webhook_unreachable' })
    const { monitoringAlerts } = schemaFor(handle.db)
    const [row] = await handle.db.select().from(monitoringAlerts).where(eq(monitoringAlerts.id, job!.alertId))
    expect(row?.deliveryStatus).toBe('failed')
    expect(row?.deliveryAttempts).toBe(1)
    expect(row?.lastDeliveryError).toBe('webhook_unreachable')
    expect(row?.nextRetryAt).toBeTruthy()
  })

  it('RMD08 静默不改判定且抑制投递', async () => {
    await resetAlerts()
    await setRules(enableFactory('factory.worker.lost'))
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    const active = await listMonitorAlerts(handle.db, { view: 'active', limit: 20 })
    const target = active.items.find((item) => item.ruleId === 'factory.worker.lost' && item.state === 'firing')
    expect(target).toBeTruthy()
    const silenced = await silenceMonitorAlert(handle.db, {
      alertId: target!.id,
      durationSeconds: 300,
      actor: { id: actorId },
    })
    expect(silenced.state).toBe('firing')
    expect(silenced.silenceRemainingSeconds).toBeGreaterThan(0)
    const jobs = await claimDueAlertDeliveries(handle.db)
    const claimed = jobs.find((job) => job.alertId === target!.id)
    expect(claimed?.silenced).toBe(true)
    if (claimed) await finishAlertDelivery(handle.db, { alertId: claimed.alertId, status: 'suppressed' })
    const { monitoringAlerts, consoleAuditEvents } = schemaFor(handle.db)
    const [row] = await handle.db.select().from(monitoringAlerts).where(eq(monitoringAlerts.id, target!.id))
    expect(row?.state).toBe('firing')
    expect(row?.deliveryStatus).toBe('suppressed')
    const audits = await handle.db.select().from(consoleAuditEvents)
    expect(audits.some((event) => event.action === 'monitor.silence' && event.resourceId === target!.id)).toBe(true)
  })

  it('升 firing 使用当前规则渠道，不沿用 pending 空列表', async () => {
    await resetAlerts()
    await resetWorkers()
    await lostWorker()
    await setRules(enableFactory('factory.worker.lost', { forSeconds: 600 }))
    await evaluateAlerts(handle.db)
    const { monitoringAlerts } = schemaFor(handle.db)
    const [pending] = (await handle.db.select().from(monitoringAlerts)).filter(
      (row) => row.ruleId === 'factory.worker.lost',
    )
    expect(pending?.state).toBe('pending')
    expect(pending?.channelIds).toEqual([])

    const channelId = newId()
    const { writeNotificationConfig } = await import('../notifications/config.js')
    const beforeChannel = await getOrCreatePlatformConfig(handle.db)
    await writeNotificationConfig(handle.db, { actorId, expectedRevision: beforeChannel.revision, reason: '登记通知渠道', channel: {
      id: channelId, name: 'hook', kind: 'webhook', enabled: true, secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId: newId() }, host: 'hooks.example.com',
      recipients: [], version: 1, allowAlerts: true, targetIds: [], format: 'legacy_alert@1', replay: 'manual_on_unknown',
    } })
    const current = await getOrCreatePlatformConfig(handle.db)
    await updatePlatformConfig(handle.db, {
      expectedRevision: current.revision,
      reason: 'pending 后绑定渠道',
      document: {
        ...current.document,
        alerting: {
          ...current.document.alerting,
          rules: enableFactory('factory.worker.lost', { forSeconds: 0, channelIds: [channelId] }),
        },
      },
      actor: { id: actorId },
    })
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    const [row] = await handle.db.select().from(monitoringAlerts).where(eq(monitoringAlerts.id, pending!.id))
    expect(row?.state).toBe('firing')
    expect(row?.channelIds).toEqual([channelId])
    const jobs = await claimDueAlertDeliveries(handle.db)
    expect(jobs.find((job) => job.alertId === pending!.id)?.channelIds).toEqual([channelId])
  })

  it('登记实例消失时按 unknown 中断，不遗留 firing', async () => {
    await resetAlerts()
    await resetWorkers()
    const workerId = `skew-${newId().slice(0, 8)}`
    await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const { workers } = schemaFor(handle.db)
    await handle.db
      .update(workers)
      .set({
        processClockSkewMs: 9_000,
        heartbeatExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(workers.id, workerId))
    await setRules(enableFactory('factory.worker.clock_skew'))
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    await handle.db.delete(workers).where(eq(workers.id, workerId))
    expect((await evaluateAlerts(handle.db)).interrupted).toBe(1)
    const active = await listMonitorAlerts(handle.db, { view: 'active', limit: 20 })
    const row = active.items.find((item) => item.ruleId === 'factory.worker.clock_skew')
    expect(row?.state).toBe('interrupted')
    expect(row?.noticeKind).toBe('interrupted')
  })

  it('RMD10 失联闭环：markLostWorkers 触发，恢复后发 resolved', async () => {
    await resetAlerts()
    await resetWorkers()
    await setRules(enableFactory('factory.worker.lost'))
    const workerId = await lostWorker(`loop-${newId().slice(0, 8)}`)
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    const firingJobs = await claimDueAlertDeliveries(handle.db)
    expect(firingJobs.some((job) => job.notice.kind === 'firing' && job.notice.metricKey === 'worker.status.lost')).toBe(
      true,
    )
    expect(JSON.stringify(firingJobs[0]!.notice)).not.toMatch(/https?:\/\/|secret|token|password/i)
    await finishAlertDelivery(handle.db, { alertId: firingJobs[0]!.alertId, status: 'sent' })

    await registerWorker(handle.db, {
      workerId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    expect((await evaluateAlerts(handle.db)).resolved).toBe(1)
    const history = await listMonitorAlerts(handle.db, { view: 'history', limit: 20 })
    expect(history.items.some((item) => item.ruleId === 'factory.worker.lost' && item.state === 'resolved')).toBe(true)
    const resolveJobs = await claimDueAlertDeliveries(handle.db)
    expect(resolveJobs.some((job) => job.notice.kind === 'resolved')).toBe(true)
  })

  it('投递收尾只接受 sending，已 sent 不被 late failed 覆盖', async () => {
    await resetAlerts()
    await resetWorkers()
    await lostWorker()
    await setRules(enableFactory('factory.worker.lost'))
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
    const jobs = await claimDueAlertDeliveries(handle.db)
    const job = jobs.find((item) => item.notice.ruleId === 'factory.worker.lost')
    expect(job).toBeTruthy()
    await finishAlertDelivery(handle.db, { alertId: job!.alertId, status: 'sent' })
    await finishAlertDelivery(handle.db, {
      alertId: job!.alertId,
      status: 'failed',
      errorClass: 'late_overwrite',
    })
    const { monitoringAlerts } = schemaFor(handle.db)
    const [row] = await handle.db.select().from(monitoringAlerts).where(eq(monitoringAlerts.id, job!.alertId))
    expect(row?.deliveryStatus).toBe('sent')
    expect(row?.lastDeliveryError).toBeNull()
    expect(row?.deliveryAttempts).toBe(0)
  })

  it('心跳 stale 只计 READY/DRAINING，时钟偏移按绝对值', async () => {
    await resetAlerts()
    await resetWorkers()
    const stoppedId = `stop-${newId().slice(0, 8)}`
    await registerWorker(handle.db, {
      workerId: stoppedId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    const { workers } = schemaFor(handle.db)
    await handle.db
      .update(workers)
      .set({ status: 'STOPPED', heartbeatExpiresAt: new Date(Date.now() - 5_000) })
      .where(eq(workers.id, stoppedId))
    await setRules(enableFactory('factory.worker.heartbeat_stale', { forSeconds: 0 }))
    expect((await evaluateAlerts(handle.db)).fired).toBe(0)

    const readyId = `live-${newId().slice(0, 8)}`
    await registerWorker(handle.db, {
      workerId: readyId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    await handle.db
      .update(workers)
      .set({ heartbeatExpiresAt: new Date(Date.now() - 5_000) })
      .where(eq(workers.id, readyId))
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)

    await resetAlerts()
    await resetWorkers()
    const skewId = `neg-${newId().slice(0, 8)}`
    await registerWorker(handle.db, {
      workerId: skewId,
      instanceId: newId(),
      capacity: 1,
      maxSessions: 2,
      lostAfterSeconds: 45,
      protocolCapabilities: [SESSION_OCCUPANCY_PROTOCOL],
    })
    await handle.db
      .update(workers)
      .set({
        processClockSkewMs: -9_000,
        heartbeatExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(workers.id, skewId))
    const readings = await collectAlertReadings(handle.db, await clockNow(handle.db))
    expect(readings.get(`metric:worker.clockSkewMs:worker:${skewId}`)).toEqual({
      availability: 'known',
      value: 9_000,
    })
    await setRules(enableFactory('factory.worker.clock_skew', { forSeconds: 0 }))
    expect((await evaluateAlerts(handle.db)).fired).toBe(1)
  })

  it('活动告警按严重度与时间游标翻页', async () => {
    await resetAlerts()
    const { monitoringAlerts } = schemaFor(handle.db)
    const now = await clockNow(handle.db)
    const rows = Array.from({ length: 21 }, (_, index) => {
      const id = newId()
      const at = new Date(now.getTime() - index * 1_000)
      return {
        id,
        ruleId: `page.rule.${index}`,
        ruleName: `规则 ${index}`,
        scope: 'platform' as const,
        scopeId: 'platform',
        state: 'firing' as const,
        severity: index === 0 ? ('critical' as const) : ('warning' as const),
        kind: 'threshold' as const,
        metricKey: 'worker.status.lost',
        conditionOpenedAt: at,
        firedAt: at,
        channelIds: [],
        openKey: `page.rule.${index}/platform/platform`,
        createdAt: now,
        updatedAt: now,
      }
    })
    await handle.db.insert(monitoringAlerts).values(rows)
    const first = await listMonitorAlerts(handle.db, { view: 'active', limit: 20 })
    expect(first.items).toHaveLength(20)
    expect(first.nextCursor).toBeTruthy()
    expect(first.items[0]?.severity).toBe('critical')
    const second = await listMonitorAlerts(handle.db, {
      view: 'active',
      limit: 20,
      cursor: first.nextCursor,
    })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(21)
  })

  it('OCC 失败不落密文', async () => {
    const secretId = newId()
    const current = await getOrCreatePlatformConfig(handle.db)
    await expect(
      upsertAlertChannel(handle.db, {
        expectedRevision: current.revision + 99,
        reason: '冲突登记',
        actor: { id: actorId },
        channel: {
          id: newId(),
          name: '值班',
          kind: 'webhook',
          enabled: true,
          secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId },
          urlHost: 'hooks.example.com',
        },
        secret: { id: secretId, ciphertext: Buffer.from('should-not-land') },
      }),
    ).rejects.toMatchObject({ code: 'PLATFORM_CONFIG_CONFLICT' })
    expect(await loadSecretCiphertext(handle.db, secretId)).toBeNull()
  })
})
