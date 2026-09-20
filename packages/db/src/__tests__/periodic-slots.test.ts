import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PERIODIC_SLOT_FAILURE_RETRY_MS, nextPeriodicSlotDueAt } from '@cairn/shared'
import { DRIVERS, openContractDb } from './contract-fixture.js'
import {
  claimDuePeriodicSlots,
  finishPeriodicSlot,
  readPeriodicSlots,
  type NativeHandle as DbHandle,
} from '../test-entry.js'
import { clockNow, schemaFor, updateRows } from '../native.js'
import { DomainError } from '../runs/errors.js'
import { eq } from 'drizzle-orm'

describe.each(DRIVERS)('%s 周期槽位原语', { timeout: 60_000 }, (driver) => {
  let handle: DbHandle

  beforeAll(async () => {
    handle = await openContractDb(driver, `slot_${Date.now().toString(36)}`)
  })

  afterAll(async () => {
    await handle?.close()
  })

  async function snapshot(name: 'monitor.alerts.evaluate' | 'reaper.recovery' | 'monitor.sample.platform') {
    const [row] = await readPeriodicSlots(handle.db, [name])
    return row
  }

  it('PS04 未到点或输掉 CAS 的 tick 对槽位无写入', async () => {
    const first = await claimDuePeriodicSlots(handle.db, [
      { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 60_000, owner: 'w1', leaseTtlMs: 5_000 },
    ])
    expect(first.claimed).toHaveLength(1)
    await finishPeriodicSlot(handle.db, {
      name: 'monitor.alerts.evaluate',
      claimSeq: first.claimed[0]!.claimSeq,
      outcome: 'ok',
    })
    const before = await snapshot('monitor.alerts.evaluate')
    const second = await claimDuePeriodicSlots(handle.db, [
      { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 60_000, owner: 'w2', leaseTtlMs: 5_000 },
    ])
    expect(second.claimed).toHaveLength(0)
    expect(second.skipped.some((item) => item.reason === 'not_due')).toBe(true)
    expect(await snapshot('monitor.alerts.evaluate')).toEqual(before)
  })

  it('PS01 八路并发到点只领一次', async () => {
    const { periodicSlots: table } = schemaFor(handle.db)
    await updateRows(handle.db, table, { nextDueAt: new Date(0), leaseUntil: null, leaseOwner: null }, eq(table.name, 'monitor.sample.platform'))
    const requests = Array.from({ length: 8 }, (_, index) =>
      claimDuePeriodicSlots(handle.db, [
        {
          name: 'monitor.sample.platform',
          mode: 'single_flight',
          intervalMs: 60_000,
          owner: `node-${index}`,
          leaseTtlMs: 10_000,
        },
      ]),
    )
    const results = await Promise.all(requests)
    const winners = results.flatMap((row) => row.claimed)
    expect(winners).toHaveLength(1)
    expect(new Set(winners.map((item) => item.claimSeq)).size).toBe(1)
    const row = await snapshot('monitor.sample.platform')
    expect(row?.leaseOwner).toBeTruthy()
    expect(row?.leaseUntil).toBeTruthy()
    await finishPeriodicSlot(handle.db, {
      name: 'monitor.sample.platform',
      claimSeq: winners[0]!.claimSeq,
      outcome: 'ok',
    })
  })

  it('PS02 单飞租约过期后恰有一人接手', async () => {
    const { periodicSlots: table } = schemaFor(handle.db)
    await updateRows(
      handle.db,
      table,
      { nextDueAt: new Date(0), leaseUntil: null, leaseOwner: null },
      eq(table.name, 'monitor.alerts.evaluate'),
    )
    const first = await claimDuePeriodicSlots(handle.db, [
      { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 15_000, owner: 'crash', leaseTtlMs: 60_000 },
    ])
    expect(first.claimed).toHaveLength(1)
    const held = await claimDuePeriodicSlots(handle.db, [
      { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 15_000, owner: 'peer', leaseTtlMs: 60_000 },
    ])
    expect(held.claimed).toHaveLength(0)
    await updateRows(handle.db, table, { nextDueAt: new Date(0) }, eq(table.name, 'monitor.alerts.evaluate'))
    const stillHeld = await claimDuePeriodicSlots(handle.db, [
      { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 15_000, owner: 'peer', leaseTtlMs: 60_000 },
    ])
    expect(stillHeld.skipped.some((item) => item.reason === 'lease_held')).toBe(true)
    await updateRows(
      handle.db,
      table,
      { nextDueAt: new Date(0), leaseUntil: new Date(0) },
      eq(table.name, 'monitor.alerts.evaluate'),
    )
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        claimDuePeriodicSlots(handle.db, [
          {
            name: 'monitor.alerts.evaluate',
            mode: 'single_flight',
            intervalMs: 15_000,
            owner: `takeover-${index}`,
            leaseTtlMs: 10_000,
          },
        ]),
      ),
    )
    const winners = results.flatMap((row) => row.claimed)
    expect(winners).toHaveLength(1)
    await finishPeriodicSlot(handle.db, {
      name: 'monitor.alerts.evaluate',
      claimSeq: winners[0]!.claimSeq,
      outcome: 'ok',
    })
  })

  it('PS03 旧 claim_seq 收尾不改写新一轮', async () => {
    const { periodicSlots: table } = schemaFor(handle.db)
    await updateRows(
      handle.db,
      table,
      { nextDueAt: new Date(0), leaseUntil: null, leaseOwner: null },
      eq(table.name, 'monitor.alerts.evaluate'),
    )
    const first = await claimDuePeriodicSlots(handle.db, [
      { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 15_000, owner: 'old', leaseTtlMs: 1_000 },
    ])
    expect(first.claimed[0]?.claimSeq).toBeGreaterThan(0)
    await updateRows(
      handle.db,
      table,
      { nextDueAt: new Date(0), leaseUntil: new Date(0) },
      eq(table.name, 'monitor.alerts.evaluate'),
    )
    const second = await claimDuePeriodicSlots(handle.db, [
      { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 15_000, owner: 'new', leaseTtlMs: 10_000 },
    ])
    expect(second.claimed).toHaveLength(1)
    expect(second.claimed[0]!.claimSeq).toBeGreaterThan(first.claimed[0]!.claimSeq)
    const wrote = await finishPeriodicSlot(handle.db, {
      name: 'monitor.alerts.evaluate',
      claimSeq: first.claimed[0]!.claimSeq,
      outcome: 'failed',
      errorClass: 'stale',
    })
    expect(wrote).toBe(false)
    const row = await snapshot('monitor.alerts.evaluate')
    expect(row?.claimSeq).toBe(second.claimed[0]!.claimSeq)
    expect(row?.lastOwner).toBe('new')
    expect(row?.leaseOwner).toBe('new')
    expect(row?.lastErrorClass).not.toBe('stale')
    await finishPeriodicSlot(handle.db, {
      name: 'monitor.alerts.evaluate',
      claimSeq: second.claimed[0]!.claimSeq,
      outcome: 'ok',
    })
  })

  it('PS05 限流不持租约，到点后他人可领', async () => {
    const first = await claimDuePeriodicSlots(handle.db, [
      { name: 'reaper.recovery', mode: 'throttle', intervalMs: 15_000, owner: 'hang' },
    ])
    expect(first.claimed).toHaveLength(1)
    const held = await snapshot('reaper.recovery')
    expect(held?.leaseOwner).toBeNull()
    expect(held?.leaseUntil).toBeNull()
    const blocked = await claimDuePeriodicSlots(handle.db, [
      { name: 'reaper.recovery', mode: 'throttle', intervalMs: 15_000, owner: 'other' },
    ])
    expect(blocked.claimed).toHaveLength(0)
    const { periodicSlots: table } = schemaFor(handle.db)
    await updateRows(handle.db, table, { nextDueAt: new Date(0) }, eq(table.name, 'reaper.recovery'))
    const second = await claimDuePeriodicSlots(handle.db, [
      { name: 'reaper.recovery', mode: 'throttle', intervalMs: 15_000, owner: 'other' },
    ])
    expect(second.claimed).toHaveLength(1)
    expect(second.claimed[0]!.claimSeq).toBeGreaterThan(first.claimed[0]!.claimSeq)
  })

  it('PS06 失败缩短 next_due_at', async () => {
    const { periodicSlots: table } = schemaFor(handle.db)
    await updateRows(handle.db, table, { nextDueAt: new Date(0), leaseUntil: null }, eq(table.name, 'reaper.recovery'))
    const claimed = await claimDuePeriodicSlots(handle.db, [
      { name: 'reaper.recovery', mode: 'throttle', intervalMs: 60_000, owner: 'fail' },
    ])
    const now = await clockNow(handle.db)
    await finishPeriodicSlot(handle.db, {
      name: 'reaper.recovery',
      claimSeq: claimed.claimed[0]!.claimSeq,
      outcome: 'failed',
      errorClass: 'Injected',
      failureRetryMs: DEFAULT_PERIODIC_SLOT_FAILURE_RETRY_MS,
    })
    const row = await snapshot('reaper.recovery')
    expect(row?.lastOutcome).toBe('failed')
    expect(row?.lastErrorClass).toBe('Injected')
    expect(row!.nextDueAt.getTime()).toBeLessThanOrEqual(now.getTime() + DEFAULT_PERIODIC_SLOT_FAILURE_RETRY_MS + 50)
  })

  it('PS08 进程时钟偏移不改变领取判定', async () => {
    const { periodicSlots: table } = schemaFor(handle.db)
    const now = await clockNow(handle.db)
    await updateRows(
      handle.db,
      table,
      { nextDueAt: new Date(now.getTime() + 30_000), leaseUntil: null, leaseOwner: null },
      eq(table.name, 'monitor.alerts.evaluate'),
    )
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000)
    try {
      const early = await claimDuePeriodicSlots(handle.db, [
        { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 15_000, owner: 'skew', leaseTtlMs: 5_000 },
      ])
      expect(early.claimed).toHaveLength(0)
      await updateRows(handle.db, table, { nextDueAt: new Date(0) }, eq(table.name, 'monitor.alerts.evaluate'))
      vi.mocked(Date.now).mockImplementation(() => realNow() - 60_000)
      const due = await claimDuePeriodicSlots(handle.db, [
        { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs: 15_000, owner: 'skew', leaseTtlMs: 5_000 },
      ])
      expect(due.claimed).toHaveLength(1)
      await finishPeriodicSlot(handle.db, {
        name: 'monitor.alerts.evaluate',
        claimSeq: due.claimed[0]!.claimSeq,
        outcome: 'ok',
      })
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('PS10 缺行补建、CHECK 与到点容差', async () => {
    const seeded = await claimDuePeriodicSlots(handle.db, [
      { name: 'credential.reminders', mode: 'throttle', intervalMs: 60_000, owner: 'seed' },
    ])
    expect(seeded.claimed).toHaveLength(1)
    const { periodicSlots: table } = schemaFor(handle.db)
    await expect(
      handle.db.insert(table).values({
        name: 'bad-mode-row',
        mode: 'leader' as 'throttle',
        nextDueAt: new Date(),
        claimSeq: 0,
      }),
    ).rejects.toThrow()
    await expect(
      claimDuePeriodicSlots(handle.db, [
        { name: 'not.a.slot' as 'reaper.recovery', mode: 'throttle', intervalMs: 15_000 },
      ]),
    ).rejects.toBeInstanceOf(DomainError)
    await updateRows(handle.db, table, { mode: 'single_flight' }, eq(table.name, 'credential.reminders'))
    const mismatch = await claimDuePeriodicSlots(handle.db, [
      { name: 'credential.reminders', mode: 'throttle', intervalMs: 60_000, owner: 'x' },
    ])
    expect(mismatch.skipped.some((item) => item.reason === 'mode_mismatch')).toBe(true)
    await updateRows(handle.db, table, { mode: 'throttle' }, eq(table.name, 'credential.reminders'))
  })

  it('PS15 周期等于 tick 时连续 20 拍不掉拍', async () => {
    const intervalMs = 80
    const { periodicSlots: table } = schemaFor(handle.db)
    await updateRows(
      handle.db,
      table,
      { nextDueAt: new Date(0), leaseUntil: null, leaseOwner: null, claimSeq: 0 },
      eq(table.name, 'monitor.alerts.evaluate'),
    )
    const seqs: number[] = []
    for (let i = 0; i < 20; i += 1) {
      const result = await claimDuePeriodicSlots(handle.db, [
        { name: 'monitor.alerts.evaluate', mode: 'single_flight', intervalMs, owner: 'solo', leaseTtlMs: 5_000 },
      ])
      expect(result.claimed, `cycle ${i}`).toHaveLength(1)
      seqs.push(result.claimed[0]!.claimSeq)
      await finishPeriodicSlot(handle.db, {
        name: 'monitor.alerts.evaluate',
        claimSeq: result.claimed[0]!.claimSeq,
        outcome: 'ok',
      })
      const now = await clockNow(handle.db)
      const expected = nextPeriodicSlotDueAt(now, intervalMs)
      const row = await snapshot('monitor.alerts.evaluate')
      expect(row!.nextDueAt.getTime()).toBeLessThanOrEqual(expected.getTime() + 20)
      await new Promise((resolve) => setTimeout(resolve, intervalMs + 5))
    }
    expect(new Set(seqs).size).toBe(20)
  })

  it('错相位多节点总执行次数不超过周期数加一', async () => {
    const intervalMs = 60
    const { periodicSlots: table } = schemaFor(handle.db)
    await updateRows(
      handle.db,
      table,
      { nextDueAt: new Date(0), leaseUntil: null, leaseOwner: null },
      eq(table.name, 'monitor.sample.platform'),
    )
    let executed = 0
    const tick = async (owner: string) => {
      const result = await claimDuePeriodicSlots(handle.db, [
        { name: 'monitor.sample.platform', mode: 'single_flight', intervalMs, owner, leaseTtlMs: 2_000 },
      ])
      if (result.claimed[0]) {
        executed += 1
        await finishPeriodicSlot(handle.db, {
          name: 'monitor.sample.platform',
          claimSeq: result.claimed[0].claimSeq,
          outcome: 'ok',
        })
      }
    }
    const cycles = 8
    for (let i = 0; i < cycles; i += 1) {
      await Promise.all([tick('a'), tick('b')])
      await new Promise((resolve) => setTimeout(resolve, intervalMs + 5))
    }
    expect(executed).toBeLessThanOrEqual(cycles + 1)
    expect(executed).toBeGreaterThanOrEqual(cycles)
  })
})
