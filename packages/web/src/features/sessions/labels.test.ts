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
  it('只有已提交、尚未领取时显示排队中而不是执行中', () => {
    const [group] = groupSessionEventsByActivity([
      event({ id: 'e1', type: 'operation.requested', payload: { kind: 'PREPARE', origin: 'USER' } }),
    ])
    expect(group.title).toBe('准备会话')
    expect(group.status).toBe('QUEUED')
    expect(group.statusLabel).toBe('排队中')
  })

  it('被 Worker 领取后显示执行中', () => {
    const [group] = groupSessionEventsByActivity([
      event({ id: 'e1', type: 'operation.requested', payload: { kind: 'PREPARE' } }),
      event({
        id: 'e2',
        type: 'operation.claimed',
        payload: { kind: 'PREPARE' },
        createdAt: '2026-09-21T04:00:01.000Z',
      }),
    ])
    expect(group.status).toBe('RUNNING')
    expect(group.statusLabel).toBe('执行中')
  })

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

  it('排队等待与过程事件有可读的阶段与摘要', () => {
    expect(
      resolveSessionEvent('operation.queue_waiting', {
        kind: 'PREPARE',
        waitReason: 'SESSION_ACCOUNT_AT_CAPACITY',
        detail: { lives: 1, cap: 1 },
      }),
    ).toMatchObject({ title: '准备会话', stage: '排队等待', tone: 'neutral', summary: '该账号并发会话已达上限（1/1），等待释放' })
    expect(resolveSessionEvent('operation.queue_waiting', { kind: 'PREPARE', waitReason: 'NO_ELIGIBLE_WORKER' }).tone).toBe(
      'warning',
    )
    expect(
      resolveSessionEvent('operation.progress', {
        kind: 'PREPARE',
        phase: 'session_acquired',
        detail: { acquireReason: 'created', accountSlot: 1, profileFallback: true },
      }),
    ).toMatchObject({ stage: '拿到会话', summary: '新建会话，第 1 个会话位 · 已从其他节点迁移登录资料' })
    expect(
      resolveSessionEvent('operation.progress', {
        kind: 'PREPARE',
        phase: 'auth_probed',
        durationMs: 800,
        detail: { authState: 'EXPIRED', via: 'page_heuristic' },
      }),
    ).toMatchObject({ stage: '检查登录状态', summary: '未登录 · 耗时 < 1秒' })
    expect(resolveSessionEvent('operation.claimed', { kind: 'PREPARE', workerId: 'local-worker' }).summary).toBe(
      '由执行节点 local-worker 领取',
    )
    expect(
      resolveSessionEvent('operation.finished', {
        kind: 'PREPARE',
        status: 'FAILED',
        errorCode: 'OPERATION_QUEUE_EXPIRED',
        waitReason: 'NO_ELIGIBLE_WORKER',
      }).summary,
    ).toBe('排队已超时：没有在线的执行节点，操作不会开始')
    expect(
      resolveSessionEvent('operation.finished', { kind: 'PREPARE', status: 'SUCCEEDED', queuedMs: 1200, durationMs: 26_000 })
        .summary,
    ).toBe('排队 1秒 · 执行 26秒')
  })

  it('分组耗时拆成排队与执行', () => {
    const [group] = groupSessionEventsByActivity([
      event({ id: 'e1', type: 'operation.requested', payload: { kind: 'PREPARE' }, createdAt: '2026-09-21T04:00:00.000Z' }),
      event({ id: 'e2', type: 'operation.claimed', payload: { kind: 'PREPARE' }, createdAt: '2026-09-21T04:00:05.000Z' }),
      event({
        id: 'e3',
        type: 'operation.finished',
        payload: { kind: 'PREPARE', status: 'SUCCEEDED' },
        createdAt: '2026-09-21T04:00:31.000Z',
      }),
    ])
    expect(group.durationText).toBe('排队 5秒 · 执行 26秒')
  })
})
