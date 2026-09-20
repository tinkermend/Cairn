import { describe, expect, it } from 'vitest'
import {
  addCalendarMonths,
  addValidityDuration,
  computeMaintenanceDueAt,
  credentialRegisterBodySchema,
  credentialValidityWriteSchema,
  deriveMaintenanceStatus,
  formatValidityPreview,
  localWallToUtc,
  policyFromWrite,
  unknownValidityPolicy,
} from '../credentials.js'

describe('凭据有效期计算', () => {
  it('月末按日历月夹取，且从原起算点一次加 N 月', () => {
    expect(addCalendarMonths(2027, 1, 31, 1)).toEqual({ year: 2027, month: 2, day: 28 })
    expect(addCalendarMonths(2027, 1, 31, 2)).toEqual({ year: 2027, month: 3, day: 31 })
    expect(addCalendarMonths(2028, 1, 31, 1)).toEqual({ year: 2028, month: 2, day: 29 })
  })

  it('按天是连续 24 小时', () => {
    const started = new Date('2026-01-01T10:00:00.000Z')
    expect(addValidityDuration(started, { mode: 'days', amount: 30, timeZone: 'UTC' })?.toISOString()).toBe(
      '2026-01-31T10:00:00.000Z',
    )
  })

  it('按月保留当地时间，闰年与平年分别夹取', () => {
    const started = new Date('2027-01-31T02:00:00.000Z')
    const one = addValidityDuration(started, { mode: 'months', amount: 1, timeZone: 'Asia/Taipei' })
    const two = addValidityDuration(started, { mode: 'months', amount: 2, timeZone: 'Asia/Taipei' })
    expect(one?.toISOString()).toBe('2027-02-28T02:00:00.000Z')
    expect(two?.toISOString()).toBe('2027-03-31T02:00:00.000Z')

    const leap = addValidityDuration(new Date('2028-01-31T02:00:00.000Z'), {
      mode: 'months',
      amount: 1,
      timeZone: 'Asia/Taipei',
    })
    expect(leap?.toISOString()).toBe('2028-02-29T02:00:00.000Z')
  })

  it('40 天前启用、有效期 30 天立即到期；改期限从原起算点重算', () => {
    const started = new Date('2026-08-10T00:00:00.000Z')
    const now = new Date('2026-09-19T00:00:00.000Z')
    const due30 = computeMaintenanceDueAt({
      policy: { mode: 'days', amount: 30, timeZone: 'UTC' },
      startedAt: started,
    })
    expect(deriveMaintenanceStatus({ policy: { mode: 'days' }, dueAt: due30, now, reminderLeadDays: 14 })).toBe(
      'due',
    )
    const due90 = computeMaintenanceDueAt({
      policy: { mode: 'days', amount: 90, timeZone: 'UTC' },
      startedAt: started,
    })
    expect(due90?.toISOString()).toBe('2026-11-08T00:00:00.000Z')
    expect(deriveMaintenanceStatus({ policy: { mode: 'days' }, dueAt: due90, now, reminderLeadDays: 14 })).toBe(
      'not_due',
    )
  })

  it('永久、未知、已到期三者可区分', () => {
    const now = new Date('2026-09-19T00:00:00.000Z')
    expect(
      deriveMaintenanceStatus({ policy: { mode: 'permanent' }, dueAt: null, now, reminderLeadDays: 14 }),
    ).toBe('permanent')
    expect(
      deriveMaintenanceStatus({ policy: { mode: 'unknown' }, dueAt: null, now, reminderLeadDays: 14 }),
    ).toBe('unknown')
    expect(formatValidityPreview({ policy: unknownValidityPolicy(), startedAt: null, dueAt: null })).toBe(
      '期限待补充',
    )
  })

  it('提醒窗口大于有效期时从启用即进入即将到期', () => {
    const started = new Date('2026-09-18T00:00:00.000Z')
    const now = new Date('2026-09-18T01:00:00.000Z')
    const due = computeMaintenanceDueAt({
      policy: { mode: 'days', amount: 7, timeZone: 'UTC' },
      startedAt: started,
    })
    expect(deriveMaintenanceStatus({ policy: { mode: 'days' }, dueAt: due, now, reminderLeadDays: 14 })).toBe(
      'approaching',
    )
  })

  it('夏令时缺口向后移，重叠取较早时刻', () => {
    const gap = localWallToUtc('America/New_York', {
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
      second: 0,
      millisecond: 0,
    })
    expect(gap.toISOString()).toBe('2026-03-08T07:30:00.000Z')

    const overlap = localWallToUtc('America/New_York', {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
      second: 0,
      millisecond: 0,
    })
    expect(overlap.toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('新登记必须选择期限，不接受 unknown', () => {
    expect(() =>
      credentialValidityWriteSchema.parse({ mode: 'unknown', timeZone: 'Asia/Shanghai' }),
    ).toThrow()
    expect(() => credentialValidityWriteSchema.parse({ mode: 'days' })).toThrow()
    expect(policyFromWrite({ mode: 'permanent' })).toEqual({
      mode: 'permanent',
      amount: null,
      timeZone: null,
    })
    expect(() =>
      credentialRegisterBodySchema.parse({
        type: 'target_password',
        validity: { mode: 'days', amount: 30, timeZone: 'Asia/Shanghai' },
      }),
    ).toThrow()
  })
})
