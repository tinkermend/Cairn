import { describeAuthIssue, type AccountSessionDetail } from '@cairn/shared'

export type StudioSessionConnectState = 'open' | 'failed' | 'waiting_for_auth' | 'pending'

export function classifyStudioSessionConnect(
  detail: AccountSessionDetail | undefined,
  pendingOperationId?: string | null,
  activeOperation?: { id?: string; status?: string; errorCode?: string | null } | null,
): StudioSessionConnectState {
  if (detail?.session?.status === 'OPEN') return 'open'
  const operation =
    pendingOperationId && activeOperation?.id === pendingOperationId
      ? activeOperation
      : detail?.currentOperation?.id && activeOperation?.id === detail.currentOperation.id
        ? activeOperation
        : detail?.currentOperation
  if (pendingOperationId && operation?.id && operation.id !== pendingOperationId) return 'pending'
  if (operation?.status === 'WAITING_FOR_AUTH') return 'waiting_for_auth'
  if (operation?.status === 'FAILED' || operation?.status === 'CANCELLED') return 'failed'
  return 'pending'
}

export function studioDisconnectedCopy(input: {
  connecting: boolean
  lastAuthError?: string | null
}): { title: string; body: string } {
  if (input.connecting) {
    return {
      title: '正在准备会话',
      body: '正在打开受管浏览器并尝试登录。目标系统打不开时会马上结束，不会空等。',
    }
  }
  const issue = describeAuthIssue(input.lastAuthError)
  if (issue) {
    return {
      title: '画面未连接',
      body: `${issue}。可以再试一次，或到浏览器页查看这次准备的详情。`,
    }
  }
  return {
    title: '画面未连接',
    body: '受管画面连的是目标账号会话，不是试跑录像。若需验证场景执行，直接点击顶部「试跑」即可自动启动执行，无需预先连接会话。',
  }
}

export type SessionPreparationStageKey = 'queued' | 'launching' | 'authenticating' | 'ready'

export interface SessionPreparationStep {
  key: SessionPreparationStageKey
  title: string
  description: string
}

export const PREPARATION_STEPS: SessionPreparationStep[] = [
  { key: 'queued', title: '排队调度', description: '等待可用执行节点' },
  { key: 'launching', title: '启动环境', description: '启动受管浏览器' },
  { key: 'authenticating', title: '自动登录', description: '提交凭据核验登录态' },
  { key: 'ready', title: '会话就绪', description: '受管画面就绪' },
]

export interface SessionPreparationStageInfo {
  currentStage: SessionPreparationStageKey
  stageBadge: string
  stepIndex: number
  failedStepIndex?: number | null
  title: string
  detail: string
  statusTone: 'info' | 'warning' | 'success' | 'error'
}

export function deriveSessionPreparationStage(input: {
  operationStatus?: string | null
  events?: Array<{ type: string; payload?: Record<string, unknown>; operationId?: string | null }>
  sessionOpen?: boolean
  lastAuthError?: string | null
  errorCode?: string | null
  prepareFailed?: boolean
  errorMessage?: string | null
}): SessionPreparationStageInfo {
  if (input.sessionOpen) {
    return {
      currentStage: 'ready',
      stageBadge: '已就绪',
      stepIndex: 3,
      failedStepIndex: null,
      title: '会话已就绪',
      detail: '受管浏览器画面已建立连接',
      statusTone: 'success',
    }
  }

  const events = input.events ?? []
  const hasLanding = events.some((e) => e.type === 'auth.landing_settled')
  const hasAttempt = events.some((e) => e.type === 'auth.attempt_started')
  const hasSignal = events.some((e) => e.type === 'auth.signal_observed')
  const hasClaimed = events.some((e) => e.type === 'operation.claimed')

  const status = input.operationStatus
  if (status === 'QUEUED') {
    return {
      currentStage: 'queued',
      stageBadge: '排队中',
      stepIndex: 0,
      failedStepIndex: null,
      title: '排队等待调度',
      detail: '已受理准备请求，正在等待空闲执行节点认领…',
      statusTone: 'info',
    }
  }

  if (status === 'WAITING_FOR_AUTH') {
    const reason = describeAuthIssue(input.lastAuthError)
    return {
      currentStage: 'authenticating',
      stageBadge: '等待验证',
      stepIndex: 2,
      failedStepIndex: null,
      title: '等待人工完成验证',
      detail: reason ? `目标系统需要人工干预（${reason}）` : '需要完成滑块或短信/扫码验证',
      statusTone: 'warning',
    }
  }

  if (input.prepareFailed || status === 'FAILED' || status === 'CANCELLED') {
    const isCancelled = status === 'CANCELLED'
    const code = input.errorCode ?? input.lastAuthError
    const reason = describeAuthIssue(code)
    const errorDetail = input.errorMessage
      ? input.errorMessage
      : reason
        ? code && code !== reason
          ? `${reason}（${code}）`
          : reason
        : code
          ? `未能成功建立受管浏览器会话（${code}）`
          : '未能成功建立受管浏览器会话'

    // 根据历史事件与错误发生点准确推导失败发生在哪个阶段
    let failedIndex = 1
    let stageKey: SessionPreparationStageKey = 'launching'
    if (input.errorMessage && !status) {
      // 接口层发起失败（例如网络异常或 409 冲突），属于调度发起阶段失败
      failedIndex = 0
      stageKey = 'queued'
    } else if (hasAttempt || hasLanding || hasSignal) {
      failedIndex = 2
      stageKey = 'authenticating'
    } else if (!hasClaimed && status === 'FAILED' && code === 'OPERATION_QUEUE_EXPIRED') {
      failedIndex = 0
      stageKey = 'queued'
    }

    return {
      currentStage: stageKey,
      stageBadge: isCancelled ? '准备已取消' : '准备失败',
      stepIndex: failedIndex,
      failedStepIndex: failedIndex,
      title: isCancelled ? '准备已取消' : '会话准备失败',
      detail: errorDetail,
      statusTone: isCancelled ? 'warning' : 'error',
    }
  }

  if (status === 'RUNNING') {
    if (hasLanding) {
      return {
        currentStage: 'authenticating',
        stageBadge: '登录中',
        stepIndex: 2,
        failedStepIndex: null,
        title: '正在整理落地页',
        detail: '登录已通过，正在整理目标系统初始弹窗与浮层…',
        statusTone: 'info',
      }
    }

    if (hasAttempt) {
      return {
        currentStage: 'authenticating',
        stageBadge: '登录中',
        stepIndex: 2,
        failedStepIndex: null,
        title: '正在尝试自动登录',
        detail: '正在向目标系统提交凭据并核验登录态…',
        statusTone: 'info',
      }
    }

    if (hasSignal) {
      return {
        currentStage: 'authenticating',
        stageBadge: '登录中',
        stepIndex: 2,
        failedStepIndex: null,
        title: '已到达登录页面',
        detail: '正在探测登录表单控件…',
        statusTone: 'info',
      }
    }

    return {
      currentStage: 'launching',
      stageBadge: '启动中',
      stepIndex: 1,
      failedStepIndex: null,
      title: '正在启动受管浏览器',
      detail: '执行节点正在拉起 Chromium 实例并载入目标站点…',
      statusTone: 'info',
    }
  }

  return {
    currentStage: 'launching',
    stageBadge: '准备中',
    stepIndex: 1,
    failedStepIndex: null,
    title: '正在准备受管会话',
    detail: '正在打开受管浏览器并尝试登录。目标系统打不开时会马上结束，不会空等。',
    statusTone: 'info',
  }
}

export function resolveLatestEventSummary(
  events?: Array<{ type: string; payload?: Record<string, unknown>; operationId?: string | null }>,
  currentOperationId?: string | null,
): string | null {
  if (!events || events.length === 0) return null
  const filtered = currentOperationId
    ? events.filter((e) => !e.operationId || e.operationId === currentOperationId)
    : events
  const latest = filtered[0]
  if (!latest) return null

  switch (latest.type) {
    case 'auth.attempt_started':
      return '开始尝试自动登录'
    case 'auth.signal_observed': {
      const kind = latest.payload?.kind
      if (kind === 'navigated_to_login') return '浏览器已导航至登录页面'
      if (kind === 'login_form_visible') return '已检测到登录表单输入框'
      return '已捕获登录页面信号'
    }
    case 'auth.landing_settled':
      return latest.payload?.residualOverlay ? '落地页整理完成（仍有非阻塞层）' : '已进入系统，完成落地页整理'
    case 'auth.verified':
      return '目标系统登录态核验通过'
    case 'operation.waiting_for_auth':
      return '需要人工介入完成人机验证'
    case 'operation.claimed':
      return '执行节点已认领任务，正在拉起浏览器'
    case 'operation.requested':
      return '会话准备任务已提交'
    case 'operation.finished': {
      const status = latest.payload?.status
      const errorCode = typeof latest.payload?.errorCode === 'string' ? latest.payload.errorCode : null
      if (status === 'FAILED') {
        const issue = describeAuthIssue(errorCode)
        return issue ? `会话准备失败：${issue}` : '会话准备任务执行失败'
      }
      if (status === 'CANCELLED') {
        return '会话准备任务已取消'
      }
      return '会话准备任务已执行完成'
    }
    default:
      return null
  }
}

export interface OperationTimeoutInfo {
  type: 'queue' | 'running' | 'auth_wait' | 'unknown'
  remainingSeconds: number | null
  elapsedSeconds: number
  hint: string
}

export function formatOperationTimeout(input: {
  status?: string | null
  queueDeadlineAt?: string | null
  createdAt?: string | null
  nowMs?: number
  defaultLoginTimeoutSeconds?: number
  authWaitSeconds?: number
}): OperationTimeoutInfo {
  const now = input.nowMs ?? Date.now()
  const createdRaw = input.createdAt ? new Date(input.createdAt).getTime() : now
  const created = Number.isFinite(createdRaw) ? createdRaw : now
  const elapsed = Math.max(0, Math.floor((now - created) / 1000))

  if (input.status === 'FAILED') {
    return {
      type: 'unknown',
      remainingSeconds: null,
      elapsedSeconds: elapsed,
      hint: elapsed > 0 ? `任务已终止（耗时 ${elapsed} 秒）` : '任务已终止',
    }
  }

  if (input.status === 'CANCELLED') {
    return {
      type: 'unknown',
      remainingSeconds: null,
      elapsedSeconds: elapsed,
      hint: '准备已由用户取消',
    }
  }

  if (input.status === 'QUEUED') {
    if (input.queueDeadlineAt) {
      const deadline = new Date(input.queueDeadlineAt).getTime()
      const remaining = Math.max(0, Math.floor((deadline - now) / 1000))
      const min = Math.floor(remaining / 60)
      const sec = remaining % 60
      const timeStr = min > 0 ? `${min}分${sec > 0 ? `${sec}秒` : ''}` : `${sec}秒`
      return {
        type: 'queue',
        remainingSeconds: remaining,
        elapsedSeconds: elapsed,
        hint: remaining > 0 ? `排队调度中，最长等待约 ${timeStr}` : '排队已超时，系统即将重试或结束',
      }
    }
    return {
      type: 'queue',
      remainingSeconds: null,
      elapsedSeconds: elapsed,
      hint: '正在等待执行节点调度…',
    }
  }

  if (input.status === 'WAITING_FOR_AUTH') {
    const total = input.authWaitSeconds ?? 600
    const remaining = Math.max(0, total - elapsed)
    const min = Math.floor(remaining / 60)
    const sec = remaining % 60
    return {
      type: 'auth_wait',
      remainingSeconds: remaining,
      elapsedSeconds: elapsed,
      hint: `人工验证等待中，有效剩余时间 ${min}分${sec}秒`,
    }
  }

  if (input.status === 'RUNNING') {
    const limit = input.defaultLoginTimeoutSeconds ?? 60
    const remaining = Math.max(0, limit - elapsed)
    return {
      type: 'running',
      remainingSeconds: remaining,
      elapsedSeconds: elapsed,
      hint: elapsed < 30 ? `环境准备通常需 10~30 秒（超时上限 ${limit} 秒）` : `已耗时 ${elapsed} 秒，超时上限 ${limit} 秒`,
    }
  }

  return {
    type: 'unknown',
    remainingSeconds: null,
    elapsedSeconds: elapsed,
    hint: '环境准备中…',
  }
}

export type StudioConnectActionKind = 'PREPARE' | 'LOGIN' | 'RESTART'

export interface StudioConnectAction {
  kind: StudioConnectActionKind
  label: string
  reason?: string
}

export function resolveStudioConnectAction(input: {
  sessionDetail?: AccountSessionDetail | null
  activeOpStatus?: string | null
  activeOpErrorCode?: string | null
  isFailed?: boolean
}): StudioConnectAction {
  const detail = input.sessionDetail
  const live = detail?.session
  const status = detail?.status
  const isFailed = input.isFailed || input.activeOpStatus === 'FAILED'
  const errorCode = input.activeOpErrorCode ?? detail?.lastAuthError

  // 1. 若未失败且无活会话或未准备或已关闭 -> PREPARE
  if (!isFailed && (!live || status === 'unprepared' || live?.status === 'CLOSED')) {
    return { kind: 'PREPARE', label: '连接会话' }
  }

  // 2. 若失败且存在严重的冲突或代次变动 -> 强制 RESTART 避开死锁
  if (
    isFailed &&
    (errorCode === 'SESSION_OPERATION_CONFLICT' ||
      errorCode === 'OPERATION_QUEUE_EXPIRED' ||
      errorCode === 'SESSION_GENERATION_CHANGED' ||
      status === 'lost')
  ) {
    return { kind: 'RESTART', label: '重建会话', reason: '底层会话状态异常，执行清理并重新启动' }
  }

  // 3. 若有存活实例但未登录 (needs_login / needs_check / identity_mismatch)
  if (
    live?.status === 'OPEN' &&
    (status === 'needs_login' || status === 'needs_check' || status === 'identity_mismatch')
  ) {
    return { kind: 'LOGIN', label: '登录会话', reason: '在已有浏览器实例中重新登录' }
  }

  // 4. 若已有就绪实例且未失败
  if (!isFailed && live?.status === 'OPEN' && status === 'ready') {
    return { kind: 'PREPARE', label: '连接会话' }
  }

  // 5. 其它连续失败或挂起状态 -> RESTART 自愈
  if (isFailed) {
    return { kind: 'RESTART', label: '再试一次', reason: '重置并重新建立会话' }
  }

  return { kind: 'PREPARE', label: '连接会话' }
}

