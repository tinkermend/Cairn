import { describe, expect, it } from 'vitest'
import {
  formatAsOf,
  formatClock,
  formatDuration,
  formatDurationMs,
  formatRelativeTime,
} from './formatters'

describe('formatters 统一格式化工具', () => {
  it('formatAsOf 正确格式化日期且对空值友好', () => {
    expect(formatAsOf(null)).toBe('—')
    expect(formatAsOf(undefined)).toBe('—')
    expect(formatAsOf('')).toBe('—')
    expect(formatAsOf('invalid-date')).toBe('invalid-date')

    const dateStr = '2026-09-28T12:00:00.000Z'
    const result = formatAsOf(dateStr)
    expect(result).not.toBe('—')
    expect(result).toContain('2026')
  })

  it('formatClock 提取时分秒纯时间文本', () => {
    expect(formatClock(null)).toBe('—')
    expect(formatClock(undefined)).toBe('—')
    const dateStr = '2026-09-28T12:30:45.000Z'
    const clock = formatClock(dateStr)
    expect(clock).not.toBe('—')
    expect(clock).toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  it('formatRelativeTime 格式化相对时间', () => {
    expect(formatRelativeTime(null)).toBe('')
    expect(formatRelativeTime('invalid')).toBe('')

    const now = Date.now()
    expect(formatRelativeTime(new Date(now - 10_000).toISOString())).toBe('刚刚')
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString())).toBe('5分钟前')
    expect(formatRelativeTime(new Date(now - 3 * 3600_000).toISOString())).toBe('3小时前')
    expect(formatRelativeTime(new Date(now - 2 * 86400_000).toISOString())).toBe('2天前')
  })

  it('formatDuration 计算并格式化两个时间戳区间的历时', () => {
    expect(formatDuration(null, null)).toBeNull()
    expect(formatDuration('2026-09-28T10:00:00Z', null)).toBeNull()
    expect(formatDuration('2026-09-28T10:00:05Z', '2026-09-28T10:00:00Z')).toBeNull() // 负数

    // < 1000ms
    expect(formatDuration('2026-09-28T10:00:00.000Z', '2026-09-28T10:00:00.450Z')).toBe('450 ms')

    // 1000ms - 9999ms
    expect(formatDuration('2026-09-28T10:00:00.000Z', '2026-09-28T10:00:02.500Z')).toBe('2.5 s')

    // >= 10s
    expect(formatDuration('2026-09-28T10:00:00.000Z', '2026-09-28T10:00:25.000Z')).toBe('25 s')
  })

  it('formatDurationMs 格式化毫秒耗时为易读中文', () => {
    expect(formatDurationMs(500)).toBe('< 1秒')
    expect(formatDurationMs(3400)).toBe('3秒')
    expect(formatDurationMs(65000)).toBe('1分5秒')
    expect(formatDurationMs(120000)).toBe('2分0秒')
  })
})
