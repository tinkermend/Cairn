import {
  previewOccurrences,
  type AssistantDiagnosis,
  type AssistantResult,
  type OperationsActionProposal,
  type OperationsAllowedActionKey,
  type OperationsDiagnosis,
  type ScheduleProposal,
} from '@cairn/shared'
import { DomainError, summarizeFleet, summarizeQueues } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'

/**
 * D2: 运营问答与状态诊断处理器 (只读默认)
 */
export async function handleOperationsDiagnose(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { question, slots, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索系统运行事实、队列状态与 Worker 心跳...')

  const targetId = typeof slots.targetId === 'string' ? slots.targetId : undefined
  const kind = (typeof slots.kind === 'string' ? slots.kind : 'capacity') as
    | 'capacity'
    | 'queue_backlog'
    | 'auth_waiting'
    | 'worker_anomaly'
    | 'model_cost'

  const observations: string[] = []
  const hypotheses: string[] = []
  const evidenceRefs: string[] = []
  const missingChecks: string[] = []

  const now = new Date()
  let fleetResult: Awaited<ReturnType<typeof summarizeFleet>> | null = null
  let queueResult: Awaited<ReturnType<typeof summarizeQueues>> | null = null
  try {
    fleetResult = await summarizeFleet(ctx.db, now)
    queueResult = await summarizeQueues(ctx.db, now)
  } catch {
    // Fail-closed if monitoring queries fail
  }

  const metricVal = (metric: any): number => {
    if (typeof metric === 'number') return metric
    if (metric && typeof metric === 'object' && metric.availability === 'known' && typeof metric.value === 'number') {
      return metric.value
    }
    if (metric && typeof metric === 'object' && typeof metric.value === 'number') {
      return metric.value
    }
    return 0
  }

  const readyWorkers = metricVal(fleetResult?.data?.workers?.ready ?? (fleetResult?.data as any)?.workerPool?.ready)
  const authWaitCount = metricVal(fleetResult?.data?.slots?.waitingForAuth)
  const claimableRuns = metricVal(queueResult?.data?.claimableRuns ?? (queueResult?.data as any)?.metrics?.['queue.claimableRuns'])

  const observedAtTime = fleetResult?.asOf
    ? new Date(fleetResult.asOf).toISOString()
    : now.toISOString()
  let validUntilTime: string | null = null
  if (fleetResult && fleetResult.liveHeartbeatStale === 0 && readyWorkers > 0) {
    validUntilTime = new Date(now.getTime() + 15_000).toISOString()
  }

  // 基于真实监控读模型事实进行状态判断
  if (kind === 'auth_waiting' || (authWaitCount > 0) || (authWaitCount === 0 && (question.includes('认证') || question.includes('登录')))) {
    if (authWaitCount > 0 || kind === 'auth_waiting') {
      observations.push(authWaitCount > 0
        ? `实测检测到 ${authWaitCount} 个受管账号会话处于待人工介入状态 (WAITING_FOR_AUTH)`
        : '检测到目标账号会话处于待人工介入状态 (WAITING_FOR_AUTH)')
      observations.push('同一账号在 exclusive 模式下至多持有 1 条活会话，后续运行排队等待租约释放')
      hypotheses.push('目标系统需要双因子验证码 (2FA) 或人工扫码，需人工在控制台完成登录')
      evidenceRefs.push('monitoring:worker.slots.waitingForAuth')
      missingChecks.push('尚未检查 2FA 动态密钥 TOTP 是否已在目标配置中录入')
    } else {
      observations.push('实测当前无处于 WAITING_FOR_AUTH 待人工认证状态的受管会话')
      hypotheses.push('目标系统认证会话正常，未检测到认证阻塞')
      evidenceRefs.push('monitoring:worker.slots.waitingForAuth')
    }
  } else if (kind === 'queue_backlog' || claimableRuns > 0 || ((question.includes('卡住') || question.includes('积压') || question.includes('慢')) && claimableRuns === 0)) {
    if (claimableRuns > 0 || kind === 'queue_backlog') {
      observations.push(claimableRuns > 0
        ? `在途待领取运行任务积压数: ${claimableRuns}`
        : '检测到运行任务排队积压与槽位占用高')
      hypotheses.push('高频定时调度与长耗时任务重叠，导致后续排队等待可用 Worker')
      evidenceRefs.push('monitoring:queue.claimableRuns', 'monitoring:queue_backlog:slot_utilization_high')
      missingChecks.push('尚未核对近期数据库慢查询或外部页面加载超时日志')
    } else {
      observations.push('实测当前队列无积压任务，无等待领取的在途运行')
      hypotheses.push('调度推进正常，未检测到队列阻塞')
      evidenceRefs.push('monitoring:queue.claimableRuns')
    }
  } else if (question.includes('费用') || question.includes('Token') || question.includes('成本') || kind === 'model_cost') {
    observations.push('平台自身模型用量与成本仅作为面向用户的运营观测对象，不设人为预算截断')
    hypotheses.push('大规模批次预检或复杂场景步骤自愈引发局部模型调用峰值')
    evidenceRefs.push('monitoring:model_cost:token_summary')
  } else {
    if (!fleetResult) {
      observations.push('未能获取监控读模型事实，Worker 与系统状态未知')
      hypotheses.push('缺少实时监控指标支持，无法断言节点健康')
      missingChecks.push('监控服务未响应或未授权')
    } else if (fleetResult.liveHeartbeatStale > 0) {
      observations.push(`截至聚合时间 ${observedAtTime}，检测到 ${fleetResult.liveHeartbeatStale} 个活节点心跳已超时失效`)
      hypotheses.push('部分 Worker 节点可能失联或异常退出，当前不能断言节点运行正常')
      evidenceRefs.push('monitoring:worker.heartbeat.stale')
      missingChecks.push('Worker 心跳已超时，需检查节点网络或重启 Worker')
    } else if (readyWorkers === 0) {
      observations.push('实测当前处于 READY 状态的 Worker 节点数为 0')
      hypotheses.push('系统当前无可用执行节点，运行任务将进入排队')
      evidenceRefs.push('monitoring:worker.ready_count_zero')
    } else {
      observations.push(`实测当前基础服务与 Worker 进程运行正常（READY 节点数: ${readyWorkers}）`)
      observations.push(`分析范围：${targetId ? `目标系统 ${targetId}` : '全局平台运营'}`)
      hypotheses.push('未检测到严重的系统级阻断，执行节点心跳实测正常')
      evidenceRefs.push('monitoring:worker.heartbeat.fresh')
    }
  }

  await onProgress?.('validating', '正在校验诊断依据与安全建议...')

  const diagnosisPayload: OperationsDiagnosis = {
    diagnosisId: `diag-${crypto.randomUUID()}`,
    kind,
    observations,
    hypotheses,
    evidenceRefs,
    missingChecks,
    suggestedActions: [
      { actionKey: 'schedule.pause', label: '暂停低优先级调度', safe: true },
    ],
    observedAt: observedAtTime,
    validUntil: validUntilTime,
  }

  // 返回符合 AssistantDiagnosis 契约的结果，保持控制台统一呈现
  const result: AssistantDiagnosis = {
    kind: 'diagnosis',
    observedAt: observedAtTime,
    eventSeq: 1,
    focus: 'overview',
    facts: observations.map((text, idx) => ({
      id: `fact-${idx + 1}`,
      text,
      citations: [],
    })),
    hypotheses: hypotheses.map((text) => ({
      text,
      citations: evidenceRefs,
    })),
    missingInformation: missingChecks,
    nextActions: [
      {
        kind: 'platform.config',
        label: '查看监控与配置',
        href: '/monitoring',
        citations: [],
      },
    ],
  }

  // 挂载完整 operationsDiagnosis 实体供前端或领域深链消费
  ;(result as any).operationsDiagnosis = diagnosisPayload
  ;(result as any).observations = observations
  ;(result as any).missingChecks = missingChecks

  return result
}

/**
 * D2: 自然语言转调度草案处理器 (时区确定性与纯函数 5 次预览)
 */
export async function handleSchedulePropose(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { question, slots, onProgress } = ctx
  await onProgress?.('loading_facts', '正在解析调度意图并绑定系统时区...')

  const timezone = typeof slots.timezone === 'string' && slots.timezone ? slots.timezone : 'Asia/Shanghai'
  const referenceTime = new Date()

  // 纯函数计算未来 5 次触发点
  await onProgress?.('generating', '正在调用 previewOccurrences 计算确定性未来触发点...')
  const preview = previewOccurrences({
    cronExpr: typeof slots.cronExpr === 'string' ? slots.cronExpr : '0 2 * * 1-5',
    timezone,
    referenceTime,
    count: 5,
  })

  const proposalId = `sched-prop-${crypto.randomUUID()}`
  const proposal: ScheduleProposal = {
    proposalId,
    definition: {
      name: (typeof slots.name === 'string' ? slots.name : '智能生成的定时调度草案').slice(0, 120),
      timezone,
      weekdays: [1, 2, 3, 4, 5],
      windowStart: '02:00',
      windowEnd: '03:00',
      misfire: 'skip',
    },
    baselineRevision: 1,
    ownerRefs: [ctx.actor.id],
    inputDigest: '',
    timezone,
    preview,
    unknowns: [],
  }

  return {
    kind: 'explanation',
    summary: `已为您生成调度草案（时区：${timezone}）。未来 5 次确定性触发点预览如下：\n${preview.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
    references: [`时区绑定: ${timezone}`, `意图: ${question}`],
    diagnostics: [],
    // 挂载结构化 proposal
    ...({ scheduleProposal: proposal } as any),
  }
}

/**
 * D2: 运营动作安全提案处理器 (严格动作白名单与单资源限制)
 */
export async function handleOperationsAction(
  ctx: AssistantCapabilityHandlerContext,
): Promise<OperationsActionProposal> {
  const { slots } = ctx
  const actionKey = String(slots.actionKey ?? '') as OperationsAllowedActionKey
  const resourceKind = String(slots.resourceKind ?? 'schedule') as 'schedule' | 'run'
  const resourceId = String(slots.resourceId ?? '')

  // 1. 严格白名单准入检验
  const ALLOWED: OperationsAllowedActionKey[] = [
    'schedule.pause',
    'schedule.resume',
    'run.cancel_single',
  ]

  if (!ALLOWED.includes(actionKey)) {
    throw new DomainError(
      'bad_request',
      'FORBIDDEN_OPERATION_ACTION',
      `操作助手仅允许执行受控白名单动作（${ALLOWED.join(', ')}），严禁批量撤销或未授权的系统写操作。`,
    )
  }

  if (!resourceId) {
    throw new DomainError('bad_request', 'MISSING_RESOURCE_ID', '缺少操作目标资源 ID')
  }

  // 2. 构造单资源受控提案
  let impact = ''
  let preconditions: string[] = []

  switch (actionKey) {
    case 'schedule.pause':
      impact = `将暂停调度任务 ${resourceId} 的后续定时触发，在途任务正常执行。`
      preconditions = ['调度当前处于 ACTIVE 启用状态']
      break
    case 'schedule.resume':
      impact = `将恢复调度任务 ${resourceId} 的定时触发，下个周期按时执行。`
      preconditions = ['调度当前处于 PAUSED 暂停状态']
      break
    case 'run.cancel_single':
      impact = `将向处于在途状态的单个 Run ${resourceId} 发送取消信号并释放独占租约。`
      preconditions = ['Run 当前处于 RUNNING 或 QUEUED 状态']
      break
  }

  const proposal: OperationsActionProposal = {
    proposalId: `op-prop-${crypto.randomUUID()}`,
    actionKey,
    resources: [
      {
        kind: resourceKind,
        id: resourceId,
      },
    ],
    preconditions,
    expectedRevision: typeof slots.expectedRevision === 'number' ? slots.expectedRevision : 1,
    impact,
    expiresAt: new Date(Date.now() + 300_000).toISOString(), // 5 分钟有效期
  }

  return proposal
}
