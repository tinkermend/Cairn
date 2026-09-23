import { describe, expect, it } from 'vitest'
import type { AccountSessionDetail } from '@cairn/shared'
import {
  classifyStudioSessionConnect,
  deriveSessionPreparationStage,
  formatOperationTimeout,
  resolveLatestEventSummary,
  resolveStudioConnectAction,
  studioDisconnectedCopy,
} from './studio-connect'

const base = {
  session: null,
  currentOperation: null,
  lastAuthError: null,
} as AccountSessionDetail

describe('studioDisconnectedCopy', () => {
  it('准备中说明正在打开浏览器', () => {
    expect(studioDisconnectedCopy({ connecting: true }).title).toBe('正在准备会话')
  })

  it('上次登录页打不开时直接说出原因', () => {
    const copy = studioDisconnectedCopy({ connecting: false, lastAuthError: 'LOGIN_PAGE_UNREACHABLE' })
    expect(copy.body).toContain('目标登录页打不开')
    expect(copy.body).toContain('浏览器页')
  })
})

describe('classifyStudioSessionConnect', () => {
  it('会话已打开即可指认', () => {
    expect(
      classifyStudioSessionConnect({
        ...base,
        session: { status: 'OPEN' },
      } as AccountSessionDetail),
    ).toBe('open')
  })

  it('进入 WAITING_FOR_AUTH 阶段准确识别为 waiting_for_auth', () => {
    expect(
      classifyStudioSessionConnect({
        ...base,
        currentOperation: { id: 'op-1', kind: 'PREPARE', status: 'WAITING_FOR_AUTH', reusedRunId: null },
      } as AccountSessionDetail),
    ).toBe('waiting_for_auth')
  })

  it('当前这次准备失败才算失败，不拿上次失败当这次结果', () => {
    expect(
      classifyStudioSessionConnect(
        {
          ...base,
          currentOperation: { id: 'old', kind: 'PREPARE', status: 'FAILED', reusedRunId: null },
        } as AccountSessionDetail,
        'new',
      ),
    ).toBe('pending')
    expect(
      classifyStudioSessionConnect(
        {
          ...base,
          lastAuthError: 'LOGIN_PAGE_UNREACHABLE',
          currentOperation: { id: 'new', kind: 'PREPARE', status: 'FAILED', reusedRunId: null },
        } as AccountSessionDetail,
        'new',
      ),
    ).toBe('failed')
  })

  it('当后端 currentOperation 已清空为 null 时，通过 activeOperation 判定失败', () => {
    expect(
      classifyStudioSessionConnect(
        { ...base, currentOperation: null } as AccountSessionDetail,
        'op-failed',
        { id: 'op-failed', status: 'FAILED', errorCode: 'SESSION_NOT_CLAIMABLE' },
      ),
    ).toBe('failed')
  })
})

describe('deriveSessionPreparationStage', () => {
  it('会话已打开时处于 ready 阶段', () => {
    const stage = deriveSessionPreparationStage({ sessionOpen: true })
    expect(stage.currentStage).toBe('ready')
    expect(stage.stepIndex).toBe(3)
    expect(stage.statusTone).toBe('success')
  })

  it('排队状态正确映射到 stepIndex 0', () => {
    const stage = deriveSessionPreparationStage({ operationStatus: 'QUEUED' })
    expect(stage.currentStage).toBe('queued')
    expect(stage.stepIndex).toBe(0)
    expect(stage.title).toContain('排队')
  })

  it('运行中且包含自动登录事件时映射到 authenticating 阶段', () => {
    const stage = deriveSessionPreparationStage({
      operationStatus: 'RUNNING',
      events: [{ type: 'auth.attempt_started' }],
    })
    expect(stage.currentStage).toBe('authenticating')
    expect(stage.stepIndex).toBe(2)
    expect(stage.title).toBe('正在尝试自动登录')
  })

  it('运行中且包含落地页整理事件时映射到 authenticating 阶段并显示整理文案', () => {
    const stage = deriveSessionPreparationStage({
      operationStatus: 'RUNNING',
      events: [{ type: 'auth.landing_settled' }],
    })
    expect(stage.currentStage).toBe('authenticating')
    expect(stage.stepIndex).toBe(2)
    expect(stage.title).toBe('正在整理落地页')
  })

  it('等待人工验证时映射到 authenticating 阶段且 tone 为 warning', () => {
    const stage = deriveSessionPreparationStage({
      operationStatus: 'WAITING_FOR_AUTH',
      lastAuthError: 'CAPTCHA_REQUIRED',
    })
    expect(stage.currentStage).toBe('authenticating')
    expect(stage.stepIndex).toBe(2)
    expect(stage.statusTone).toBe('warning')
    expect(stage.title).toBe('等待人工完成验证')
  })

  it('拉起浏览器失败时定位在启动环境阶段并展示中文释义', () => {
    const stage = deriveSessionPreparationStage({
      operationStatus: 'FAILED',
      errorCode: 'SESSION_NOT_CLAIMABLE',
      events: [{ type: 'operation.claimed' }],
    })
    expect(stage.currentStage).toBe('launching')
    expect(stage.stageBadge).toBe('准备失败')
    expect(stage.stepIndex).toBe(1)
    expect(stage.failedStepIndex).toBe(1)
    expect(stage.title).toBe('会话准备失败')
    expect(stage.detail).toContain('执行节点会话资源不可用')
    expect(stage.detail).toContain('SESSION_NOT_CLAIMABLE')
    expect(stage.statusTone).toBe('error')
  })

  it('自动登录阶段失败时定位在自动登录步骤', () => {
    const stage = deriveSessionPreparationStage({
      operationStatus: 'FAILED',
      errorCode: 'credential',
      events: [{ type: 'auth.attempt_started' }],
    })
    expect(stage.currentStage).toBe('authenticating')
    expect(stage.stepIndex).toBe(2)
    expect(stage.failedStepIndex).toBe(2)
    expect(stage.detail).toContain('账号或密码未通过核验')
  })
})

describe('resolveLatestEventSummary', () => {
  it('正确解析各种业务事件的简要描述', () => {
    expect(resolveLatestEventSummary([{ type: 'auth.attempt_started' }])).toBe('开始尝试自动登录')
    expect(
      resolveLatestEventSummary([{ type: 'auth.signal_observed', payload: { kind: 'login_form_visible' } }]),
    ).toBe('已检测到登录表单输入框')
    expect(
      resolveLatestEventSummary([
        {
          type: 'operation.finished',
          payload: { status: 'FAILED', errorCode: 'SESSION_NOT_CLAIMABLE' },
        },
      ]),
    ).toContain('执行节点会话资源不可用')
    expect(
      resolveLatestEventSummary([
        {
          type: 'operation.finished',
          payload: { status: 'CANCELLED' },
        },
      ]),
    ).toBe('会话准备任务已取消')
    expect(
      resolveLatestEventSummary([
        {
          type: 'operation.finished',
          payload: { status: 'SUCCEEDED' },
        },
      ]),
    ).toBe('会话准备任务已执行完成')
    expect(resolveLatestEventSummary([])).toBeNull()
  })
})

describe('formatOperationTimeout', () => {
  it('QUEUED 状态下根据 queueDeadlineAt 计算剩余排队倒计时', () => {
    const now = 1700000000000
    const deadline = new Date(now + 150000).toISOString() // 2分30秒后
    const timeout = formatOperationTimeout({
      status: 'QUEUED',
      queueDeadlineAt: deadline,
      nowMs: now,
    })
    expect(timeout.type).toBe('queue')
    expect(timeout.remainingSeconds).toBe(150)
    expect(timeout.hint).toContain('2分30秒')
  })

  it('RUNNING 状态下计算耗时与上限', () => {
    const now = 1700000000000
    const created = new Date(now - 12000).toISOString() // 12秒前
    const timeout = formatOperationTimeout({
      status: 'RUNNING',
      createdAt: created,
      nowMs: now,
      defaultLoginTimeoutSeconds: 60,
    })
    expect(timeout.type).toBe('running')
    expect(timeout.elapsedSeconds).toBe(12)
    expect(timeout.hint).toContain('10~30 秒')
  })

  it('FAILED 状态下返回任务终止与耗时信息', () => {
    const now = 1700000000000
    const created = new Date(now - 15000).toISOString()
    const timeout = formatOperationTimeout({
      status: 'FAILED',
      createdAt: created,
      nowMs: now,
    })
    expect(timeout.hint).toBe('任务已终止（耗时 15 秒）')
  })

  it('CANCELLED 状态下返回用户取消信息', () => {
    const timeout = formatOperationTimeout({
      status: 'CANCELLED',
    })
    expect(timeout.hint).toBe('准备已由用户取消')
  })

  it('createdAt 为非法字符时防御性处理不产生 NaN', () => {
    const timeout = formatOperationTimeout({
      status: 'RUNNING',
      createdAt: 'invalid-date',
      defaultLoginTimeoutSeconds: 60,
    })
    expect(Number.isFinite(timeout.elapsedSeconds)).toBe(true)
    expect(timeout.hint).not.toContain('NaN')
  })
})

describe('边界防护与历史状态隔离', () => {
  it('pendingOperationId 为 null 且后端 currentOperation 为 null 时，不误选失效的 activeOperation', () => {
    expect(
      classifyStudioSessionConnect(
        { session: { status: 'CLOSED' }, currentOperation: null } as any,
        null,
        { id: 'stale-op', status: 'FAILED' },
      ),
    ).toBe('pending')
  })

  it('接口调用失败（prepareFailed 为 true 且携带 errorMessage）时在排队阶段报错', () => {
    const stage = deriveSessionPreparationStage({
      prepareFailed: true,
      errorMessage: '网络连接超时，请检查网络',
    })
    expect(stage.currentStage).toBe('queued')
    expect(stage.failedStepIndex).toBe(0)
    expect(stage.title).toBe('会话准备失败')
    expect(stage.detail).toBe('网络连接超时，请检查网络')
    expect(stage.statusTone).toBe('error')
  })

  it('未开跑时即使历史包含 landing 事件，也不会被误标为「正在整理落地页」', () => {
    const stage = deriveSessionPreparationStage({
      operationStatus: 'QUEUED',
      events: [{ type: 'auth.landing_settled' }],
    })
    expect(stage.currentStage).toBe('queued')
    expect(stage.stepIndex).toBe(0)
    expect(stage.title).toContain('排队')
  })

  it('resolveLatestEventSummary 仅解析归属当前 operation 的事件', () => {
    const events = [
      {
        type: 'operation.finished',
        operationId: 'old-op',
        payload: { status: 'FAILED', errorCode: 'SESSION_NOT_CLAIMABLE' },
      },
      {
        type: 'operation.claimed',
        operationId: 'new-op',
        payload: {},
      },
    ]
    // 过滤到当前 new-op 时，不显示 old-op 的失败事件
    expect(resolveLatestEventSummary(events, 'new-op')).toBe('执行节点已认领任务，正在拉起浏览器')
  })
})

describe('resolveStudioConnectAction', () => {
  it('无活跃会话时推荐 PREPARE', () => {
    const action = resolveStudioConnectAction({ sessionDetail: null })
    expect(action.kind).toBe('PREPARE')
    expect(action.label).toBe('连接会话')
  })

  it('会话状态为 unprepared 时推荐 PREPARE', () => {
    const action = resolveStudioConnectAction({
      sessionDetail: { session: null, status: 'unprepared' } as any,
    })
    expect(action.kind).toBe('PREPARE')
  })

  it('已有存活实例但处于 needs_login 时推荐 LOGIN 登录', () => {
    const action = resolveStudioConnectAction({
      sessionDetail: {
        session: { id: 's-1', status: 'OPEN' },
        status: 'needs_login',
      } as any,
    })
    expect(action.kind).toBe('LOGIN')
    expect(action.label).toBe('登录会话')
  })

  it('发生操作冲突 SESSION_OPERATION_CONFLICT 失败时推荐 RESTART 重建会话', () => {
    const action = resolveStudioConnectAction({
      sessionDetail: {
        session: { id: 's-1', status: 'OPEN' },
        status: 'maintenance',
        currentOperation: { id: 'op-1', status: 'FAILED', errorCode: 'SESSION_OPERATION_CONFLICT' },
      } as any,
      isFailed: true,
      activeOpErrorCode: 'SESSION_OPERATION_CONFLICT',
    })
    expect(action.kind).toBe('RESTART')
    expect(action.label).toBe('重建会话')
  })

  it('会话失联 lost 且失败时推荐 RESTART', () => {
    const action = resolveStudioConnectAction({
      sessionDetail: {
        session: { id: 's-1', status: 'OPEN' },
        status: 'lost',
      } as any,
      isFailed: true,
    })
    expect(action.kind).toBe('RESTART')
  })

  it('常规准备失败后重试推荐 RESTART 重新启动', () => {
    const action = resolveStudioConnectAction({
      sessionDetail: {
        session: { id: 's-1', status: 'OPEN' },
        status: 'ready',
      } as any,
      isFailed: true,
    })
    expect(action.kind).toBe('RESTART')
    expect(action.label).toBe('再试一次')
  })
})
