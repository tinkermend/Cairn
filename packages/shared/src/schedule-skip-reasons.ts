import type { AssistantNextActionKind } from './assistant.js'
import type { ScheduleSkipReason } from './schedules.js'

export interface ScheduleSkipReasonActionMeta {
  kind: AssistantNextActionKind
  label: string
  pathTemplate: string
}

export interface ScheduleSkipReasonMeta {
  label: string
  explanation: string
  action?: ScheduleSkipReasonActionMeta
}

export const SCHEDULE_SKIP_REASON_METAS: Record<ScheduleSkipReason, ScheduleSkipReasonMeta> = {
  WINDOW_CLOSED: {
    label: '错过窗口',
    explanation: '当前触发时刻已超出预设的日历窗口范围，本次调度被安全跳过以避免非窗口期执行。',
  },
  DST_NONEXISTENT: {
    label: '夏令时不存在该本地时间',
    explanation: '夏令时切换导致本地时间在该时区内跳跃缺失，窗口规则无法解析。',
    action: {
      kind: 'schedule.edit',
      label: '修改窗口时间',
      pathTemplate: '/schedules',
    },
  },
  INVALID_RESOLVED_WINDOW: {
    label: '解析后的窗口无效',
    explanation: '时区或时间窗口计算得到的开始结束范围不合法，请检查时间规则配置。',
    action: {
      kind: 'schedule.edit',
      label: '检查调度规则',
      pathTemplate: '/schedules',
    },
  },
  FACTORY_DISABLED: {
    label: '平台尚未开放此类定时任务',
    explanation: '平台配置尚未开放此类定时任务的消费能力；请在平台配置中开放后再执行。',
    action: {
      kind: 'platform.config',
      label: '前往平台配置',
      pathTemplate: '/platform-config',
    },
  },
  SCHEDULE_DISABLED: {
    label: '计划已停用',
    explanation: '当前定时调度已处于停用状态，系统暂停了自动触发。',
    action: {
      kind: 'schedule.edit',
      label: '启用定时任务',
      pathTemplate: '/schedules',
    },
  },
  MANUAL_JOBS_DISABLED: {
    label: '该目标尚未开放手工作业',
    explanation: '所属目标系统配置尚未开放手工作业或定时调度作业。',
    action: {
      kind: 'target.detail',
      label: '检查目标配置',
      pathTemplate: '/targets/:targetId',
    },
  },
  AUTH_PREPARATION_REQUIRED: {
    label: '认证尚未准备',
    explanation: '执行目标系统需要有效的登录凭据或会话，当前账号尚未准备就绪或认证已过期。',
    action: {
      kind: 'target.accounts',
      label: '去认证账号',
      pathTemplate: '/sessions/:targetId',
    },
  },
  SAFETY_BASIS_REQUIRED: {
    label: '缺少安全进入依据',
    explanation: '目标系统缺少合规的安全准入配置或进入依据，调度已被系统阻断。',
    action: {
      kind: 'target.detail',
      label: '配置安全准入',
      pathTemplate: '/targets/:targetId',
    },
  },
  NO_ELIGIBLE_ASSETS: {
    label: '没有可纳入的资产',
    explanation: '目标系统中暂无可供纳入作业的有效页面或接口资产。',
    action: {
      kind: 'target.detail',
      label: '查看目标资产',
      pathTemplate: '/targets/:targetId',
    },
  },
  COVERED_BY_RUN: {
    label: '已被正式运行覆盖',
    explanation: '相同周期或业务范围内已有正式运行在执行，本次调度被并入已有运行以避免冗余。',
    action: {
      kind: 'run.detail',
      label: '查看对应运行',
      pathTemplate: '/runs/:runId',
    },
  },
  PERMISSION_REVOKED: {
    label: '授权已被收回',
    explanation: '调度关联的访问凭据或执行授权已被收回，无法继续访问目标。',
    action: {
      kind: 'target.accounts',
      label: '重新授权账号',
      pathTemplate: '/sessions/:targetId',
    },
  },
  MAP_ACCOUNT_USAGE_REQUIRED: {
    label: '账号已收回地图用途',
    explanation: '目标关联的账号未勾选或已收回地图采集用途，无法用于地图探索。',
    action: {
      kind: 'target.accounts',
      label: '配置账号用途',
      pathTemplate: '/sessions/:targetId',
    },
  },
  WORKER_UNAVAILABLE: {
    label: '没有可执行的节点',
    explanation: '集群中当前没有在线、健康的 Worker 节点可供承接调度任务。',
    action: {
      kind: 'worker.list',
      label: '查看节点状态',
      pathTemplate: '/workers',
    },
  },
  TARGET_PAUSED: {
    label: '目标已停用',
    explanation: '所属目标系统已被手动暂停或设为维护状态。',
    action: {
      kind: 'target.detail',
      label: '恢复目标服务',
      pathTemplate: '/targets/:targetId',
    },
  },
  ACTIVE_SLICE_EXISTS: {
    label: '同目标已有进行中的地图作业',
    explanation: '该目标系统当前已有正在运行的地图采集切片，同一目标禁止并发冲突作业。',
    action: {
      kind: 'target.detail',
      label: '查看地图作业',
      pathTemplate: '/targets/:targetId/map',
    },
  },
  OVERLAP_ACTIVE: {
    label: '同计划仍有未结束的执行',
    explanation: '本计划上一次触发创建的执行尚未结束，为防止重叠堆积跳过了本次触发。',
    action: {
      kind: 'schedule.edit',
      label: '查看调度状态',
      pathTemplate: '/schedules',
    },
  },
  NO_NEW_DATA: {
    label: '没有新的分析来源',
    explanation: '自上次执行以来，目标系统未产生新增的交互或快照数据，无需重复分析。',
  },
  COALESCED: {
    label: '已并入待执行请求',
    explanation: '本次触发请求已与队列中相同范围的待执行作业自动合并。',
  },
  START_DEADLINE_ELAPSED: {
    label: '超过最晚开始时间',
    explanation: '作业在排队等待执行时，已超过了配置的最晚开始死线（Deadline）。',
    action: {
      kind: 'schedule.edit',
      label: '调整死线时间',
      pathTemplate: '/schedules',
    },
  },
  RESOURCE_UNAVAILABLE: {
    label: '资源不可用',
    explanation: '执行调度所需的运行环境、容器或依赖资源暂时不可用。',
    action: {
      kind: 'worker.list',
      label: '检查运行节点',
      pathTemplate: '/workers',
    },
  },
  INPUT_MISSING: {
    label: '输入不完整',
    explanation: '执行所需的输入参数、数据集或场景参数未完整指定。',
    action: {
      kind: 'schedule.edit',
      label: '补全输入配置',
      pathTemplate: '/schedules',
    },
  },
  VERSION_INVALID: {
    label: '版本无效',
    explanation: '调度关联的场景版本或测试集版本已失效、已被删除或未发布。',
    action: {
      kind: 'schedule.edit',
      label: '更新关联版本',
      pathTemplate: '/schedules',
    },
  },
  ACCOUNT_UNAVAILABLE: {
    label: '账号不可用',
    explanation: '执行所需的专属账号处于不可用状态（会话失效、账号锁定或异常退出）。',
    action: {
      kind: 'target.accounts',
      label: '排查账号会话',
      pathTemplate: '/sessions/:targetId',
    },
  },
  ANALYSIS_BUDGET_EXHAUSTED: {
    label: '分析预算已用尽',
    explanation: '本周期内分配的分析预算（如模型 Token 预算或分析次数）已用尽。',
    action: {
      kind: 'schedule.edit',
      label: '调整分析预算',
      pathTemplate: '/schedules',
    },
  },
  ANALYSIS_CONFIG_INVALID: {
    label: '分析配置无效',
    explanation: '知识分析消费者的参数配置不符合规范，无法启动分析。',
    action: {
      kind: 'schedule.edit',
      label: '修复分析配置',
      pathTemplate: '/schedules',
    },
  },
  DUPLICATE_ANALYSIS_SCOPE: {
    label: '同范围已有分析计划',
    explanation: '相同目标和分析范围已有正在执行或已计划的分析任务。',
    action: {
      kind: 'schedule.edit',
      label: '查看分析计划',
      pathTemplate: '/schedules',
    },
  },
  NO_ENABLED_ENTRIES: {
    label: '没有已启用的采集入口',
    explanation: '尚未为目标系统启用任何采集入口；请先为目标系统启用至少一个入口。',
    action: {
      kind: 'target.detail',
      label: '启用采集入口',
      pathTemplate: '/targets/:targetId',
    },
  },
}

export interface ResolveSkipReasonParams {
  targetId?: string | null
  runId?: string | null
  scheduleId?: string | null
}

export function resolveSkipReasonAction(
  reason: ScheduleSkipReason,
  params?: ResolveSkipReasonParams,
): { kind: AssistantNextActionKind; label: string; href: string } | null {
  const meta = SCHEDULE_SKIP_REASON_METAS[reason]
  if (!meta?.action) return null

  let href = meta.action.pathTemplate
  if (href.includes(':targetId')) {
    if (!params?.targetId) return null
    href = href.replace(':targetId', params.targetId)
  }
  if (href.includes(':runId')) {
    if (!params?.runId) return null
    href = href.replace(':runId', params.runId)
  }
  if (href.includes(':scheduleId')) {
    if (!params?.scheduleId) return null
    href = href.replace(':scheduleId', params.scheduleId)
  }

  return {
    kind: meta.action.kind,
    label: meta.action.label,
    href,
  }
}
