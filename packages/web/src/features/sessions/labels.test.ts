import { describe, expect, it } from 'vitest'
import { groupSessionEventsByActivity, resolveSessionEvent, sessionEventLabel } from './labels'

function event(
  overrides: Partial<{
    id: string
    type: string
    payload: Record<string, unknown>
    createdAt: string
    operationId: string | null
  }>,
) {
  return {
    id: overrides.id ?? 'e',
    type: overrides.type ?? 'operation.requested',
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? '2026-09-21T04:00:00.000Z',
    operationId: overrides.operationId ?? 'op-1',
  }
}

describe('groupSessionEventsByActivity', () => {
  it('检查登录失败若只落下 auth.unknown，也显示失败而不是执行中', () => {
    const [group] = groupSessionEventsByActivity([
      event({
        id: 'e1',
        type: 'operation.requested',
        payload: { kind: 'VERIFY_AUTH' },
        createdAt: '2026-09-21T04:00:00.000Z',
      }),
      event({
        id: 'e2',
        type: 'operation.claimed',
        payload: { kind: 'VERIFY_AUTH' },
        createdAt: '2026-09-21T04:00:01.000Z',
      }),
      event({
        id: 'e3',
        type: 'auth.unknown',
        payload: { status: 'FAILED', errorCode: 'SESSION_AUTH_UNSUPPORTED' },
        createdAt: '2026-09-21T04:00:02.000Z',
      }),
    ])
    expect(group.title).toBe('检查登录')
    expect(group.status).toBe('FAILED')
    expect(group.statusLabel).toBe('失败')
  })

  it('登录等待后被取消，显示已取消', () => {
    const [group] = groupSessionEventsByActivity([
      event({
        id: 'e1',
        type: 'operation.requested',
        payload: { kind: 'LOGIN' },
        createdAt: '2026-09-21T04:01:00.000Z',
      }),
      event({
        id: 'e2',
        type: 'operation.claimed',
        payload: { kind: 'LOGIN' },
        createdAt: '2026-09-21T04:01:01.000Z',
      }),
      event({
        id: 'e3',
        type: 'operation.waiting_for_auth',
        payload: { kind: 'LOGIN' },
        createdAt: '2026-09-21T04:01:02.000Z',
      }),
      event({
        id: 'e4',
        type: 'operation.cancelled',
        payload: { kind: 'LOGIN' },
        createdAt: '2026-09-21T04:01:10.000Z',
      }),
    ])
    expect(group.title).toBe('登录')
    expect(group.status).toBe('CANCELLED')
    expect(group.statusLabel).toBe('已取消')
  })

  it('维护收尾同时有认证结论和 operation.finished 时以操作终态为准', () => {
    const [group] = groupSessionEventsByActivity([
      event({
        id: 'e1',
        type: 'operation.requested',
        payload: { kind: 'VERIFY_AUTH' },
        createdAt: '2026-09-21T04:02:00.000Z',
      }),
      event({
        id: 'e2',
        type: 'auth.unknown',
        payload: { status: 'FAILED', errorCode: 'SESSION_AUTH_UNSUPPORTED' },
        createdAt: '2026-09-21T04:02:02.000Z',
      }),
      event({
        id: 'e3',
        type: 'operation.finished',
        payload: { status: 'FAILED', errorCode: 'SESSION_AUTH_UNSUPPORTED' },
        createdAt: '2026-09-21T04:02:03.000Z',
      }),
    ])
    expect(group.status).toBe('FAILED')
    expect(group.statusLabel).toBe('失败')
  })

  it('准备失败且登录页打不开时用可读原因，不用内部码', () => {
    expect(
      resolveSessionEvent('operation.finished', {
        kind: 'PREPARE',
        status: 'FAILED',
        errorCode: 'LOGIN_PAGE_UNREACHABLE',
      }).summary,
    ).toBe('目标登录页打不开')
  })

  it('等待登录页打不开时用可读原因，不用内部码', () => {
    const [group] = groupSessionEventsByActivity([
      event({
        id: 'e1',
        type: 'operation.requested',
        payload: { kind: 'PREPARE' },
        createdAt: '2026-09-21T04:03:00.000Z',
      }),
      event({
        id: 'e2',
        type: 'operation.waiting_for_auth',
        payload: { kind: 'PREPARE', reason: 'LOGIN_PAGE_UNREACHABLE' },
        createdAt: '2026-09-21T04:03:02.000Z',
      }),
    ])
    expect(group.statusLabel).toBe('登录页打不开')
    expect(sessionEventLabel('operation.waiting_for_auth', { kind: 'PREPARE', reason: 'LOGIN_PAGE_UNREACHABLE' })).toBe(
      '准备会话 · 登录页打不开',
    )
    expect(resolveSessionEvent('operation.waiting_for_auth', { kind: 'PREPARE', reason: 'LOGIN_PAGE_UNREACHABLE' }).summary).toBe(
      '目标登录页打不开',
    )
  })

  it('整理页面事件写清残余层', () => {
    expect(sessionEventLabel('auth.landing_settled', { residualOverlay: false })).toBe('已整理落地页')
    expect(resolveSessionEvent('auth.landing_settled', { residualOverlay: true }).stage).toBe(
      '仍有未关掉的层',
    )
    expect(resolveSessionEvent('operation.requested', { kind: 'SETTLE_LANDING' }).title).toBe(
      '整理页面',
    )
  })

  it('登录过程中到达登录页不是登出', () => {
    expect(sessionEventLabel('auth.signal_observed', { kind: 'navigated_to_login' })).toBe('到达登录页')
    expect(resolveSessionEvent('auth.signal_observed', { kind: 'navigated_to_login' }).title).toBe(
      '到达登录页',
    )
    expect(resolveSessionEvent('auth.signal_observed', { kind: 'navigated_to_login' }).tone).toBe('info')
  })

  it('错密等待登录时用可读原因，不说看不到表单', () => {
    expect(sessionEventLabel('operation.waiting_for_auth', { kind: 'LOGIN', reason: 'credential' })).toBe(
      '登录 · 账号或密码不正确',
    )
    expect(resolveSessionEvent('operation.waiting_for_auth', { kind: 'LOGIN', reason: 'credential' }).summary).toBe(
      '账号或密码未通过核验',
    )
  })
})
