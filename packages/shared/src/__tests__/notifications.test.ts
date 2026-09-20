import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_POLICY,
  FACTORY_NOTIFICATIONS,
  notificationChannelWriteSchema,
  notificationPayloadSchema,
  notificationReasons,
} from '../notifications.js'
import { FACTORY_PLATFORM_CONFIG, upgradePlatformConfigDocument } from '../platform-config.js'
import { FACTORY_ALERTING } from '../alerting.js'
import { protocolCapabilitiesForRoles, registrationRequiresOccupancy } from '../worker-roles.js'
const id = '11111111-1111-4111-8111-111111111111'
describe('通知边界契约', () => {
  it('出厂关闭；缺省策略不订阅；维护角色不需要浏览器占用', () => {
    expect(FACTORY_NOTIFICATIONS.enabled).toBe(false)
    expect(DEFAULT_NOTIFICATION_POLICY.enabled).toBe(false)
    const capabilities = protocolCapabilitiesForRoles({
      executor: false,
      scheduler: false,
      maintenance: true,
    })
    expect(capabilities).toContain('notification-delivery@1')
    expect(registrationRequiresOccupancy(capabilities)).toBe(false)
  })
  it.each([
    ['SUCCEEDED', 'NOT_EVALUATED', 'COMPLETE', []],
    ['SUCCEEDED', 'PASS', 'COMPLETE', []],
    [
      'FAILED',
      'UNKNOWN',
      'INCOMPLETE',
      ['execution_failed', 'outcome_unknown', 'evidence_incomplete'],
    ],
    ['SUCCEEDED', 'FAIL', 'COMPLETE', ['outcome_fail']],
    ['SUCCEEDED', 'WARN', 'COMPLETE', ['outcome_warn']],
    ['SUCCEEDED', 'NOT_EVALUATED', 'PENDING', ['evidence_pending']],
    ['CANCELLED', 'UNKNOWN', 'INCOMPLETE', []],
  ])('异常规则 %s/%s/%s 不混淆三轴', (status, outcomeStatus, evidenceStatus, expected) => {
    expect(
      notificationReasons(DEFAULT_NOTIFICATION_POLICY, {
        status: status as string,
        outcomeStatus: outcomeStatus as string,
        evidenceStatus: evidenceStatus as string,
      }),
    ).toEqual(expected)
  })
  it('取消开关优先于其他异常原因；全部结束包含取消', () => {
    expect(
      notificationReasons(
        { ...DEFAULT_NOTIFICATION_POLICY, includeCancelled: true },
        { status: 'CANCELLED', outcomeStatus: 'FAIL', evidenceStatus: 'INCOMPLETE' },
      ),
    ).toEqual(['cancelled'])
    expect(
      notificationReasons(
        { ...DEFAULT_NOTIFICATION_POLICY, mode: 'all_finished' },
        { status: 'CANCELLED', outcomeStatus: 'UNKNOWN', evidenceStatus: 'PENDING' },
      ),
    ).toEqual(['all_finished'])
  })
  it('v1 配置升级保留旧引用、规则与维护提醒，不授予 Target 或改写原文档', () => {
    const { notifications: _notifications, ...base } = structuredClone(FACTORY_PLATFORM_CONFIG)
    const old = {
      ...base,
      schemaVersion: 1,
      alerting: {
        ...FACTORY_ALERTING,
        channels: [
          {
            id,
            name: '旧告警',
            kind: 'webhook',
            enabled: true,
            urlHost: 'hooks.example.test',
            secretRef: { provider: 'local-aes-gcm', secretId: id },
          },
        ],
      },
    }
    // Use the project's provider identity, not an endpoint or secret embedded in the document.
    old.alerting.channels[0]!.secretRef.provider = 'local'
    const before = JSON.stringify(old)
    const upgraded = upgradePlatformConfigDocument(old)
    expect(upgraded.notifications.channels[0]).toMatchObject({
      id,
      format: 'legacy_alert@1',
      targetIds: [],
      allowAlerts: true,
    })
    expect(upgraded.alerting.credentialMaintenance).toEqual(old.alerting.credentialMaintenance)
    expect(upgraded.notifications.channels[0]?.secretRef).toEqual(
      old.alerting.channels[0]?.secretRef,
    )
    expect(JSON.stringify(old)).toBe(before)
    expect(upgraded.alerting).not.toHaveProperty('channels')
  })
  it('白名单载荷拒绝原始输入与 HTML/AI 上下文额外字段', () => {
    expect(
      notificationPayloadSchema.safeParse({ title: '结果', input: { password: 'secret' } }).success,
    ).toBe(false)
    expect(notificationPayloadSchema.safeParse({ title: '结果', status: 'RUNNING' }).success).toBe(
      false,
    )
    expect(notificationPayloadSchema.safeParse({ title: 'a'.repeat(257) }).success).toBe(false)
  })
  it('渠道拒绝重复授权、邮件地址注入和 Token Header 注入', () => {
    const base = {
      expectedRevision: 1,
      reason: '配置',
      name: '消息',
      kind: 'email',
      enabled: true,
      allowAlerts: false,
      targetIds: [id],
      format: 'cairn.notification@1',
      replay: 'manual_on_unknown',
    }
    expect(notificationChannelWriteSchema.safeParse({ ...base, targetIds: [id, id] }).success).toBe(
      false,
    )
    expect(
      notificationChannelWriteSchema.safeParse({
        ...base,
        emails: ['ok@example.com\r\nBcc:another@example.com'],
      }).success,
    ).toBe(false)
    expect(
      notificationChannelWriteSchema.safeParse({
        ...base,
        kind: 'webhook',
        token: 'x\r\nAnother:header',
      }).success,
    ).toBe(false)
  })
})
