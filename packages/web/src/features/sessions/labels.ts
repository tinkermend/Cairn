import type { AccountSessionStatus, SessionOverviewFilter, SessionSystemOverviewFilter } from '@cairn/shared'

export const ACCOUNT_SESSION_STATUS_LABELS: Record<AccountSessionStatus, string> = {
  unprepared: '未准备',
  ready: '就绪',
  needs_check: '待检查',
  needs_login: '需要登录',
  identity_mismatch: '账号不符',
  maintenance: '维护中',
  executing: '执行中',
  lost: '失联',
}

export const ACCOUNT_SESSION_STATUS_TONE: Record<
  AccountSessionStatus,
  'neutral' | 'success' | 'warning' | 'info'
> = {
  unprepared: 'neutral',
  ready: 'success',
  needs_check: 'info',
  needs_login: 'warning',
  identity_mismatch: 'warning',
  maintenance: 'info',
  executing: 'info',
  lost: 'warning',
}

export const SESSION_SYSTEM_FILTER_LABELS: Record<SessionSystemOverviewFilter | 'all', string> = {
  all: '全部',
  problem: '有问题',
  unprepared: '未准备',
  ready: '已就绪',
  busy: '占用中',
  retained: '保留中',
}

export const SESSION_FILTER_LABELS: Record<SessionOverviewFilter | 'all', string> = {
  all: '全部',
  available: '可用',
  needs_check: '待检查',
  needs_login: '需要登录',
  identity_mismatch: '账号不符',
  maintenance: '维护中',
  executing: '执行中',
  lost: '失联',
  unprepared: '未准备',
  retained: '保留中',
}

export const PRIMARY_ACTION_LABELS: Record<string, string> = {
  PREPARE: '准备会话',
  VERIFY_AUTH: '检查登录',
  LOGIN: '登录',
  RENEW_AUTH: '续登',
  view: '查看',
  dispose: '处置失联',
}

export const OPERATION_KIND_LABELS: Record<string, string> = {
  VALIDATE_AUTH_PROFILE: '验收认证规则',
  PREPARE: '准备会话',
  VERIFY_AUTH: '检查登录',
  LOGIN: '登录',
  RENEW_AUTH: '续登',
  REFRESH_LOGIN_PAGE: '刷新登录页',
  CLOSE: '关闭会话',
  RESTART: '重启会话',
  RESET_PROFILE: '清除登录数据',
}

export function sessionAuthLabel(authState?: string | null, identityState?: string | null) {
  const auth: Record<string, string> = { AUTHENTICATED: '登录已核验', EXPIRED: '登录已失效', UNKNOWN: '登录待核验' }
  const identity: Record<string, string> = { MATCH: '账号一致', MISMATCH: '账号不符', UNVERIFIED: '身份未核验' }
  return [auth[authState ?? 'UNKNOWN'] ?? '登录待核验', identityState ? identity[identityState] : null].filter(Boolean).join(' · ')
}

export function sessionOverviewAuthLabel(
  status: AccountSessionStatus,
  authState?: string | null,
  identityState?: string | null,
) {
  if (status === 'unprepared') return '尚未准备'
  return sessionAuthLabel(authState, identityState)
}

export function sessionOccupancyLabel(item: {
  occupyingRunId: string | null
  occupyingOperationId: string | null
}) {
  if (item.occupyingRunId) return '运行占用'
  if (item.occupyingOperationId) return '维护占用'
  return '—'
}

export function sessionEventLabel(type: string, payload: Record<string, unknown>) {
  const labels: Record<string, string> = {
    'operation.requested': '已提交', 'operation.claimed': '开始执行',
    'operation.waiting_for_auth': '等待人工认证', 'operation.finished': '已结束', 'operation.cancelled': '已取消',
    'retention.set': '已设置保留', 'retention.extended': '已延长保留', 'retention.cleared': '已取消保留',
    'session.closed': '会话已关闭', 'session.restarted': '会话已重启', 'session.lost': '会话已失联',
    'profile.reset': '登录数据已清除', 'auth.control_changed': '认证控制权已变更',
    'auth.attempt_started': '开始登录', 'auth.verified': '登录核验完成', 'auth.unknown': '登录状态待确认',
    'auth.signal_observed': '观察到登出信号', 'session.keepalive_extended': '已续期保活',
    'session.evicted': '因容量被驱逐',
  }
  const status: Record<string, string> = { SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消' }
  const label = type === 'operation.finished' ? status[String(payload.status)] ?? labels[type] : labels[type]
  const kind = OPERATION_KIND_LABELS[String(payload.kind)]
  return [kind, label ?? '会话状态已更新'].filter(Boolean).join(' · ')
}

export interface ResolvedSessionEvent {
  id?: string
  seq?: number
  createdAt?: string
  type: string
  title: string
  stage?: string
  tone: 'neutral' | 'success' | 'warning' | 'destructive' | 'info'
  summary?: string
  origin?: 'USER' | 'BACKGROUND' | null
  runId?: string | null
  operationId?: string | null
  payload: Record<string, unknown>
}

const EVENT_TYPE_TITLES: Record<string, string> = {
  'auth.signal_observed': '检测到认证信号',
  'auth.attempt_started': '尝试自动登录',
  'auth.verified': '登录核验通过',
  'auth.unknown': '登录状态待确认',
  'auth.control_changed': '控制权变更',
  'retention.set': '设置会话保留',
  'retention.extended': '延长会话保留',
  'retention.cleared': '取消会话保留',
  'session.closed': '关闭会话',
  'session.restarted': '重启会话',
  'session.lost': '会话失联',
  'session.keepalive_extended': '保活巡检续期',
  'session.evicted': '容量驱逐',
  'profile.reset': '清除登录数据',
}

export function resolveSessionEvent(
  type: string,
  payload: Record<string, unknown>,
  extra?: { id?: string; seq?: number; createdAt?: string; runId?: string | null; operationId?: string | null },
): ResolvedSessionEvent {
  const opKind = typeof payload.kind === 'string' ? OPERATION_KIND_LABELS[payload.kind] : undefined
  const status = typeof payload.status === 'string' ? payload.status : undefined
  const origin = payload.origin === 'BACKGROUND' || payload.origin === 'USER' ? payload.origin : null

  let title = opKind ?? EVENT_TYPE_TITLES[type] ?? '会话事件'
  let stage: string | undefined
  let tone: ResolvedSessionEvent['tone'] = 'neutral'
  let summary: string | undefined

  if (typeof payload.summary === 'string' && payload.summary.trim()) {
    summary = payload.summary.trim()
  }

  if (type === 'auth.signal_observed') {
    title = '观察到登出信号'
    tone = 'warning'
    if (!summary && typeof payload.kind === 'string') {
      summary = `信号类型: ${payload.kind}`
    }
  } else if (type === 'auth.attempt_started') {
    stage = '开始尝试登录'
    tone = 'info'
  } else if (type === 'auth.verified') {
    stage = '登录核验完成'
    tone = 'success'
  } else if (type === 'auth.unknown') {
    stage = '登录状态待确认'
    tone = 'warning'
  } else if (type === 'operation.requested') {
    stage = '已提交'
    tone = 'info'
  } else if (type === 'operation.claimed') {
    stage = '开始执行'
    tone = 'info'
  } else if (type === 'operation.waiting_for_auth') {
    stage = '等待人工认证'
    tone = 'warning'
  } else if (type === 'operation.finished') {
    if (status === 'SUCCEEDED') {
      stage = '已完成'
      tone = 'success'
    } else if (status === 'FAILED') {
      stage = '执行失败'
      tone = 'destructive'
      const err = typeof payload.errorCode === 'string' ? payload.errorCode : undefined
      if (err) {
        summary = err
      }
    } else if (status === 'CANCELLED') {
      stage = '已取消'
      tone = 'neutral'
    }
  } else if (type === 'operation.cancelled') {
    stage = '已取消'
    tone = 'neutral'
  } else if (type.startsWith('retention.')) {
    tone = type === 'retention.cleared' ? 'neutral' : 'info'
    stage = type === 'retention.set' ? '已设置' : type === 'retention.extended' ? '已延长' : '已取消'
    if (typeof payload.retainSeconds === 'number') {
      const minutes = Math.round(payload.retainSeconds / 60)
      summary = minutes >= 60 ? `保留时长: ${(minutes / 60).toFixed(1)} 小时` : `保留时长: ${minutes} 分钟`
    }
    if (typeof payload.reason === 'string' && payload.reason) {
      summary = summary ? `${summary} (${payload.reason})` : payload.reason
    }
  } else if (type === 'session.lost') {
    stage = '实例失联'
    tone = 'destructive'
  } else if (type === 'session.evicted') {
    stage = '因容量被驱逐'
    tone = 'warning'
    if (typeof payload.reason === 'string') summary = payload.reason
  } else if (type === 'session.restarted') {
    stage = '会话已重启'
    tone = 'info'
    if (typeof payload.predecessorSessionId === 'string') {
      summary = `前代实例: ${payload.predecessorSessionId.slice(0, 8)}...`
    }
  } else if (type === 'session.closed') {
    stage = '会话已关闭'
    tone = 'neutral'
  } else if (type === 'profile.reset') {
    stage = '登录数据已清除'
    tone = 'warning'
  } else if (type === 'session.keepalive_extended') {
    stage = '已续期保活'
    tone = 'neutral'
  }

  return {
    id: extra?.id,
    seq: extra?.seq,
    createdAt: extra?.createdAt,
    type,
    title,
    stage,
    tone,
    summary,
    origin,
    runId: extra?.runId,
    operationId: extra?.operationId,
    payload,
  }
}

export interface AggregatedEventGroup<T extends { type: string; payload: Record<string, unknown>; createdAt: string }> {
  primary: T
  count: number
  items: T[]
  timeRange: { start: string; end: string }
}

export function aggregateSessionEvents<
  T extends { id?: string; type: string; payload: Record<string, unknown>; createdAt: string; runId?: string | null },
>(events: T[]): AggregatedEventGroup<T>[] {
  const groups: AggregatedEventGroup<T>[] = []

  for (const event of events) {
    const lastGroup = groups[groups.length - 1]
    const canAggregate =
      event.type === 'auth.signal_observed' ||
      event.type === 'session.keepalive_extended'

    if (
      lastGroup &&
      canAggregate &&
      lastGroup.primary.type === event.type &&
      lastGroup.primary.runId === event.runId
    ) {
      lastGroup.count += 1
      lastGroup.items.push(event)
      lastGroup.timeRange.start = event.createdAt
    } else {
      groups.push({
        primary: event,
        count: 1,
        items: [event],
        timeRange: { start: event.createdAt, end: event.createdAt },
      })
    }
  }

  return groups
}

export interface SessionOperationStep {
  id: string
  seq?: number
  type: string
  title: string
  stage?: string
  tone: 'neutral' | 'success' | 'warning' | 'destructive' | 'info'
  summary?: string
  createdAt: string
  origin?: 'USER' | 'BACKGROUND' | null
  runId?: string | null
  operationId?: string | null
  count: number
  items: any[]
}

export interface SessionActivityGroup {
  id: string
  title: string
  subtitle?: string
  status: 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'WAITING_FOR_AUTH' | 'CANCELLED' | 'UNKNOWN'
  statusLabel: string
  tone: 'success' | 'warning' | 'destructive' | 'info' | 'neutral'
  origin?: 'USER' | 'BACKGROUND' | null
  startedAt: string
  endedAt: string
  durationText?: string
  operationId?: string | null
  runId?: string | null
  steps: SessionOperationStep[]
}

export function groupSessionEventsByActivity<
  T extends {
    id: string
    seq?: number
    type: string
    payload: Record<string, unknown>
    createdAt: string
    operationId?: string | null
    runId?: string | null
  },
>(events: T[]): SessionActivityGroup[] {
  if (events.length === 0) return []

  const chronological = [...events].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )

  const rawGroups: T[][] = []
  let currentGroup: T[] = []

  for (let i = 0; i < chronological.length; i++) {
    const event = chronological[i]
    const prev = currentGroup[currentGroup.length - 1]

    const isNewOpRequest = event.type === 'operation.requested'
    const opChanged =
      Boolean(event.operationId) &&
      Boolean(prev?.operationId) &&
      event.operationId !== prev?.operationId

    const isTimeGap =
      prev &&
      new Date(event.createdAt).getTime() - new Date(prev.createdAt).getTime() > 45_000

    const prevFinished =
      prev &&
      (prev.type === 'operation.finished' ||
        prev.type === 'auth.verified' ||
        prev.type === 'session.closed') &&
      event.type !== 'auth.verified'

    if (currentGroup.length > 0 && (isNewOpRequest || opChanged || (prevFinished && isTimeGap))) {
      rawGroups.push(currentGroup)
      currentGroup = [event]
    } else {
      currentGroup.push(event)
    }
  }

  if (currentGroup.length > 0) {
    rawGroups.push(currentGroup)
  }

  const groups: SessionActivityGroup[] = rawGroups.map((groupEvents) => {
    const steps: SessionOperationStep[] = []
    for (const evt of groupEvents) {
      const lastStep = steps[steps.length - 1]
      const canAggregate =
        evt.type === 'auth.signal_observed' ||
        evt.type === 'session.keepalive_extended'

      if (lastStep && canAggregate && lastStep.type === evt.type && lastStep.runId === evt.runId) {
        lastStep.count += 1
        lastStep.items.push(evt)
      } else {
        const resolved = resolveSessionEvent(evt.type, evt.payload, evt)
        steps.push({
          id: evt.id,
          seq: evt.seq,
          type: evt.type,
          title: resolved.title,
          stage: resolved.stage,
          tone: resolved.tone,
          summary: resolved.summary,
          createdAt: evt.createdAt,
          origin: resolved.origin,
          runId: evt.runId,
          operationId: evt.operationId,
          count: 1,
          items: [evt],
        })
      }
    }

    const firstEvt = groupEvents[0]
    const lastEvt = groupEvents[groupEvents.length - 1]
    const startedAt = firstEvt.createdAt
    const endedAt = lastEvt.createdAt
    const startMs = new Date(startedAt).getTime()
    const endMs = new Date(endedAt).getTime()
    const diffSeconds = Math.round(Math.max(0, endMs - startMs) / 1000)

    let durationText: string | undefined
    if (diffSeconds > 0) {
      durationText = diffSeconds >= 60 ? `${Math.floor(diffSeconds / 60)}分${diffSeconds % 60}秒` : `${diffSeconds}秒`
    } else if (groupEvents.length > 1) {
      durationText = '< 1秒'
    }

    const reqEvt = groupEvents.find((e) => e.type === 'operation.requested')
    const finishEvt = groupEvents.find((e) => e.type === 'operation.finished')
    const verifiedEvt = groupEvents.find((e) => e.type === 'auth.verified')
    const waitingEvt = groupEvents.find((e) => e.type === 'operation.waiting_for_auth')

    let title = '会话活动'
    if (reqEvt && typeof reqEvt.payload.kind === 'string') {
      title = OPERATION_KIND_LABELS[reqEvt.payload.kind] ?? reqEvt.payload.kind
    } else {
      const anyKindEvt = groupEvents.find((e) => typeof e.payload.kind === 'string')
      if (anyKindEvt && OPERATION_KIND_LABELS[String(anyKindEvt.payload.kind)]) {
        title = OPERATION_KIND_LABELS[String(anyKindEvt.payload.kind)]
      } else if (groupEvents.some((e) => e.type.startsWith('retention.'))) {
        title = '会话保留更新'
      } else if (groupEvents.some((e) => e.type === 'auth.signal_observed')) {
        title = '认证状态监测'
      } else if (groupEvents.some((e) => e.type === 'session.keepalive_extended')) {
        title = '后台保活巡检'
      }
    }

    let status: SessionActivityGroup['status'] = 'UNKNOWN'
    let statusLabel = '进行中'
    let tone: SessionActivityGroup['tone'] = 'neutral'

    if (finishEvt) {
      const s = String(finishEvt.payload.status)
      if (s === 'SUCCEEDED') {
        status = 'SUCCEEDED'
        statusLabel = '已完成'
        tone = 'success'
      } else if (s === 'FAILED') {
        status = 'FAILED'
        statusLabel = '失败'
        tone = 'destructive'
      } else if (s === 'CANCELLED') {
        status = 'CANCELLED'
        statusLabel = '已取消'
        tone = 'neutral'
      }
    } else if (waitingEvt) {
      status = 'WAITING_FOR_AUTH'
      statusLabel = '等待人工认证'
      tone = 'warning'
    } else if (verifiedEvt) {
      status = 'SUCCEEDED'
      statusLabel = '核验完成'
      tone = 'success'
    } else if (groupEvents.some((e) => e.type === 'operation.claimed' || e.type === 'operation.requested')) {
      status = 'RUNNING'
      statusLabel = '执行中'
      tone = 'info'
    }

    const origin =
      reqEvt?.payload.origin === 'BACKGROUND' || groupEvents.some((e) => e.payload.origin === 'BACKGROUND')
        ? 'BACKGROUND'
        : reqEvt?.payload.origin === 'USER' || groupEvents.some((e) => e.payload.origin === 'USER')
          ? 'USER'
          : null

    const opId = groupEvents.find((e) => e.operationId)?.operationId ?? null
    const runId = groupEvents.find((e) => e.runId)?.runId ?? null

    return {
      id: opId ?? firstEvt.id,
      title,
      status,
      statusLabel,
      tone,
      origin,
      startedAt,
      endedAt,
      durationText,
      operationId: opId,
      runId,
      steps,
    }
  })

  return groups.reverse()
}


