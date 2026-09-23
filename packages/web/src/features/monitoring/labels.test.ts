import { describe, expect, it } from 'vitest'
import { knownMetric, unknownMetric } from '@cairn/shared'
import {
  AUTO_REFRESH_INTERVAL_STORAGE_KEY,
  formatBytes,
  formatMetric,
  freshnessLabel,
  partitionFailure,
  permissionFailure,
  readAutoRefreshInterval,
  unknownLabel,
  writeAutoRefreshInterval,
} from './labels'

describe('监控呈现口径', () => {
  it('unknown 显示未采集而不是 0', () => {
    expect(formatMetric(unknownMetric('not_collected'))).toBe('未采集／未上报')
    expect(formatMetric(unknownMetric('unsupported'))).toBe('未采集／未上报')
    expect(formatMetric(knownMetric(0))).toBe('0')
    expect(formatMetric(unknownMetric('not_collected'))).not.toBe('0')
    expect(unknownLabel('not_reported')).toBe('未采集／未上报')
    expect(formatBytes(unknownMetric('not_collected'))).toBe('未采集／未上报')
    expect(formatBytes(unknownMetric('not_collected'))).not.toBe('0 B')
  })

  it('新鲜度按 source 区分此刻与上次采样', () => {
    const at = '2026-09-18T03:00:00.000Z'
    expect(freshnessLabel('self', at)).toContain('此刻的事实')
    expect(freshnessLabel('registry', at)).toContain('此刻的事实')
    expect(freshnessLabel('sample', at)).toContain('上次采样')
  })

  it('三类失败文案不混用', () => {
    expect(partitionFailure('DATA_PLANE_UNAVAILABLE').title).toBe('监控数据读取失败')
    expect(partitionFailure('AGGREGATE_FAILED').title).toBe('监控数据读取失败')
    expect(permissionFailure('x').title).toBe('无权限')
    expect(partitionFailure('AGGREGATE_FAILED').title).not.toBe('服务异常')
  })

  it('支持读取与写入自动刷新间隔配置 (15s/30s/60s/120s)', () => {
    localStorage.removeItem(AUTO_REFRESH_INTERVAL_STORAGE_KEY)
    expect(readAutoRefreshInterval()).toBe(30)

    writeAutoRefreshInterval(15)
    expect(readAutoRefreshInterval()).toBe(15)

    writeAutoRefreshInterval(60)
    expect(readAutoRefreshInterval()).toBe(60)

    writeAutoRefreshInterval(120)
    expect(readAutoRefreshInterval()).toBe(120)

    localStorage.setItem(AUTO_REFRESH_INTERVAL_STORAGE_KEY, 'invalid')
    expect(readAutoRefreshInterval()).toBe(30)
    localStorage.removeItem(AUTO_REFRESH_INTERVAL_STORAGE_KEY)
  })
})
