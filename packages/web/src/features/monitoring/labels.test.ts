import { describe, expect, it } from 'vitest'
import { knownMetric, unknownMetric } from '@cairn/shared'
import {
  formatBytes,
  formatMetric,
  freshnessLabel,
  partitionFailure,
  permissionFailure,
  unknownLabel,
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
})
