import { describe, expect, it } from 'vitest'
import {
  previewScheduleWindows,
  resolveLocalInstant,
  resolveScheduleWindow,
  scheduleDefinitionSchema,
  scheduleOccurrenceKey,
  scheduledMapJobCommandKey,
} from '../schedules.js'

const SCHEDULE_ID = '00000000-0000-4000-8000-0000000000aa'

function definition(overrides: Partial<{ timezone: string; weekdays: number[]; windowStart: string; windowEnd: string }> = {}) {
  return scheduleDefinitionSchema.parse({
    timezone: overrides.timezone ?? 'America/New_York',
    weekdays: overrides.weekdays ?? [1, 2, 3, 4, 5, 6, 7],
    windowStart: overrides.windowStart ?? '02:30',
    windowEnd: overrides.windowEnd ?? '03:30',
    misfire: 'skip',
    consumer: {
      type: 'map_refresh',
      targetId: '00000000-0000-4000-8000-000000000001',
      targetAccountId: '00000000-0000-4000-8000-000000000002',
      entryId: '00000000-0000-4000-8000-000000000003',
    },
  })
}

describe('调度时间规则', () => {
  it('普通日把本地窗转成唯一 UTC', () => {
    const window = resolveScheduleWindow({
      scheduleId: SCHEDULE_ID,
      timezone: 'Asia/Shanghai',
      windowStart: '09:00',
      windowEnd: '10:00',
      localDate: { year: 2026, month: 6, day: 15 },
    })
    expect(window).toMatchObject({
      kind: 'ok',
      windowStartUtc: '2026-06-15T01:00:00.000Z',
      windowEndUtc: '2026-06-15T02:00:00.000Z',
      startOffsetMinutes: 480,
      endOffsetMinutes: 480,
    })
    if (window.kind === 'ok') {
      expect(window.occurrenceKey).toBe(scheduleOccurrenceKey(SCHEDULE_ID, window.windowStartUtc))
    }
  })

  it('跨午夜仍属于开始日', () => {
    const window = resolveScheduleWindow({
      scheduleId: SCHEDULE_ID,
      timezone: 'Asia/Shanghai',
      windowStart: '23:00',
      windowEnd: '01:00',
      localDate: { year: 2026, month: 6, day: 15 },
    })
    expect(window).toMatchObject({
      kind: 'ok',
      localStartDate: '2026-06-15',
      windowStartUtc: '2026-06-15T15:00:00.000Z',
      windowEndUtc: '2026-06-15T17:00:00.000Z',
    })
  })

  it('夏令时前拨不存在的端点整窗跳过', () => {
    const missing = resolveLocalInstant('America/New_York', {
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
    })
    expect(missing.kind).toBe('nonexistent')
    const window = resolveScheduleWindow({
      scheduleId: SCHEDULE_ID,
      timezone: 'America/New_York',
      windowStart: '02:30',
      windowEnd: '03:30',
      localDate: { year: 2026, month: 3, day: 8 },
    })
    expect(window).toMatchObject({ kind: 'skipped', reason: 'DST_NONEXISTENT' })
    expect('occurrenceKey' in window).toBe(false)
  })

  it('夏令时后拨重复端点只取较早一次', () => {
    const first = resolveLocalInstant('America/New_York', {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
    })
    expect(first.kind).toBe('ok')
    if (first.kind === 'ok') {
      expect(first.instant.toISOString()).toBe('2026-11-01T05:30:00.000Z')
    }
    const window = resolveScheduleWindow({
      scheduleId: SCHEDULE_ID,
      timezone: 'America/New_York',
      windowStart: '01:30',
      windowEnd: '02:30',
      localDate: { year: 2026, month: 11, day: 1 },
    })
    expect(window.kind).toBe('ok')
    if (window.kind === 'ok') {
      expect(window.windowStartUtc).toBe('2026-11-01T05:30:00.000Z')
    }
  })

  it('同一 asOf 与 IANA 不依赖进程墙钟', () => {
    const asOf = new Date('2026-06-15T00:00:00.000Z')
    const first = previewScheduleWindows({
      scheduleId: SCHEDULE_ID,
      definition: definition({ timezone: 'Europe/Berlin', windowStart: '09:00', windowEnd: '10:00' }),
      asOf,
    })
    const second = previewScheduleWindows({
      scheduleId: SCHEDULE_ID,
      definition: definition({ timezone: 'Europe/Berlin', windowStart: '09:00', windowEnd: '10:00' }),
      asOf,
    })
    expect(first).toEqual(second)
    expect(first[0]).toMatchObject({ kind: 'ok' })
  })

  it('预览最多 10 个未来窗口并跳过已结束窗', () => {
    const windows = previewScheduleWindows({
      scheduleId: SCHEDULE_ID,
      definition: definition({ timezone: 'Asia/Shanghai', windowStart: '09:00', windowEnd: '10:00', weekdays: [1] }),
      asOf: new Date('2026-06-15T02:30:00.000Z'),
    })
    expect(windows).toHaveLength(10)
    expect(windows.every((item) => item.kind === 'ok' && item.localStartDate >= '2026-06-22')).toBe(true)
  })

  it('定时作业命令键只含 occurrenceId', () => {
    expect(scheduledMapJobCommandKey('00000000-0000-4000-8000-000000000099')).toBe(
      'map:scheduled:00000000-0000-4000-8000-000000000099',
    )
  })

  it('拒绝全天零长窗口和未知时区', () => {
    expect(() =>
      scheduleDefinitionSchema.parse({
        timezone: 'Asia/Shanghai',
        weekdays: [1],
        windowStart: '09:00',
        windowEnd: '09:00',
        misfire: 'skip',
        consumer: {
          type: 'map_refresh',
          targetId: '00000000-0000-4000-8000-000000000001',
          targetAccountId: '00000000-0000-4000-8000-000000000002',
          entryId: '00000000-0000-4000-8000-000000000003',
        },
      }),
    ).toThrow()
    expect(() =>
      scheduleDefinitionSchema.parse({
        timezone: 'Not/AZone',
        weekdays: [1],
        windowStart: '09:00',
        windowEnd: '10:00',
        misfire: 'skip',
        consumer: {
          type: 'map_refresh',
          targetId: '00000000-0000-4000-8000-000000000001',
          targetAccountId: '00000000-0000-4000-8000-000000000002',
          entryId: '00000000-0000-4000-8000-000000000003',
        },
      }),
    ).toThrow()
  })
})
