import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import {
  DEFAULT_NOTIFICATION_POLICY,
  LOCAL_SECRET_PROVIDER,
  NOTIFICATION_WORKER_PROTOCOL,
  type NotificationChannel,
} from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import type { DbHandle } from '../client.js'
import { atomic, insertIgnoreRows, schemaFor } from '../native.js'
import { newId } from '../id.js'
import {
  writeNotificationConfig,
  readNotificationPolicy,
  writeNotificationPolicy,
} from '../notifications/config.js'
import {
  createNotificationTest,
  getNotificationEvent,
  listNotificationEvents,
  operateNotificationDelivery,
  getNotificationChannels,
} from '../notifications/query.js'
import {
  claimNotificationDeliveries,
  beginNotificationSubmission,
  finishNotificationDelivery,
} from '../notifications/delivery.js'
import {
  freezeRunNotificationPolicy,
  enqueueRunNotificationIntentTx,
  prepareNotificationEvents,
  repairNotificationIntents,
  enqueueAlertNotificationTx,
} from '../notifications/core.js'
import {
  importLegacyNotificationNotices,
  purgeNotificationHistory,
  reconcileNotificationSuppressions,
} from '../notifications/maintenance.js'
import {
  getOrCreatePlatformConfig,
  updatePlatformConfig,
  restorePlatformConfig,
} from '../platform-config/store.js'
import { createScenarioWithVersion } from '../runs/scenarios.js'
import {
  createRunWithSnapshot,
  requestRunCancel,
  failRunValidation,
  finishRunIfDrained,
  startAttempt,
  finishAttempt,
} from '../runs/runs.js'
import { reviewRun, settleLeaselessRun } from '../runs/recover.js'
import { expireRunDeadlines } from '../runs/deadline.js'
import { forceGrantForRun } from './lease-harness.js'
import { registerWorker } from '../leases/index.js'
import { computeSnapshotDigest } from '../runs/digest.js'

describe.each(DRIVERS)('%s 通知持久化与故障恢复', { timeout: 60_000 }, (driver) => {
  let h: DbHandle,
    t: ReturnType<typeof schemaFor>,
    actor: string,
    outsider: string,
    target: string,
    scenario: string
  let channel: NotificationChannel
  const worker = { workerId: `notify-${newId()}`, instanceId: newId() }
  const action = () => ({ idempotencyKey: newId(), reason: '通知测试验证' })
  beforeAll(async () => {
    h = await openContractDb(driver)
    t = schemaFor(h.db)
    actor = newId()
    outsider = newId()
    target = newId()
    await h.db.insert(t.consoleAccounts).values(
      [actor, outsider].map((id) => ({
        id,
        displayName: '通知测试',
        email: `${id}@example.test`,
        status: 'active' as const,
      })),
    )
    const [admin] = await h.db.select().from(t.consoleRoles).where(eq(t.consoleRoles.key, 'admin'))
    await h.db
      .insert(t.consoleAccountRoles)
      .values({ consoleAccountId: actor, consoleRoleId: admin!.id, targetScopeMode: 'all' })
    for (const permission of [
      'notification:read',
      'notification:operate',
      'monitor:read',
      'monitor:operate',
    ])
      await insertIgnoreRows(h.db, t.consoleRolePermissions, {
        consoleRoleId: admin!.id,
        permission,
      })
    await h.db.insert(t.targets).values({
      id: target,
      code: `nt-${target.slice(0, 8)}`,
      name: '通知目标',
      entryUrl: 'https://example.com',
    })
    scenario = (
      await createScenarioWithVersion(h.db, {
        targetId: target,
        name: '结果通知验证',
        steps: [
          {
            id: newId(),
            name: '回显',
            type: 'echo',
            effectType: 'READ_ONLY',
            input: { value: 'private-data-not-to-send' },
          },
        ],
        actor: { id: actor },
      })
    ).id
    await registerWorker(h.db, {
      ...worker,
      capacity: 1,
      lostAfterSeconds: 3600,
      protocolCapabilities: [NOTIFICATION_WORKER_PROTOCOL],
    })
    await getOrCreatePlatformConfig(h.db)
  })
  afterAll(async () => {
    await h?.close()
  })
  beforeEach(async () => {
    await h.db.delete(t.notificationDeliveryAttempts)
    await h.db.delete(t.notificationDeliveries)
    await h.db.delete(t.notificationEvents)
    await h.db.delete(t.notificationCommands)
    await h.db.delete(t.scenarioNotificationPolicies)
    await h.db.delete(t.monitoringAlerts)
    await h.db
      .delete(t.consoleAccountRoles)
      .where(eq(t.consoleAccountRoles.consoleAccountId, outsider))
    channel = {
      id: newId(),
      name: '接收端',
      kind: 'webhook',
      enabled: true,
      allowAlerts: true,
      targetIds: [target],
      version: 1,
      secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId: newId() },
      host: 'hooks.example.com',
      recipients: [],
      format: 'cairn.notification@1',
      replay: 'manual_on_unknown',
    }
    // A fresh config for each case, always using the real OCC/domain path.
    const current = await getOrCreatePlatformConfig(h.db)
    await updatePlatformConfig(h.db, {
      expectedRevision: current.revision,
      document: {
        ...current.document,
        alerting: {
          ...current.document.alerting,
          rules: current.document.alerting.rules.map((r) => ({ ...r, channelIds: [] })),
        },
        notifications: { ...current.document.notifications, channels: [] },
      },
      actor: { id: actor },
      reason: '清理隔离测试配置',
    })
    await write({ channel })
    await write({ settings: { enabled: true, consoleBaseUrl: 'https://console.example.com' } })
  })
  async function write(
    extra: Omit<
      Parameters<typeof writeNotificationConfig>[1],
      'actorId' | 'expectedRevision' | 'reason'
    >,
  ) {
    const c = await getOrCreatePlatformConfig(h.db)
    return writeNotificationConfig(h.db, {
      actorId: actor,
      expectedRevision: c.revision,
      reason: '通知测试配置',
      ...extra,
    })
  }
  async function testMessage() {
    return createNotificationTest(h.db, actor, channel.id, action())
  }
  async function oneJob() {
    const jobs = await claimNotificationDeliveries(h.db, worker)
    expect(jobs).toHaveLength(1)
    return jobs[0]!
  }
  async function makeRun(mode: 'all_finished' | 'exceptions' = 'all_finished', deadlineAt?: Date) {
    await writeNotificationPolicy(h.db, scenario, actor, {
      expectedRevision: 0,
      reason: '订阅测试',
      policy: { ...DEFAULT_NOTIFICATION_POLICY, enabled: true, mode, channelIds: [channel.id] },
    })
    return (
      await createRunWithSnapshot(h.db, { scenarioId: scenario, actor: { id: actor }, deadlineAt })
    ).detail
  }
  it('默认关闭、目的地授权、策略 OCC、快照摘要和冻结版本', async () => {
    expect((await readNotificationPolicy(h.db, scenario, actor)).policy.enabled).toBe(false)
    await expect(readNotificationPolicy(h.db, scenario, outsider)).rejects.toMatchObject({
      kind: 'not_found',
    })
    const run = await makeRun()
    expect(run.snapshot.notificationPolicy?.bindings[0]?.channel.version).toBe(1)
    expect(computeSnapshotDigest(run.snapshot)).toBe(run.snapshot.digest)
    expect(
      computeSnapshotDigest({
        ...run.snapshot,
        notificationPolicy: {
          ...run.snapshot.notificationPolicy!,
          policy: { ...run.snapshot.notificationPolicy!.policy, mode: 'exceptions' },
        },
      }),
    ).not.toBe(run.snapshot.digest)
    const changed = {
      ...channel,
      version: 2,
      host: 'next.example.com',
      secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId: newId() },
    }
    await write({ channel: changed })
    expect(run.snapshot.notificationPolicy?.bindings[0]?.channel.host).toBe('hooks.example.com')
    await expect(
      writeNotificationPolicy(h.db, scenario, actor, {
        expectedRevision: 0,
        reason: '旧修订',
        policy: DEFAULT_NOTIFICATION_POLICY,
      }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_POLICY_CONFLICT' })
  })
  it('真实取消终态同事务产生唯一意图，补扫不会重复', async () => {
    const run = await makeRun()
    await requestRunCancel(h.db, run.id, { id: actor })
    const [stored] = await h.db.select().from(t.runs).where(eq(t.runs.id, run.id))
    expect(stored?.status).toBe('CANCELLED')
    await repairNotificationIntents(h.db)
    await repairNotificationIntents(h.db)
    const rows = await h.db
      .select()
      .from(t.notificationEvents)
      .where(eq(t.notificationEvents.runId, run.id))
    expect(rows).toHaveLength(1)
    await prepareNotificationEvents(h.db, { now: new Date(Date.now() + 61_000) })
    const event = await getNotificationEvent(h.db, actor, rows[0]!.id)
    expect(event.payload?.status).toBe('CANCELLED')
    expect(event.deliveries).toHaveLength(1)
    expect(JSON.stringify(event)).not.toContain('private-data-not-to-send')
  })
  it('源写入与意图写入一同回滚；持久化缺失意图可以修复', async () => {
    const run = await makeRun()
    await expect(
      atomic(h.db, async (tx) => {
        await tx
          .update(t.runs)
          .set({ status: 'FAILED', finishedAt: new Date() })
          .where(eq(t.runs.id, run.id))
        await enqueueRunNotificationIntentTx(tx, run.id)
        throw new Error('injected-crash')
      }),
    ).rejects.toThrow('injected-crash')
    expect((await h.db.select().from(t.runs).where(eq(t.runs.id, run.id)))[0]?.status).toBe(
      'QUEUED',
    )
    expect(
      await h.db.select().from(t.notificationEvents).where(eq(t.notificationEvents.runId, run.id)),
    ).toHaveLength(0)
    await h.db
      .update(t.runs)
      .set({ status: 'FAILED', finishedAt: new Date() })
      .where(eq(t.runs.id, run.id))
    await repairNotificationIntents(h.db)
    expect(
      await h.db.select().from(t.notificationEvents).where(eq(t.notificationEvents.runId, run.id)),
    ).toHaveLength(1)
  })
  it('证据等待 60 秒只冻结一次；不把 NOT_EVALUATED 当业务通过', async () => {
    const run = await makeRun(),
      finished = new Date()
    await atomic(h.db, async (tx) => {
      await tx
        .update(t.runs)
        .set({ status: 'SUCCEEDED', finishedAt: finished, evidenceStatus: 'PENDING' })
        .where(eq(t.runs.id, run.id))
      await enqueueRunNotificationIntentTx(tx, run.id)
    })
    const [event] = await h.db
      .select()
      .from(t.notificationEvents)
      .where(eq(t.notificationEvents.runId, run.id))
    await prepareNotificationEvents(h.db, { now: new Date(finished.getTime() + 59_000) })
    expect((await getNotificationEvent(h.db, actor, event!.id)).state).toBe('waiting_result')
    await prepareNotificationEvents(h.db, { now: new Date(finished.getTime() + 60_000) })
    const before = await getNotificationEvent(h.db, actor, event!.id)
    expect(before.payload).toMatchObject({
      summaryStage: 'evidence_pending',
      evidenceStatus: 'PENDING',
      outcomeStatus: 'NOT_EVALUATED',
    })
    await h.db.update(t.runs).set({ evidenceStatus: 'COMPLETE' }).where(eq(t.runs.id, run.id))
    await prepareNotificationEvents(h.db)
    expect((await getNotificationEvent(h.db, actor, event!.id)).payload).toEqual(before.payload)
  })
  it('暂停再启用不复活尚在执行的 Run；策略取消历史也覆盖尚无事件', async () => {
    const run = await makeRun()
    await write({ settings: { enabled: false, consoleBaseUrl: 'https://console.example.com' } })
    await write({ settings: { enabled: true, consoleBaseUrl: 'https://console.example.com' } })
    await requestRunCancel(h.db, run.id, { id: actor })
    await prepareNotificationEvents(h.db, { now: new Date(Date.now() + 61_000) })
    const rows = await listNotificationEvents(h.db, actor, { runId: run.id })
    expect(rows.items[0]?.state).toBe('suppressed')
    expect(await claimNotificationDeliveries(h.db, worker)).toHaveLength(0)
  })
  it('并发领取唯一所有者；旧代不可提交也不可完成', async () => {
    await testMessage()
    const groups = await Promise.all([
      claimNotificationDeliveries(h.db, worker),
      claimNotificationDeliveries(h.db, worker),
    ])
    expect(groups.flat()).toHaveLength(1)
    const job = groups.flat()[0]!
    expect(await beginNotificationSubmission(h.db, { ...job, epoch: job.epoch + 1 })).toBe(false)
    expect(await beginNotificationSubmission(h.db, job)).toBe(true)
    expect(await beginNotificationSubmission(h.db, job)).toBe(false)
    expect(
      await finishNotificationDelivery(
        h.db,
        { ...job, instanceId: newId() },
        { outcome: 'accepted' },
      ),
    ).toBe(false)
    expect(await finishNotificationDelivery(h.db, job, { outcome: 'accepted' })).toBe(true)
  })
  it('失联前未提交可重新领取；已提交转 unknown 而不重发', async () => {
    const { eventId } = await testMessage(),
      first = await oneJob()
    await h.db
      .update(t.notificationDeliveries)
      .set({ claimExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(t.notificationDeliveries.id, first.deliveryId))
    const second = await oneJob()
    expect(second.epoch).toBe(first.epoch + 1)
    expect(await finishNotificationDelivery(h.db, first, { outcome: 'accepted' })).toBe(false)
    await beginNotificationSubmission(h.db, second)
    await h.db
      .update(t.notificationDeliveries)
      .set({ claimExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(t.notificationDeliveries.id, second.deliveryId))
    expect(await claimNotificationDeliveries(h.db, worker)).toEqual([])
    expect((await getNotificationEvent(h.db, actor, eventId)).deliveries[0]?.status).toBe('unknown')
  })
  it('五次自动预算与单次人工许可独立，幂等不重复授予', async () => {
    const { eventId } = await testMessage()
    for (let attempt = 1; attempt <= 5; attempt++) {
      const job = await oneJob()
      expect(job.delivery.automaticAttemptCount).toBe(attempt)
      await finishNotificationDelivery(h.db, job, {
        outcome: 'retryable',
        errorCode: 'connection_refused',
      })
      await h.db
        .update(t.notificationDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() - 1) })
        .where(eq(t.notificationDeliveries.id, job.deliveryId))
    }
    const delivery = (await getNotificationEvent(h.db, actor, eventId)).deliveries[0]!
    expect(delivery.status).toBe('failed')
    expect(await claimNotificationDeliveries(h.db, worker)).toEqual([])
    const cmd = action()
    await operateNotificationDelivery(h.db, actor, delivery.id, 'retry', cmd)
    await operateNotificationDelivery(h.db, actor, delivery.id, 'retry', cmd)
    const job = await oneJob()
    expect(job.delivery.automaticAttemptCount).toBe(5)
    expect(job.delivery.attemptNo).toBe(6)
    await finishNotificationDelivery(h.db, job, { outcome: 'retryable' })
    expect((await getNotificationEvent(h.db, actor, eventId)).deliveries[0]?.status).toBe('failed')
    expect(await claimNotificationDeliveries(h.db, worker)).toEqual([])
  })
  it('unknown 需确认重复风险；可以结案且不重发', async () => {
    const { eventId } = await testMessage(),
      job = await oneJob()
    await beginNotificationSubmission(h.db, job)
    await finishNotificationDelivery(h.db, job, { outcome: 'unknown' })
    await expect(
      operateNotificationDelivery(h.db, actor, job.deliveryId, 'retry', action()),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_UNKNOWN_CONFIRMATION' })
    await operateNotificationDelivery(h.db, actor, job.deliveryId, 'close', action())
    expect((await getNotificationEvent(h.db, actor, eventId)).deliveries[0]).toMatchObject({
      status: 'unknown',
      closedAt: expect.any(String),
    })
    expect(await claimNotificationDeliveries(h.db, worker)).toEqual([])
  })
  it('撤销版本阻止已领取但未提交；配置回退不能复活撤销版本', async () => {
    const current = await getOrCreatePlatformConfig(h.db)
    await testMessage()
    const job = await oneJob()
    await write({ state: { id: channel.id, revokeVersion: 1 } })
    expect(await beginNotificationSubmission(h.db, job)).toBe(false)
    const latest = await getOrCreatePlatformConfig(h.db)
    await expect(
      restorePlatformConfig(h.db, {
        revision: current.revision,
        expectedRevision: latest.revision,
        reason: '回退验证',
        actor: { id: actor },
      }),
    ).rejects.toMatchObject({ code: 'NOTIFICATION_VERSION_REVOKED' })
  })
  it('测试幂等与持久化限流，越权列表/详情/重试均拒绝', async () => {
    const cmd = action(),
      first = await createNotificationTest(h.db, actor, channel.id, cmd)
    expect(await createNotificationTest(h.db, actor, channel.id, cmd)).toEqual(first)
    await expect(testMessage()).rejects.toMatchObject({ code: 'NOTIFICATION_RATE_LIMITED' })
    await expect(listNotificationEvents(h.db, outsider)).rejects.toMatchObject({
      kind: 'forbidden',
    })
    await expect(getNotificationEvent(h.db, outsider, first.eventId)).rejects.toMatchObject({
      kind: 'forbidden',
    })
    await expect(
      createNotificationTest(h.db, outsider, channel.id, action()),
    ).rejects.toMatchObject({ kind: 'forbidden' })
    expect(JSON.stringify(await getNotificationChannels(h.db, actor))).not.toContain('secretRef')
  })
  it('邮箱独立投递，已接受地址不因另一地址失败而重发', async () => {
    const smtp = {
      enabled: true,
      version: 1,
      host: 'smtp.example.com',
      secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId: newId() },
    }
    await write({ smtp })
    channel = {
      ...channel,
      version: 2,
      kind: 'email',
      host: '',
      recipients: [
        { id: newId(), masked: 'a***@example.com' },
        { id: newId(), masked: 'b***@example.com' },
      ],
    }
    await write({ channel })
    const { eventId } = await testMessage()
    const jobs = await claimNotificationDeliveries(h.db, worker)
    expect(jobs).toHaveLength(2)
    await finishNotificationDelivery(h.db, jobs[0]!, { outcome: 'accepted' })
    await finishNotificationDelivery(h.db, jobs[1]!, { outcome: 'failed' })
    await operateNotificationDelivery(h.db, actor, jobs[1]!.deliveryId, 'retry', action())
    const retry = await oneJob()
    expect(retry.deliveryId).toBe(jobs[1]!.deliveryId)
    const event = await getNotificationEvent(h.db, actor, eventId)
    expect(event.deliveries.filter((d) => d.status === 'accepted')).toHaveLength(1)
  })
  it('30 天清理保留去重墓碑；未结案 unknown 保留正文', async () => {
    const { eventId } = await testMessage(),
      job = await oneJob()
    await finishNotificationDelivery(h.db, job, { outcome: 'unknown' })
    const future = new Date(Date.now() + 31 * 86400_000)
    await purgeNotificationHistory(h.db, { now: future })
    expect((await getNotificationEvent(h.db, actor, eventId)).payload).not.toBeNull()
    await operateNotificationDelivery(h.db, actor, job.deliveryId, 'close', action())
    await purgeNotificationHistory(h.db, { now: future })
    expect((await getNotificationEvent(h.db, actor, eventId)).payload).toBeNull()
    expect(
      await h.db.select().from(t.notificationEvents).where(eq(t.notificationEvents.id, eventId)),
    ).toHaveLength(1)
    expect(await claimNotificationDeliveries(h.db, worker)).toEqual([])
  })
  it.each([
    'last_step',
    'drained',
    'validation',
    'review_fail',
    'review_cancel',
    'deadline',
    'auth_deadline',
    'recovery',
  ] as const)('真实终态路径 %s 唯一意图；中间状态无通知', async (path) => {
    const run = await makeRun(
      'all_finished',
      path === 'deadline' || path === 'auth_deadline' ? new Date(Date.now() - 1000) : undefined,
    )
    const events = () =>
      h.db.select().from(t.notificationEvents).where(eq(t.notificationEvents.runId, run.id))
    expect(await events()).toHaveLength(0)
    if (path === 'last_step' || path === 'drained') {
      const grant = await forceGrantForRun(h, run.id, worker.workerId)
      if (path === 'last_step') {
        const attempt = await startAttempt(h.db, {
          runId: run.id,
          stepRunId: run.stepRuns[0]!.id,
          inputPayload: {},
          grant,
        })
        await finishAttempt(h.db, {
          runId: run.id,
          attemptId: attempt!.attemptId,
          attemptStatus: 'SUCCEEDED',
          stepRunStatus: 'SUCCEEDED',
          runStatus: 'SUCCEEDED',
          output: { value: 'safe' },
          grant,
        })
      } else {
        await h.db
          .update(t.stepRuns)
          .set({ status: 'SUCCEEDED', finishedAt: new Date() })
          .where(eq(t.stepRuns.runId, run.id))
        expect(await finishRunIfDrained(h.db, grant)).toEqual({ finished: true })
      }
    } else if (path === 'validation') await failRunValidation(h.db, run.id, { recover: true })
    else if (path === 'deadline' || path === 'auth_deadline') {
      if (path === 'auth_deadline')
        await h.db.update(t.runs).set({ status: 'WAITING_FOR_AUTH' }).where(eq(t.runs.id, run.id))
      await expireRunDeadlines(h.db, run.id)
    } else {
      if (path === 'recovery') {
        await h.db.update(t.runs).set({ status: 'RUNNING' }).where(eq(t.runs.id, run.id))
        await settleLeaselessRun(h.db, { runId: run.id, maxRecoveries: 0 })
      } else
        await failRunValidation(h.db, run.id, { recover: true }, undefined, {
          runStatus: 'NEEDS_REVIEW',
        })
      expect(await events()).toHaveLength(0)
      await reviewRun(h.db, {
        runId: run.id,
        actor: { id: actor },
        conclusion: path === 'review_cancel' ? 'cancel' : 'fail',
      })
    }
    expect(await events()).toHaveLength(1)
    await repairNotificationIntents(h.db)
    expect(await events()).toHaveLength(1)
  })
  it('取消旧订阅覆盖仍在运行的快照，服务来源与内部来源显式排除', async () => {
    const run = await makeRun()
    const policy = await readNotificationPolicy(h.db, scenario, actor)
    await writeNotificationPolicy(h.db, scenario, actor, {
      expectedRevision: policy.revision,
      policy: policy.policy,
      cancelPrevious: true,
      reason: '取消历史发送',
    })
    await requestRunCancel(h.db, run.id, { id: actor })
    await prepareNotificationEvents(h.db, { now: new Date(Date.now() + 61_000) })
    expect((await listNotificationEvents(h.db, actor, { runId: run.id })).items[0]?.state).toBe(
      'suppressed',
    )
    const base = {
      scenarioId: scenario,
      targetId: target,
      scenarioName: '场景',
      targetName: '目标',
    }
    expect(
      (
        await atomic(h.db, (tx) =>
          freezeRunNotificationPolicy(tx, { ...base, eligible: true, source: 'service' }),
        )
      ).enabled,
    ).toBe(false)
    expect(
      (
        await atomic(h.db, (tx) =>
          freezeRunNotificationPolicy(tx, { ...base, eligible: false, source: 'console' }),
        )
      ).enabled,
    ).toBe(false)
    await writeNotificationPolicy(h.db, scenario, actor, {
      expectedRevision: policy.revision + 1,
      policy: { ...policy.policy, sourceKinds: ['service'] },
      reason: '开放服务订阅',
    })
    expect(
      (
        await atomic(h.db, (tx) =>
          freezeRunNotificationPolicy(tx, { ...base, eligible: true, source: 'service' }),
        )
      ).enabled,
    ).toBe(true)
  })
  it('SMTP 版本撤销阻止已领取邮件，重启开关和回退均不能复活', async () => {
    await write({
      smtp: {
        enabled: true,
        version: 1,
        host: 'smtp.example.com',
        secretRef: { provider: LOCAL_SECRET_PROVIDER, secretId: newId() },
      },
    })
    channel = {
      ...channel,
      version: 2,
      kind: 'email',
      host: '',
      recipients: [{ id: newId(), masked: 'a***@example.test' }],
    }
    await write({ channel })
    const saved = await getOrCreatePlatformConfig(h.db)
    await testMessage()
    const job = await oneJob()
    await write({ smtpState: { revokeVersion: saved.document.notifications.smtp!.version } })
    expect(await beginNotificationSubmission(h.db, job)).toBe(false)
    expect((await getNotificationChannels(h.db, actor)).smtp?.revoked).toBe(true)
    await write({ smtpState: { enabled: false } })
    await expect(write({ smtpState: { enabled: true } })).rejects.toMatchObject({
      code: 'NOTIFICATION_VERSION_REVOKED',
    })
  })
  it('投递前撤销 Target 或删除源，列表筛选与实际提交一致', async () => {
    const run = await makeRun()
    await requestRunCancel(h.db, run.id, { id: actor })
    await prepareNotificationEvents(h.db, { now: new Date(Date.now() + 61_000) })
    await write({ channel: { ...channel, version: 2, targetIds: [] } })
    const rows = await listNotificationEvents(h.db, actor, { runId: run.id, status: 'suppressed' })
    expect(rows.items).toHaveLength(1)
    await reconcileNotificationSuppressions(h.db)
    expect(await claimNotificationDeliveries(h.db, worker)).toEqual([])
  })
  it('跨 Target 列表、详情、渠道、重试及游标在撤权后拒绝', async () => {
    const role = newId()
    await h.db
      .insert(t.consoleRoles)
      .values({ id: role, key: `notify-${role}`, name: '局部通知操作员' })
    await h.db
      .insert(t.consoleRolePermissions)
      .values(
        [
          'notification:read',
          'notification:operate',
          'run:read',
          'target:read',
          'workflow:read',
        ].map((permission) => ({ consoleRoleId: role, permission })),
      )
    await h.db.insert(t.consoleAccountRoles).values({
      consoleAccountId: outsider,
      consoleRoleId: role,
      targetScopeMode: 'selected',
      targetScopeIds: [target],
    })
    const first = await makeRun(),
      second = (await createRunWithSnapshot(h.db, { scenarioId: scenario, actor: { id: actor } }))
        .detail
    for (const run of [first, second]) await requestRunCancel(h.db, run.id, { id: actor })
    await prepareNotificationEvents(h.db, { now: new Date(Date.now() + 61_000) })
    const page = await listNotificationEvents(h.db, outsider, { type: 'run', limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBeTruthy()
    const channels = await getNotificationChannels(h.db, outsider, target)
    expect(channels.channels).toHaveLength(1)
    expect(channels.smtp).toBeNull()
    expect(JSON.stringify(channels)).not.toContain('secretRef')
    await h.db
      .update(t.consoleAccountRoles)
      .set({ targetScopeMode: 'none', targetScopeIds: [] })
      .where(
        and(
          eq(t.consoleAccountRoles.consoleAccountId, outsider),
          eq(t.consoleAccountRoles.consoleRoleId, role),
        ),
      )
    expect((await listNotificationEvents(h.db, outsider)).items).toEqual([])
    await expect(getNotificationEvent(h.db, outsider, page.items[0]!.id)).rejects.toMatchObject({
      kind: 'not_found',
    })
    await expect(
      listNotificationEvents(h.db, outsider, { type: 'run', limit: 1, cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(
      operateNotificationDelivery(
        h.db,
        outsider,
        page.items[0]!.deliveries[0]!.id,
        'retry',
        action(),
      ),
    ).rejects.toMatchObject({ kind: 'not_found' })
  })
  it('旧投递 pending / sending / failed / sent 分类迁移幂等，未知禁止重发', async () => {
    const ids: Record<string, string> = {}
    for (const status of ['pending', 'sending', 'failed', 'sent'] as const) {
      const id = (ids[status] = newId())
      await h.db.insert(t.monitoringAlerts).values({
        id,
        ruleId: 'fixture',
        ruleName: '旧告警',
        scope: 'platform',
        scopeId: 'platform',
        state: 'firing',
        severity: 'warning',
        kind: 'threshold',
        metricKey: 'worker.status.lost',
        comparator: 'gt',
        threshold: 0,
        triggerValue: 1,
        conditionOpenedAt: new Date(),
        firedAt: new Date(),
        channelIds: [channel.id],
        deliveryKind: 'firing',
        deliveryStatus: status,
        deliveryAttempts: status === 'pending' ? 0 : 1,
      })
    }
    await importLegacyNotificationNotices(h.db)
    await importLegacyNotificationNotices(h.db)
    const rows = await listNotificationEvents(h.db, actor, { type: 'alert' })
    expect(rows.items).toHaveLength(3)
    expect(rows.items.find((e) => e.alertId === ids.pending)?.deliveries[0]?.status).toBe('pending')
    for (const status of ['sending', 'failed']) {
      const delivery = rows.items.find((e) => e.alertId === ids[status])!.deliveries[0]!
      expect(delivery.status).toBe('unknown')
      await expect(
        operateNotificationDelivery(h.db, actor, delivery.id, 'retry', {
          ...action(),
          confirmUnknown: true,
        }),
      ).rejects.toMatchObject({ code: 'NOTIFICATION_LEGACY_UNKNOWN' })
    }
    await atomic(h.db, (tx) => enqueueAlertNotificationTx(tx, ids.pending!, 'interrupted'))
    await atomic(h.db, (tx) => enqueueAlertNotificationTx(tx, ids.pending!, 'resolved'))
    expect((await listNotificationEvents(h.db, actor, { type: 'alert' })).items).toHaveLength(5)
    const first = await oneJob()
    expect(first.event.type).toBe('alert.firing')
    await beginNotificationSubmission(h.db, first)
    await finishNotificationDelivery(h.db, first, { outcome: 'accepted' })
    expect((await oneJob()).event.type).toBe('alert.interrupted')
  })
  it('存活旧 Worker 阻止开放外发，停机后允许启用', async () => {
    await testMessage()
    const job = await oneJob()
    await write({ settings: { enabled: false, consoleBaseUrl: 'https://console.example.com' } })
    const old = { workerId: newId(), instanceId: newId() }
    await registerWorker(h.db, {
      ...old,
      capacity: 1,
      lostAfterSeconds: 3600,
      protocolCapabilities: [],
    })
    try {
      await expect(claimNotificationDeliveries(h.db, worker)).rejects.toMatchObject({
        code: 'NOTIFICATION_ROLLOUT_REQUIRED',
      })
      await expect(beginNotificationSubmission(h.db, job)).rejects.toMatchObject({
        code: 'NOTIFICATION_ROLLOUT_REQUIRED',
      })
      await expect(importLegacyNotificationNotices(h.db)).rejects.toMatchObject({
        code: 'NOTIFICATION_ROLLOUT_REQUIRED',
      })
      await expect(
        write({ settings: { enabled: true, consoleBaseUrl: 'https://console.example.com' } }),
      ).rejects.toMatchObject({ kind: 'conflict' })
    } finally {
      await h.db.update(t.workers).set({ status: 'STOPPED' }).where(eq(t.workers.id, old.workerId))
    }
    await write({ settings: { enabled: true, consoleBaseUrl: 'https://console.example.com' } })
  })
})
