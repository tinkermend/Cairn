import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Step } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  appendRunEvents,
  atomic,
  createChangeHint,
  createRunWithSnapshot,
  createScenarioWithVersion,
  diagnoseRunEventCursor,
  failRunValidation,
  listRunEventsAfter,
  loadRunObservation,
  purgeExpiredRunEvents,
  requestRunCancel,
  resetChangeHintPublisher,
  reviewRun,
  schemaFor,
  setChangeHintPublisher,
} from '../test-entry.js'
import { newId } from '../id.js'

const echoStep: Step = {
  id: '00000000-0000-4000-8000-000000000061',
  name: '回显',
  type: 'echo',
  effectType: 'READ_ONLY',
  outputKey: 'greeting',
  input: { value: 'hello' },
}

describe.each(DRIVERS)('%s 运行观察账本', { timeout: 30_000 }, (driver) => {
  let handle: Awaited<ReturnType<typeof openContractDb>>
  let actorId: string
  let targetId: string

  beforeAll(async () => {
    handle = await openContractDb(driver, `observe_${driver}`)
    actorId = newId()
    targetId = newId()
    const { consoleAccounts, targets } = schemaFor(handle.db)
    await handle.db.insert(consoleAccounts).values({
      id: actorId,
      displayName: 'observer',
      email: `observe-${actorId}@example.com`,
      status: 'active',
    })
    await handle.db.insert(targets).values({
      id: targetId,
      code: `obs-${driver}-${actorId.slice(0, 8)}`,
      name: '观察夹具',
      entryUrl: 'https://example.com',
    })
  })

  afterEach(() => {
    resetChangeHintPublisher()
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function seedRun() {
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `观察 ${newId()}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    return createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      actor: { id: actorId },
    })
  }

  it('提交后同时有状态与事件，观察结果与高水位一致', async () => {
    const created = await seedRun()
    expect(created.created).toBe(true)
    const events = await listRunEventsAfter(handle.db, created.detail.id, 0, 20)
    expect(events.map((item: { type: string }) => item.type)).toEqual(['run.created'])
    expect(events[0]?.sequence).toBe(1)
    const observation = await loadRunObservation(handle.db, created.detail.id)
    expect(observation?.eventSeq).toBe(1)
    expect(observation?.earliestEventSeq).toBe(1)
    expect(observation?.run.status).toBe('QUEUED')
    expect(observation?.run.id).toBe(created.detail.id)
  })

  it('幂等命中不追加事件', async () => {
    const key = `idem-${newId()}`
    const scenario = await createScenarioWithVersion(handle.db, {
      targetId,
      name: `幂等 ${key.slice(-8)}`,
      steps: [echoStep],
      actor: { id: actorId },
    })
    const first = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      idempotencyKey: key,
      actor: { id: actorId },
    })
    const again = await createRunWithSnapshot(handle.db, {
      scenarioId: scenario.id,
      idempotencyKey: key,
      actor: { id: actorId },
    })
    expect(again.created).toBe(false)
    const events = await listRunEventsAfter(handle.db, first.detail.id, 0, 20)
    expect(events).toHaveLength(1)
  })

  it('取消与校验失败写入账本，批量跳过不逐条产事件', async () => {
    const created = await seedRun()
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    const afterCancel = await listRunEventsAfter(handle.db, created.detail.id, 0, 20)
    expect(afterCancel.map((item) => item.type)).toContain('run.cancel_requested')
    const cancelled = await loadRunObservation(handle.db, created.detail.id)
    expect(cancelled?.run.cancelRequested).toBe(true)
    expect(cancelled?.eventSeq).toBe(afterCancel.at(-1)?.sequence)

    const failed = await seedRun()
    await failRunValidation(handle.db, failed.detail.id, { recover: true })
    const failEvents = await listRunEventsAfter(handle.db, failed.detail.id, 0, 20)
    expect(failEvents.map((item) => item.type)).toEqual([
      'run.created',
      'run.status_changed',
      'evidence.recorded',
    ])
    expect(failEvents.some((item) => item.type.startsWith('step_run.'))).toBe(false)
    const observation = await loadRunObservation(handle.db, failed.detail.id)
    expect(observation?.run.status).toBe('FAILED')
    expect(observation?.evidence.items.some((item) => item.type === 'error')).toBe(true)
    expect(observation?.eventSeq).toBe(3)
  })

  it('写入前校验闭合事件类型', async () => {
    const created = await seedRun()
    await expect(
      atomic(handle.db, async (tx) => {
        await appendRunEvents(tx, created.detail.id, [
          { type: 'run.updated' as never, payload: { status: 'RUNNING' } },
        ])
      }),
    ).rejects.toThrow()
    expect(await listRunEventsAfter(handle.db, created.detail.id, 0, 20)).toHaveLength(1)
  })

  it('嵌套 savepoint 回滚不发布内层提示，外层事件仍提交', async () => {
    const created = await seedRun()
    const published: number[] = []
    setChangeHintPublisher((hint) => {
      published.push(hint.eventSeq)
    })
    await handle.db.transaction(async (tx) => {
      await appendRunEvents(tx, created.detail.id, [
        { type: 'run.status_changed', payload: { status: 'RUNNING' } },
      ])
      await expect(
        tx.transaction(async (inner) => {
          await appendRunEvents(inner, created.detail.id, [
            { type: 'run.status_changed', payload: { status: 'FAILED' } },
          ])
          throw new Error('inner-rollback')
        }),
      ).rejects.toThrow('inner-rollback')
    })
    const events = await listRunEventsAfter(handle.db, created.detail.id, 0, 20)
    expect(events.map((item) => item.type)).toEqual(['run.created', 'run.status_changed'])
    expect(events.at(-1)?.payload).toMatchObject({ status: 'RUNNING' })
    expect(published.at(-1)).toBe(events.at(-1)?.sequence)
    expect(published.filter((seq) => seq > (events.at(-1)?.sequence ?? 0))).toEqual([])
  })

  it('核查结论写入 run.status_changed', async () => {
    const created = await seedRun()
    const { runs } = schemaFor(handle.db)
    await handle.db.update(runs).set({ status: 'NEEDS_REVIEW' }).where(eq(runs.id, created.detail.id))
    await reviewRun(handle.db, {
      runId: created.detail.id,
      actor: { id: actorId },
      conclusion: 'fail',
    })
    const events = await listRunEventsAfter(handle.db, created.detail.id, 0, 20)
    expect(
      events.some(
        (item) => item.type === 'run.status_changed' && (item.payload as { status?: string }).status === 'FAILED',
      ),
    ).toBe(true)
    const observation = await loadRunObservation(handle.db, created.detail.id)
    expect(observation?.run.status).toBe('FAILED')
    expect(observation?.eventSeq).toBe(events.at(-1)?.sequence)
  })

  it('回滚不留事件也不发提示', async () => {
    const created = await seedRun()
    const published: Array<{ runId: string; eventSeq: number }> = []
    setChangeHintPublisher((hint) => {
      published.push(hint)
    })
    await expect(
      atomic(handle.db, async (tx) => {
        await appendRunEvents(tx, created.detail.id, [
          { type: 'run.status_changed', payload: { status: 'RUNNING' } },
        ])
        throw new Error('rollback-observe')
      }),
    ).rejects.toThrow('rollback-observe')
    const events = await listRunEventsAfter(handle.db, created.detail.id, 0, 20)
    expect(events).toHaveLength(1)
    const observation = await loadRunObservation(handle.db, created.detail.id)
    expect(observation?.eventSeq).toBe(1)
    expect(published).toEqual([])
  })

  it('提交后才发布变化提示，序号唯一', async () => {
    const published: number[] = []
    setChangeHintPublisher((hint) => {
      published.push(hint.eventSeq)
    })
    const created = await seedRun()
    await requestRunCancel(handle.db, created.detail.id, { id: actorId })
    const events = await listRunEventsAfter(handle.db, created.detail.id, 0, 20)
    const sequences = events.map((item) => item.sequence)
    expect(new Set(sequences).size).toBe(sequences.length)
    expect(published.at(-1)).toBe(events.at(-1)?.sequence)
  })

  it('进行中的 Run 不会被保留清理删事件', async () => {
    const created = await seedRun()
    const { runEvents } = schemaFor(handle.db)
    await handle.db
      .update(runEvents)
      .set({ occurredAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(runEvents.runId, created.detail.id))
    expect(await purgeExpiredRunEvents(handle.db, 7)).toBe(0)
    expect(await listRunEventsAfter(handle.db, created.detail.id, 0, 20)).toHaveLength(1)
  })

  it('已终态且证据非 PENDING 的过期前缀可删，高水位保留', async () => {
    const created = await seedRun()
    const { runEvents, runs } = schemaFor(handle.db)
    await handle.db
      .update(runs)
      .set({ status: 'SUCCEEDED', evidenceStatus: 'COMPLETE' })
      .where(eq(runs.id, created.detail.id))
    await handle.db
      .update(runEvents)
      .set({ occurredAt: new Date('2000-01-01T00:00:00.000Z') })
      .where(eq(runEvents.runId, created.detail.id))
    expect(await purgeExpiredRunEvents(handle.db, 7)).toBe(1)
    expect(await listRunEventsAfter(handle.db, created.detail.id, 0, 20)).toHaveLength(0)
    const observation = await loadRunObservation(handle.db, created.detail.id)
    expect(observation?.eventSeq).toBe(1)
    expect(observation?.earliestEventSeq).toBe(0)
  })

  it('游标诊断区分格式、错 Run、过期与超前', () => {
    const runId = '66666666-6666-4666-8666-666666666666'
    expect(diagnoseRunEventCursor({ runId, eventSeq: 3, earliestEventSeq: 1 })).toEqual({
      ok: true,
      after: 0,
    })
    expect(
      diagnoseRunEventCursor({
        runId,
        lastEventId: 'bad',
        eventSeq: 3,
        earliestEventSeq: 1,
      }),
    ).toEqual({ ok: false, reason: 'cursor_invalid' })
    expect(
      diagnoseRunEventCursor({
        runId,
        lastEventId: `77777777-7777-4777-8777-777777777777:1`,
        eventSeq: 3,
        earliestEventSeq: 1,
      }),
    ).toEqual({ ok: false, reason: 'cursor_run_mismatch' })
    expect(
      diagnoseRunEventCursor({
        runId,
        lastEventId: `${runId}:0`,
        eventSeq: 9,
        earliestEventSeq: 4,
      }),
    ).toEqual({ ok: false, reason: 'cursor_expired' })
    expect(
      diagnoseRunEventCursor({
        runId,
        lastEventId: `${runId}:12`,
        eventSeq: 9,
        earliestEventSeq: 1,
      }),
    ).toEqual({ ok: false, reason: 'cursor_ahead' })
  })

  it('none / redis 提示通道可装配；显式 postgres 不能用在非 PG', async () => {
    const none = createChangeHint({
      hint: 'none',
      namespace: 'test',
      dbEnv: handle.env,
    })
    expect(none.realtime).toBe(false)
    expect(none.driver).toBe('none')
    await none.close()

    const redis = createChangeHint({
      hint: 'redis',
      redisUrl: 'redis://127.0.0.1:6379',
      namespace: 'test',
      dbEnv: handle.env,
    })
    expect(redis.driver).toBe('redis')
    expect(redis.realtime).toBe(true)
    await redis.close()

    if (driver !== 'postgres') {
      expect(() =>
        createChangeHint({
          hint: 'postgres',
          namespace: 'test',
          dbEnv: handle.env,
        }),
      ).toThrow(/PostgreSQL/)
      return
    }

    const namespace = `rt07-${newId().slice(0, 8)}`
    const bus = createChangeHint({
      hint: 'postgres',
      namespace,
      dbEnv: handle.env,
    })
    const received: number[] = []
    await bus.subscribe((hint) => {
      if (hint.runId === '66666666-6666-4666-8666-666666666666') received.push(hint.eventSeq)
    })
    await bus.publish({
      namespace,
      runId: '66666666-6666-4666-8666-666666666666',
      eventSeq: 7,
    })
    await expect.poll(() => received, { timeout: 3_000 }).toEqual([7])
    await bus.close()
  })
})
