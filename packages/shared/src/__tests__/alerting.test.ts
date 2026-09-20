import { describe, expect, it } from 'vitest'
import {
  FACTORY_ALERTING,
  FACTORY_ALERT_RULES,
  alertRuleSchema,
  alertWebhookPublicUrlSchema,
  alertWebhookUrlSchema,
  isBlockedAlertWebhookHost,
  compareAlertThreshold,
  isAlertableMetricKey,
  monitorAlertListQuerySchema,
  platformAlertingSchema,
  requiredAlertMetricScope,
} from '../alerting.js'

describe('告警契约', () => {
  it('出厂建议规则全部关闭且只挂 L2/L3', () => {
    expect(FACTORY_ALERT_RULES.length).toBeGreaterThan(0)
    expect(FACTORY_ALERTING.rules).toEqual(FACTORY_ALERT_RULES)
    expect(FACTORY_ALERTING.channels).toEqual([])
    for (const rule of FACTORY_ALERT_RULES) {
      expect(rule.enabled).toBe(false)
      if (rule.kind === 'threshold') {
        expect(isAlertableMetricKey(rule.metricKey)).toBe(true)
        expect(requiredAlertMetricScope(rule.metricKey)).toBe(rule.scope)
      }
    }
  })

  it('拒绝 L1/L4 阈值规则', () => {
    expect(isAlertableMetricKey('database.pingLatencyMs')).toBe(false)
    expect(isAlertableMetricKey('api.uptimeSeconds')).toBe(false)
    expect(() =>
      alertRuleSchema.parse({
        kind: 'threshold',
        id: 'bad.l1',
        name: '数据库 ping',
        metricKey: 'database.pingLatencyMs',
        scope: 'platform',
        comparator: 'gte',
        threshold: 200,
        forSeconds: 60,
        severity: 'warning',
        channelIds: [],
        enabled: true,
      }),
    ).toThrow(/L2\/L3/)
  })

  it('阈值比较与 Webhook URL 约束', () => {
    expect(compareAlertThreshold(2, 'gte', 2)).toBe(true)
    expect(compareAlertThreshold(1, 'gt', 1)).toBe(false)
    expect(() => alertWebhookUrlSchema.parse('ftp://example.com/hook')).toThrow()
    expect(() => alertWebhookUrlSchema.parse('https://user:pass@example.com/hook')).toThrow()
    expect(alertWebhookUrlSchema.parse('https://hooks.example.com/a')).toBe('https://hooks.example.com/a')
    expect(alertWebhookUrlSchema.parse('http://127.0.0.1/hook')).toBe('http://127.0.0.1/hook')
    expect(() => alertWebhookPublicUrlSchema.parse('http://127.0.0.1/hook')).toThrow(/回环|内网|控制面/)
    expect(() => alertWebhookPublicUrlSchema.parse('https://10.0.0.8/hook')).toThrow(/回环|内网|控制面/)
    expect(() => alertWebhookPublicUrlSchema.parse('http://169.254.169.254/latest')).toThrow(/回环|内网|控制面/)
    expect(() => alertWebhookPublicUrlSchema.parse('https://metadata.google.internal/')).toThrow(/回环|内网|控制面/)
    expect(isBlockedAlertWebhookHost('192.168.1.9')).toBe(true)
    expect(isBlockedAlertWebhookHost('hooks.example.com')).toBe(false)
    expect(isBlockedAlertWebhookHost('worker.example.com', ['worker.example.com'])).toBe(true)
  })

  it('渠道引用必须存在', () => {
    expect(() =>
      platformAlertingSchema.parse({
        rules: [
          {
            ...FACTORY_ALERT_RULES[0],
            enabled: true,
            channelIds: ['00000000-0000-4000-8000-000000000099'],
          },
        ],
        channels: [],
      }),
    ).toThrow(/渠道不存在/)
  })

  it('告警列表查询默认 active', () => {
    expect(monitorAlertListQuerySchema.parse({}).view).toBe('active')
    expect(monitorAlertListQuerySchema.parse({}).limit).toBe(20)
  })
})
