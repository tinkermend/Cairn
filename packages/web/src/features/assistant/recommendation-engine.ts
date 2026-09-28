import {
  TARGET_CONFIG_FORM_ID,
  normalizeAssistantPageContext,
  type AssistantCapabilitiesResponse,
  type AssistantCapabilityId,
  type AssistantPageContext,
} from '@cairn/shared'
import type { AssistantBoundContext } from '@/stores/assistant-store'

export interface AssistantRecommendationChip {
  id: string
  label: string
  question: string
  capabilityHint?: AssistantCapabilityId
  badge?: string
  priority: number
}

export function resolveContextRecommendations(params: {
  boundContext: AssistantBoundContext | null
  pageContext: AssistantPageContext | null
  capabilities: AssistantCapabilitiesResponse | null
  permissions: {
    canAssist: boolean
    canWrite: boolean
    canReadTarget: boolean
    canReadSession?: boolean
    canReadSchedule?: boolean
    canReadRun?: boolean
  }
}): AssistantRecommendationChip[] {
  // 1. 若全局未启用 AI 助手能力或缺少 ai:assist 权限，返回空列表
  if (!params.capabilities?.modelEnabled || !params.permissions.canAssist) {
    return []
  }

  const availableIds = new Set(
    params.capabilities.items.filter((item) => item.available).map((item) => item.id),
  )

  const bound = params.boundContext
  const pageContext = normalizeAssistantPageContext(params.pageContext)
  const page = bound?.page ?? pageContext?.page
  const selectedStepId = bound?.selectedStepId ?? pageContext?.stepId
  const runId =
    bound?.runId ??
    pageContext?.runId ??
    (bound?.page === 'run' ? bound?.entityId : undefined)
  const targetId =
    bound?.targetId ??
    bound?.entityId ??
    pageContext?.targetId
  const scheduleId =
    (bound?.page === 'schedule' ? bound.entityId : undefined) ??
    (pageContext?.primaryRef?.kind === 'schedule' ? pageContext.primaryRef.id : undefined)
  const rawChips: AssistantRecommendationChip[] = []

  // 2. 根据 boundContext / pageContext 匹配当前场景规则
  if (bound?.activeForm?.formId === TARGET_CONFIG_FORM_ID) {
    if (params.permissions.canWrite) {
      rawChips.push({
        id: 'target-form-timeout-propose',
        label: '⏱️ 将登录等待设为30秒',
        question: '帮我把这个目标系统的提交后等待离开登录页超时改成30秒。',
        capabilityHint: 'target.propose-form',
        priority: 110,
      })
      rawChips.push({
        id: 'target-form-settle-propose',
        label: '🧹 开启自动整理欢迎层',
        question: '帮我将登录后整理模式设为按平台整理，并将整理预算设为15秒。',
        capabilityHint: 'target.propose-form',
        priority: 108,
      })
    }
    rawChips.push({
      id: 'target-form-timeout-help',
      label: '⏱️ 登录超时不填会怎样',
      question: '登录页停留超时不填会怎样？',
      capabilityHint: 'knowledge.answer',
      priority: 105,
    })
    rawChips.push({
      id: 'target-form-settle-help',
      label: '🧹 登录后整理规则',
      question: '目标配置里的「登录后整理」和「整理预算」是什么作用？',
      capabilityHint: 'knowledge.answer',
      priority: 95,
    })
    rawChips.push({
      id: 'target-form-rules-help',
      label: '📝 目标编码与命名规则',
      question: '目标系统的系统名称与系统编码命名有什么格式要求？',
      capabilityHint: 'knowledge.answer',
      priority: 90,
    })
  } else if (page === 'studio') {
    if (selectedStepId) {
      // 场景单步聚焦 (Studio Step Focused)
      rawChips.push({
        id: 'studio-step-propose',
        label: '✏️ 修改建议',
        question: '请对当前选中的步骤给出编写与配置优化建议。',
        capabilityHint: 'scenario.propose-step',
        priority: 110,
      })
      rawChips.push({
        id: 'studio-step-explain',
        label: '📖 解释此步骤',
        question: '请解释当前步骤在整套业务流程中的具体作用及上下文依赖。',
        capabilityHint: 'scenario.explain',
        priority: 100,
      })
      if (bound?.hasCssSelector) {
        rawChips.push({
          id: 'studio-step-selector',
          label: '🎯 诊断选择器稳定性',
          question: '请分析当前步骤选择器的健壮性并提供加固候选。',
          capabilityHint: 'scenario.propose-step',
          priority: 85,
        })
      }
      rawChips.push({
        id: 'studio-step-assert',
        label: '🛡️ 补充断言',
        question: '根据当前步骤的操作目标，建议在此处补充哪些验证断言？',
        capabilityHint: 'scenario.propose-step',
        priority: 80,
      })
    } else {
      // 场景全局 (Studio Global)
      rawChips.push({
        id: 'studio-scenario-explain',
        label: '💡 解释场景全貌',
        question: '请解释当前场景的业务流程、步骤时序与全局契约。',
        capabilityHint: 'scenario.explain',
        priority: 100,
      })
      rawChips.push({
        id: 'studio-scenario-inspect',
        label: '🔍 检查逻辑完整性',
        question: '请检查当前场景的步骤依赖、变量传递与潜在逻辑缺漏。',
        capabilityHint: 'scenario.explain',
        priority: 90,
      })
      if (params.permissions.canReadRun) {
        rawChips.push({
          id: 'studio-scenario-failure-history',
          label: '📉 这个场景最近为什么老失败',
          question: '请帮我分析当前场景最近 7 天内的失败运行记录，归纳主要失败原因。',
          capabilityHint: 'knowledge.answer',
          priority: 85,
        })
      }
      rawChips.push({
        id: 'studio-scenario-branch',
        label: '➕ 建议测试分支',
        question: '基于此场景的业务目标，有哪些常见的异常分支或校验需要补充？',
        capabilityHint: 'knowledge.answer',
        priority: 70,
      })
    }

  } else if (page === 'run' && runId) {
    const isError = bound?.statusTone === 'error'

    if (isError) {
      // 运行失败复盘
      if (selectedStepId && bound?.selectedStepFailed) {
        rawChips.push({
          id: 'run-step-diagnose',
          label: '🔎 排查当前步骤报错',
          question: '当前步骤记录了什么错误？我应该先核对哪份运行证据？',
          capabilityHint: 'run.diagnose',
          priority: 115,
        })
      }
      rawChips.push({
        id: 'run-diagnose-rca',
        label: '🚨 排查本次失败',
        question: '这次运行哪里失败？请根据已记录的步骤和错误信息说明先核对什么；证据不足时请指出缺口。',
        capabilityHint: 'run.diagnose',
        priority: 110,
      })
      rawChips.push({
        id: 'run-compare',
        label: '🔄 对比上一次运行',
        question: '这次运行和上一次相比有什么变化？',
        capabilityHint: 'run.compare',
        priority: 90,
      })
    } else {
      // 运行成功 / 正常状态
      rawChips.push({
        id: 'run-perf-bottleneck',
        label: '⏱️ 分析耗时瓶颈',
        question: '请分析本次运行各步骤的耗时分布，并指出性能瓶颈。',
        capabilityHint: 'run.diagnose',
        priority: 80,
      })
    }
  } else if (page === 'run' && !runId && params.permissions.canReadRun) {
    // 运行列表页排查
    const filters = bound?.filters ?? pageContext?.view?.filters
    const status = filters?.status
    const showsFailures = status ? status === 'FAILED' : Boolean(bound?.listHasFailures)
    if (showsFailures) {
      rawChips.push({
        id: 'run-list-failure-digest',
        label: '🧩 这些失败是同一个原因吗',
        question: '请帮我分析当前筛选出的这些失败运行，它们是同一个原因导致的吗？',
        capabilityHint: 'knowledge.answer',
        priority: 85,
      })
    }
  } else if (page === 'session' && targetId && params.permissions.canReadTarget) {
    // 账号会话页面排查
    rawChips.push({
      id: 'session-auth-failure-reason',
      label: '🔑 为什么登录失效',
      question: '请帮我分析当前账号为什么登录失效，最近一次认证失败的原因是什么？',
      capabilityHint: 'knowledge.answer',
      priority: 92,
    })
    rawChips.push({
      id: 'session-occupied-by-whom',
      label: '🔒 会话被谁占用',
      question: '请检查当前会话被哪次运行或 Worker 占用，已经占用了多久？',
      capabilityHint: 'knowledge.answer',
      priority: 88,
    })
    rawChips.push({
      id: 'session-queue-waiting-reason',
      label: '⌛ 为什么开跑一直在等会话',
      question: '请分析为什么当前账号的运行在等待会话，是否存在租约占用、并发超限或等待认证？',
      capabilityHint: 'knowledge.answer',
      priority: 82,
    })
  } else if (page === 'target' && targetId && params.permissions.canReadTarget) {
    // 目标系统与凭据
    if (params.permissions.canReadSession) {
      rawChips.push({
        id: 'target-account-health',
        label: '🔑 检查账号健康度',
        question: '请检查该目标系统关联账号的认证健康状态与会话租约情况。',
        capabilityHint: 'knowledge.answer',
        priority: 90,
      })
    }
    rawChips.push({
      id: 'target-menu-map',
      label: '🗺️ 目标菜单地图覆盖',
      question: '请解释当前目标系统的一级菜单授权与只读地图覆盖情况。',
      capabilityHint: 'knowledge.answer',
      priority: 80,
    })
  } else if (page === 'schedule' && scheduleId && params.permissions.canReadSchedule) {
    // 调度聚焦 (Schedule Focused)
    rawChips.push({
      id: 'schedule-why-not-run',
      label: '⏱️ 为什么没按时运行',
      question: '请分析当前调度最近为什么没有按时运行，排查跳过原因与处理建议。',
      capabilityHint: 'knowledge.answer',
      priority: 90,
    })
    rawChips.push({
      id: 'schedule-recent-summary',
      label: '📋 最近触发情况汇总',
      question: '请汇总当前调度最近的触发记录、准入状态与跳过原因分布。',
      capabilityHint: 'knowledge.answer',
      priority: 80,
    })
  } else {
    // 全局上下文
    rawChips.push({
      id: 'global-authoring-guide',
      label: '🚀 快速上手编排',
      question: '在识途平台中，如何从零录制并编排一个新场景？',
      capabilityHint: 'platform.guide',
      priority: 90,
    })
    rawChips.push({
      id: 'global-abnormal-runs',
      label: '📊 查看近期异常运行',
      question: '在哪里快速筛选和排查近期失败的场景运行？',
      capabilityHint: 'platform.guide',
      priority: 80,
    })
    rawChips.push({
      id: 'global-feature-map',
      label: '📋 常用功能导航',
      question: '请列出我可以使用的主要功能入口。',
      capabilityHint: 'platform.guide',
      priority: 70,
    })
  }

  // 3. 过滤不可用能力、校验权限闸门，并按优先级降序取 Top 3
  return rawChips
    .filter((chip) => {
      // 校验能力是否在可用集合中
      if (chip.capabilityHint && !availableIds.has(chip.capabilityHint)) {
        return false
      }
      // 权限闸门：编排与配置提议类能力严格需要写权限
      if (
        (chip.capabilityHint === 'scenario.propose-step' || chip.capabilityHint === 'target.propose-form') &&
        !params.permissions.canWrite
      ) {
        return false
      }
      return true
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 3)
}
